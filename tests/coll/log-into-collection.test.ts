/**
 * UIL-048 — logging an owned card into a collection must never create a second physical copy.
 *
 * `logCardIntoCollection`'s old behaviour called `copyRepo.insert` unconditionally. Her report: a card
 * already shelved in the collection's own binder, logged again, became TWO copy rows — the Remove
 * button read "Remove 2" for a card she owns exactly one of. The assertion that matters is the raw
 * `copy` ROW COUNT for that catalog card after logging, not what the UI happens to render, per the
 * assignment: a UI-count assertion would pass against a fix that still doubles the row underneath.
 *
 * Real Postgres via PGlite (0001→0008 migrations, real RLS), same harness as the other `tests/coll/*`
 * suites, so `applyCollectionLog` runs through the real `collection`/`copy`/`placement_decision` tables.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyCollectionLog } from "@/lib/coll";
import {
  asOwner,
  asSuperuser,
  freshRpcDb,
  OWNER,
  seedBinders,
  seedCatalogCards,
  seedCollections,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const SPEC = "b0000000-0000-0000-0000-000000000011";
const GEN = "b0000000-0000-0000-0000-000000000012";
const COL = "a0000000-0000-0000-0000-000000000001";
const CA1 = "c0000000-0000-0000-0000-000000000a01";

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
});
afterEach(async () => {
  await db.close();
});

async function copyCountFor(tcgdexId: string): Promise<number> {
  await asSuperuser(db);
  const r = await db.query<{ n: number }>(
    `select count(*)::int as n from copy where catalog_card_id = $1`,
    [tcgdexId],
  );
  return r.rows[0].n;
}

async function targetsOf(id: string): Promise<string[]> {
  const rows = await db.query<{ t: string[] }>(
    `select target_catalog_card_ids t from collection where id = $1`,
    [id],
  );
  return rows.rows[0].t;
}

describe("applyCollectionLog", () => {
  it("is a no-op repeat when a copy is already shelved in the collection's own binder — her exact report", async () => {
    await seedCatalogCards(db, ["cardA"]);
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: ["cardA"], currentBinderIds: [SPEC] },
    ]);
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, role, binder_id)
        values ('${CA1}', '${OWNER}', 'cardA', 'shelved', '${SPEC}');
    `);
    expect(await copyCountFor("cardA")).toBe(1);

    await asOwner(db);
    const res = await applyCollectionLog(pgliteClient(db), OWNER, COL, "cardA");
    expect(res).toMatchObject({ ok: true, created: false, copyId: CA1 });

    // The row count for this catalog card must stay ONE — not two.
    expect(await copyCountFor("cardA")).toBe(1);
    expect(await targetsOf(COL)).toEqual(["cardA"]);
  });

  it("refuses when she owns a copy shelved in a DIFFERENT binder, naming it, and inserts nothing", async () => {
    await seedCatalogCards(db, ["cardA"]);
    await seedBinders(db, [
      { id: SPEC, type: "specialty", name: "Specialty A" },
      { id: GEN, type: "general", name: "Binder 1" },
    ]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
    ]);
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
        values ('${CA1}', '${OWNER}', 'cardA', 'shelved', '${GEN}', 'front', 'red');
    `);

    await asOwner(db);
    const res = await applyCollectionLog(pgliteClient(db), OWNER, COL, "cardA");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("Binder 1");
      expect(res.error).toContain("Front");
      expect(res.error).toMatch(/Move/);
    }

    expect(await copyCountFor("cardA")).toBe(1); // unchanged — no phantom second copy
    expect(await targetsOf(COL)).toEqual([]); // refusal touches nothing, not even the tag
  });

  it("refuses when she owns a copy in the bulk box", async () => {
    await seedCatalogCards(db, ["cardA"]);
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
    ]);
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, role)
        values ('${CA1}', '${OWNER}', 'cardA', 'bulk');
    `);

    await asOwner(db);
    const res = await applyCollectionLog(pgliteClient(db), OWNER, COL, "cardA");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("bulk box");
    expect(await copyCountFor("cardA")).toBe(1);
  });

  it("inserts a real copy when she owns none, exactly as before", async () => {
    await seedCatalogCards(db, ["cardA"]);
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
    ]);
    expect(await copyCountFor("cardA")).toBe(0);

    await asOwner(db);
    const res = await applyCollectionLog(pgliteClient(db), OWNER, COL, "cardA");
    expect(res).toMatchObject({ ok: true, created: true });

    expect(await copyCountFor("cardA")).toBe(1);
    expect(await targetsOf(COL)).toEqual(["cardA"]);

    await asSuperuser(db);
    const audit = await db.query<{ decision: string }>(`select decision from placement_decision`);
    expect(audit.rows).toEqual([{ decision: "collection-log" }]);
  });

  it("ignores a 'block' copy — it marks a slot no card can ever fill, not something she owns", async () => {
    await seedCatalogCards(db, ["cardA"]);
    await seedBinders(db, [
      { id: SPEC, type: "specialty", name: "Specialty A" },
      { id: GEN, type: "general", name: "Binder 1" },
    ]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
    ]);
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
        values ('${CA1}', '${OWNER}', 'cardA', 'block', '${GEN}', 'front', 'red');
    `);

    await asOwner(db);
    const res = await applyCollectionLog(pgliteClient(db), OWNER, COL, "cardA");
    expect(res).toMatchObject({ ok: true, created: true });
    expect(await copyCountFor("cardA")).toBe(2); // the block row, plus the new real copy
  });
});

describe("CONTROL — the pre-fix shape (insert unconditionally) doubles the row", () => {
  it("logging an already-shelved-here card the old way produces TWO rows for one catalog card", async () => {
    await seedCatalogCards(db, ["cardA"]);
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, role, binder_id)
        values ('${CA1}', '${OWNER}', 'cardA', 'shelved', '${SPEC}');
    `);
    expect(await copyCountFor("cardA")).toBe(1);

    // Exactly what the old logCardIntoCollection did: insert unconditionally.
    await db.query(
      `insert into copy (owner_id, catalog_card_id, role, binder_id) values ($1, $2, 'shelved', $3)`,
      [OWNER, "cardA", SPEC],
    );
    expect(await copyCountFor("cardA")).toBe(2); // the defect UIL-048 is about
  });
});
