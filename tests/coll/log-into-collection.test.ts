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
import type { DbClient, Row } from "@/lib/repo";
import {
  ALREADY_OWNED_IN_HAUL_MESSAGE,
  applyCollectionLog,
  describeExistingCopyLocation,
} from "@/lib/coll";
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

  it("refuses when the copy she owns is IN HER HAUL, and sends her to the Haul Plan not to Move", async () => {
    /**
     * UIL-093, a UIL-088 regression. `findExistingCopy` filtered `role === "shelved" || role === "bulk"`,
     * so an unplaced copy came back as `kind: "none"` and this path INSERTED A SECOND COPY of a card she
     * already owns — the exact duplicate the function exists to refuse, and the same class of double she
     * reported on the Haul Plan.
     *
     * The wording is its own sentence, not the "it's in <place>" one: a card in the haul is not anywhere,
     * so "Use Move to bring it here" would send her to the wrong screen for a card the app has never filed.
     */
    await seedCatalogCards(db, ["cardA"]);
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
    ]);
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, role)
        values ('${CA1}', '${OWNER}', 'cardA', 'haul');
    `);

    await asOwner(db);
    const res = await applyCollectionLog(pgliteClient(db), OWNER, COL, "cardA");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe(ALREADY_OWNED_IN_HAUL_MESSAGE);
      expect(res.error).toContain("waiting to be placed");
      expect(res.error).not.toMatch(/bulk box/); // it is NOT in the box; she never put it there
      expect(res.error).not.toMatch(/Move/);
    }
    expect(await copyCountFor("cardA")).toBe(1); // pre-fix: 2
    expect(await targetsOf(COL)).toEqual([]); // and the tag is untouched, like every other refusal
  });

  it("describeExistingCopyLocation never calls the haul the bulk box, for any caller", async () => {
    /**
     * `applyCollectionLog` answers the haul case before reaching this helper, so this branch has no
     * caller that can reach it today — a mutation removing it survives the suite through that path. It is
     * pinned directly instead, because the helper is EXPORTED: without the branch, the first future caller
     * gets "the bulk box" for a card she never put in a box, which is the whole class of false-placement
     * claim UIL-087, UIL-088 and this entry are about.
     */
    await seedCatalogCards(db, ["cardA"]);
    await asSuperuser(db);
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, role)
        values ('${CA1}', '${OWNER}', 'cardA', 'haul');
    `);
    const rows = await db.query<Row<"copy">>(`select * from copy where id = '${CA1}'`);
    await asOwner(db);
    const where = await describeExistingCopyLocation(pgliteClient(db), rows.rows[0]);
    expect(where).toBe("your haul, waiting to be placed");
    expect(where).not.toContain("bulk");
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

/**
 * UIL-033 — logging a card is ONE transaction through `apply_write_ops`, not three awaited writes with a
 * TypeScript read-modify-write on `target_catalog_card_ids` in the middle. The RPC's
 * `union_collection_targets` (0007) unions SERVER-SIDE in one statement, so two logs that interleave
 * compose instead of the second clobbering the first — the lost update the old shape had.
 */
describe("UIL-033 · logging is atomic and two concurrent logs both land", () => {
  it("two cards logged at the same time both end up on the target list (pre-fix: one is lost)", async () => {
    await seedCatalogCards(db, ["cardA", "cardB"]);
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
    ]);
    await asOwner(db);
    const client = pgliteClient(db);

    const [a, b] = await Promise.all([
      applyCollectionLog(client, OWNER, COL, "cardA"),
      applyCollectionLog(client, OWNER, COL, "cardB"),
    ]);
    expect(a).toMatchObject({ ok: true, created: true });
    expect(b).toMatchObject({ ok: true, created: true });

    await asSuperuser(db);
    expect((await targetsOf(COL)).sort()).toEqual(["cardA", "cardB"]);
    expect(await copyCountFor("cardA")).toBe(1);
    expect(await copyCountFor("cardB")).toBe(1);
  });

  it("copy, audit row and tag land together — or none of them do", async () => {
    await seedCatalogCards(db, ["cardA"]);
    // The collection points at a binder that does not exist: insert_copy's FK fails INSIDE the RPC, and
    // because the tag and the audit row are in the same call, nothing is left half-written. The old
    // shape inserted the copy first and would have thrown with a placed card on no list.
    const GHOST = "b0000000-0000-0000-0000-0000000000ff";
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: [], currentBinderIds: [GHOST] },
    ]);
    await asOwner(db);
    const res = await applyCollectionLog(pgliteClient(db), OWNER, COL, "cardA");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Could not log the card/);

    await asSuperuser(db);
    expect(await copyCountFor("cardA")).toBe(0);
    expect(await targetsOf(COL)).toEqual([]);
    const audit = await db.query<{ n: number }>(`select count(*)::int n from placement_decision`);
    expect(audit.rows[0].n).toBe(0);
  });

  it("a collection that vanishes between read and write is NAMED, not passed off as success", async () => {
    await seedCatalogCards(db, ["cardA"]);
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
    ]);
    await asOwner(db);
    // Sabotage as a side effect of the ownership read, i.e. after the collection was read and before the
    // write: the collection row goes away (hers, so RLS allows it). union_collection_targets then matches
    // no row and says nothing — the case that must not come back as { ok: true }.
    const raw = pgliteClient(db);
    let armed = true;
    const client = new Proxy(raw as object, {
      get(target, prop, receiver) {
        if (prop !== "from") return Reflect.get(target, prop, receiver);
        return (table: string) => {
          if (table === "copy" && armed) {
            armed = false;
            void db.query(`delete from collection where id = $1`, [COL]);
          }
          return (raw as unknown as { from: (t: string) => unknown }).from(table);
        };
      },
    }) as unknown as DbClient;
    const res = await applyCollectionLog(client, OWNER, COL, "cardA");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("changed under you");
      expect(res.error).toContain("move it from the binder view"); // the remedy, on screen
    }
    // Honest about the state: the copy IS shelved in the binder (it committed), on no collection's list.
    await asSuperuser(db);
    expect(await copyCountFor("cardA")).toBe(1);
  });
});

/**
 * UIL-033, QA's follow-up: the atomicity test above poisons the COPY insert, so a version that split the
 * write back into two calls (copy + audit first, then the join in its own call) still passed it. This
 * poisons the JOIN instead — a trigger that raises on any update to `collection` — so the union statement
 * fails inside the RPC. Only a single-call write leaves NO copy and NO audit row behind; a two-call
 * write would have committed both before the join failed.
 */
describe("UIL-033 · the join failing inside the RPC takes the copy and the audit row down with it", () => {
  it("poisoned join → nothing lands, and the action says why", async () => {
    await seedCatalogCards(db, ["cardA"]);
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
    ]);
    await db.exec(`
      create function poison_collection_update() returns trigger language plpgsql as $$
      begin
        raise exception 'poisoned join';
      end $$;
      create trigger poison_join before update on collection
        for each row execute function poison_collection_update();
    `);

    await asOwner(db);
    const res = await applyCollectionLog(pgliteClient(db), OWNER, COL, "cardA");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("poisoned join");

    await asSuperuser(db);
    expect(await copyCountFor("cardA")).toBe(0);
    const audit = await db.query<{ n: number }>(`select count(*)::int n from placement_decision`);
    expect(audit.rows[0].n).toBe(0);
    expect(await targetsOf(COL)).toEqual([]);
  });
});
