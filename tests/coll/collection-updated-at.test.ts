/**
 * UIL-052 — sort collections by most-recently-modified, via the three triggers migration 0012 adds
 * (`collection_touch_trg`, `copy_bumps_collection_trg`, `wishlist_bumps_collection_trg`). No single
 * TypeScript choke point exists across the nine write paths that can change what is "in" a
 * collection — see the migration's own comment — so this is verified against every REAL write path
 * Senior BA named, run through the actual modules against real Postgres (PGlite), not a simulated
 * write shape: a haul-commit-style shelve (via `applyWriteOps`, the exact RPC entry point
 * `lib/plan/commit.ts` posts to), `applyMove`, `applyCollectionLog`, `applyBulkAddTargets`, a wishlist
 * placeholder, and `applyCollectionRemoval`. Plus a no-op update that must NOT bump, and a
 * trigger-dropped control proving the positive tests are actually detecting the trigger.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyBulkAddTargets, applyCollectionLog, applyCollectionRemoval } from "@/lib/coll";
import { applyMove, type MoveNameLookups } from "@/lib/line";
import { collectionRepo, wishlistItemRepo, type WriteOp } from "@/lib/repo";
import {
  applyOps,
  asOwner,
  asSuperuser,
  freshRpcDb,
  OWNER,
  seedBinders,
  seedCatalogCards,
  seedCollections,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const SPEC = "b0000000-0000-0000-0000-0000000000e1";
const COL = "a0000000-0000-0000-0000-0000000000e1"; // "Matsuno", lives in SPEC
const COL2 = "a0000000-0000-0000-0000-0000000000e2"; // "Kagemaru", also lives in SPEC

const names: MoveNameLookups = {
  binderName: () => "Specialty A",
  collectionName: (id) => (id === COL ? "Matsuno" : id === COL2 ? "Kagemaru" : null),
  bandDisplay: (key) => key.toUpperCase(),
};

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
});
afterEach(async () => {
  await db.close();
});

/**
 * Epoch millis, not the raw driver value: PGlite hands back a fresh `Date` object per query, so
 * comparing those with `toBe` (reference equality) would pass regardless of whether the value
 * actually changed — every "did it bump" assertion below needs a real value comparison.
 */
async function updatedAtOf(id: string): Promise<number> {
  const res = await db.query<{ u: string | Date }>(
    `select updated_at u from collection where id = $1`,
    [id],
  );
  return new Date(res.rows[0].u).getTime();
}

/** created_at and updated_at both default to the insert time — a real gap is needed to see a bump. */
async function backdate(id: string): Promise<number> {
  await db.query(`update collection set updated_at = now() - interval '1 hour' where id = $1`, [
    id,
  ]);
  return updatedAtOf(id);
}

describe("UIL-052 · collection.updated_at bumps on every real write path", () => {
  it("a haul-commit-style shelve — insert_copy via apply_write_ops, the RPC lib/plan/commit.ts posts to", async () => {
    await seedCatalogCards(db, ["cardA"]);
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: ["cardA"], currentBinderIds: [SPEC] },
    ]);
    const before = await backdate(COL);
    await asOwner(db);

    await applyOps(db, {
      ops: [
        {
          op: "insert_copy",
          id: crypto.randomUUID(),
          catalog_card_id: "cardA",
          role: "shelved",
          binder_id: SPEC,
          binder_half: null,
          color_band: null,
        },
      ],
    });

    await asSuperuser(db);
    expect(await updatedAtOf(COL)).not.toBe(before);
  });

  it("applyMove into a collection", async () => {
    const CARD = crypto.randomUUID();
    const GEN = "b0000000-0000-0000-0000-0000000000e3";
    await seedCatalogCards(db, ["cardA"]);
    await seedBinders(db, [
      { id: SPEC, type: "specialty", name: "Specialty A" },
      { id: GEN, type: "general", name: "Binder 1" },
    ]);
    await seedCollections(db, [
      { id: COL2, name: "Kagemaru", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
    ]);
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
        values ('${CARD}', '${OWNER}', 'cardA', 'shelved', '${GEN}', 'front', 'red');
    `);
    const before = await backdate(COL2);
    await asOwner(db);

    await applyMove(
      pgliteClient(db),
      { copyId: CARD, destination: { kind: "collection", binderId: SPEC, collectionId: COL2 } },
      names,
    );

    await asSuperuser(db);
    expect(await updatedAtOf(COL2)).not.toBe(before);
  });

  it("logCardIntoCollection (applyCollectionLog) shelving a new copy", async () => {
    await seedCatalogCards(db, ["cardA"]);
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
    ]);
    const before = await backdate(COL);
    await asOwner(db);

    const res = await applyCollectionLog(pgliteClient(db), OWNER, COL, "cardA");
    expect(res.ok).toBe(true);

    await asSuperuser(db);
    expect(await updatedAtOf(COL)).not.toBe(before);
  });

  it("a bulk target add (applyBulkAddTargets)", async () => {
    await seedCatalogCards(db, ["cardA", "cardB"]);
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
    ]);
    const before = await backdate(COL);
    await asOwner(db);

    const res = await applyBulkAddTargets(pgliteClient(db), OWNER, COL, ["cardA", "cardB"]);
    expect(res.ok).toBe(true);

    await asSuperuser(db);
    expect(await updatedAtOf(COL)).not.toBe(before);
  });

  it("a wishlist placeholder added for the collection's binder", async () => {
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
    ]);
    const before = await backdate(COL);
    await asOwner(db);

    await wishlistItemRepo.insert(pgliteClient(db), {
      owner_id: OWNER,
      line_slot_id: null,
      required_dex_id: 1,
      required_type: null,
      required_stage: null,
      chosen_catalog_card_id: null,
      alternate_catalog_card_ids: [],
      held_for_binder_id: SPEC,
      will_live_in_specialty: true,
    });

    await asSuperuser(db);
    expect(await updatedAtOf(COL)).not.toBe(before);
  });

  it("a removal — un-shelving a card OUT of the collection's binder counts as modified too (deliberately widened)", async () => {
    const CARD = crypto.randomUUID();
    await seedCatalogCards(db, ["cardA"]);
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: ["cardA"], currentBinderIds: [SPEC] },
    ]);
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half)
        values ('${CARD}', '${OWNER}', 'cardA', 'shelved', '${SPEC}', null);
    `);
    const before = await backdate(COL);
    await asOwner(db);

    await applyCollectionRemoval(
      pgliteClient(db),
      { collectionId: COL, tcgdexId: "cardA", destination: { kind: "bulk" } },
      names,
    );

    await asSuperuser(db);
    expect(await updatedAtOf(COL)).not.toBe(before);
  });

  it("does NOT bump on a no-op re-save — an idempotent write must not reorder her list", async () => {
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: ["cardA"], currentBinderIds: [SPEC] },
    ]);
    const before = await backdate(COL);
    await asOwner(db);

    // Re-tagging a card the collection already chases — same value, not a real change.
    const ops: WriteOp[] = [
      { op: "union_collection_targets", collection_id: COL, catalog_card_ids: ["cardA"] },
    ];
    await applyOps(db, { ops });
    // A plain no-op collection update through the repo layer too.
    await collectionRepo.update(pgliteClient(db), COL, { name: "Matsuno" });

    await asSuperuser(db);
    expect(await updatedAtOf(COL)).toBe(before);
  });

  it("CONTROL — with the trigger dropped, the exact same shelve does NOT bump", async () => {
    await seedCatalogCards(db, ["cardA"]);
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: ["cardA"], currentBinderIds: [SPEC] },
    ]);
    const before = await backdate(COL);
    await db.exec(`drop trigger copy_bumps_collection_trg on copy;`);
    await asOwner(db);

    await applyOps(db, {
      ops: [
        {
          op: "insert_copy",
          id: crypto.randomUUID(),
          catalog_card_id: "cardA",
          role: "shelved",
          binder_id: SPEC,
          binder_half: null,
          color_band: null,
        },
      ],
    });

    await asSuperuser(db);
    // Proves the positive haul-commit-shelve test above is actually detecting the trigger, not some
    // unrelated write (e.g. the `insert_copy` op itself touching `collection` some other way).
    expect(await updatedAtOf(COL)).toBe(before);
  });
});
