/**
 * UIL-040 — rebinding a collection to a different specialty binder must not strand the copies still
 * shelved in the old one.
 *
 * `saveCollection`'s update path writes `current_binder_ids: [binderId]` unconditionally (the same
 * shape of bug as UIL-014 defect 2, a fourth site of the same orphan class per the issue log): a copy
 * stays physically shelved in the OLD binder while collection membership is derived from the NEW one,
 * so it reads as un-owned everywhere while still occupying a real pocket.
 *
 * `blockedBinderRebind` is the guard, mirroring `blockedTargetDrops`'s shape exactly. The CONTROL test
 * reproduces the pre-fix write directly against Postgres to keep the hazard documented rather than
 * folklore.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { blockedBinderRebind, blockedBinderRebindMessage } from "@/lib/coll";
import { collectionRepo } from "@/lib/repo";
import {
  asOwner,
  asSuperuser,
  freshRpcDb,
  orphanedCopies as orphanedCopiesIn,
  OWNER,
  seedBinders,
  seedCatalogCards,
  seedCollections,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const SPEC = "b0000000-0000-0000-0000-000000000011";
const SPEC2 = "b0000000-0000-0000-0000-000000000012";
const COL = "a0000000-0000-0000-0000-000000000001";
const CA1 = "c0000000-0000-0000-0000-000000000a01";
const CA2 = "c0000000-0000-0000-0000-000000000a02";
const CB1 = "c0000000-0000-0000-0000-000000000b01";

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
});
afterEach(async () => {
  await db.close();
});

async function seed(): Promise<void> {
  await seedCatalogCards(db, ["cardA", "cardB"]);
  await seedBinders(db, [
    { id: SPEC, type: "specialty", name: "Specialty A" },
    { id: SPEC2, type: "specialty", name: "Specialty B" },
  ]);
  await seedCollections(db, [
    {
      id: COL,
      name: "Matsuno",
      targetCatalogCardIds: ["cardA", "cardB"],
      currentBinderIds: [SPEC],
    },
  ]);
  await db.exec(`
    insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
      values ('${CA1}', '${OWNER}', 'cardA', 'shelved', '${SPEC}', null, null),
             ('${CA2}', '${OWNER}', 'cardA', 'shelved', '${SPEC}', null, null),
             ('${CB1}', '${OWNER}', 'cardB', 'shelved', '${SPEC}', null, null);
  `);
}

async function orphanedCopies(): Promise<string[]> {
  return orphanedCopiesIn(db);
}

async function binderIdsOf(id: string): Promise<string[]> {
  const rows = await db.query<{ b: string[] }>(
    `select current_binder_ids b from collection where id = $1`,
    [id],
  );
  return rows.rows[0].b;
}

describe("blockedBinderRebind", () => {
  it("is REFUSED, naming the cards and the old binder — pre-fix this silently orphaned every copy", async () => {
    await seed();
    await asOwner(db);
    const client = pgliteClient(db);

    const col = await collectionRepo.getByPk(client, COL);
    expect(col).not.toBeNull();

    const blocked = await blockedBinderRebind(client, col!, [SPEC2]);
    expect(blocked).toHaveLength(2);
    expect(blocked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tcgdexId: "cardA", binderName: "Specialty A", copyCount: 2 }),
        expect.objectContaining({ tcgdexId: "cardB", binderName: "Specialty A", copyCount: 1 }),
      ]),
    );

    const msg = blockedBinderRebindMessage(blocked);
    expect(msg).toContain("cardA");
    expect(msg).toContain("Specialty A");
    expect(msg).toMatch(/relocate/i);
  });

  it("is ALLOWED when the destination binder list still includes the old binder", async () => {
    await seed();
    await asOwner(db);
    const client = pgliteClient(db);
    const col = await collectionRepo.getByPk(client, COL);
    expect(await blockedBinderRebind(client, col!, [SPEC, SPEC2])).toEqual([]);
  });

  it("is ALLOWED when nothing is shelved in the binder being left behind", async () => {
    await seedCatalogCards(db, ["cardA"]);
    await seedBinders(db, [
      { id: SPEC, type: "specialty", name: "Specialty A" },
      { id: SPEC2, type: "specialty", name: "Specialty B" },
    ]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: ["cardA"], currentBinderIds: [SPEC] },
    ]);
    await asOwner(db);
    const client = pgliteClient(db);
    const col = await collectionRepo.getByPk(client, COL);
    expect(await blockedBinderRebind(client, col!, [SPEC2])).toEqual([]);
  });

  it("is ALLOWED when the shelved copy belongs to a card no longer on the target list", async () => {
    await seedCatalogCards(db, ["cardA"]);
    await seedBinders(db, [
      { id: SPEC, type: "specialty", name: "Specialty A" },
      { id: SPEC2, type: "specialty", name: "Specialty B" },
    ]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
    ]);
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, role, binder_id)
        values ('${CA1}', '${OWNER}', 'cardA', 'shelved', '${SPEC}');
    `);
    await asOwner(db);
    const client = pgliteClient(db);
    const col = await collectionRepo.getByPk(client, COL);
    expect(await blockedBinderRebind(client, col!, [SPEC2])).toEqual([]);
  });

  it("CONTROL — the pre-fix shape (overwrite current_binder_ids alone) strands every copy in the old binder", async () => {
    // A second collection sharing SPEC (the multi-collection-per-binder case the shared `orphanedCopies`
    // invariant is written against) so the copies stay inside its detection scope after COL leaves.
    await seed();
    const COL2 = "a0000000-0000-0000-0000-000000000002";
    await seedCollections(db, [
      { id: COL2, name: "Kagemaru", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
    ]);
    await asOwner(db);
    expect(await orphanedCopies()).toEqual([]); // the seed itself is consistent

    // Exactly what saveCollection's update path did before this fix: one write, current_binder_ids only.
    await db.query(`update collection set current_binder_ids = $1 where id = $2`, [[SPEC2], COL]);
    expect(await binderIdsOf(COL)).toEqual([SPEC2]);

    await asSuperuser(db);
    // All three copies are still shelved in SPEC. COL no longer claims it; COL2 does but never chased
    // cardA/cardB — so every copy reads as un-owned while still occupying a real pocket.
    expect(await orphanedCopies()).toEqual([CA1, CA2, CB1].sort());

    // And the single-collection case (no other collection ever shared SPEC) is just as real even though
    // the shared invariant above is scoped to binders still claimed by SOME collection: the copies are
    // provably still in SPEC while COL, the only collection that ever pointed there, now doesn't.
    const stillInOldBinder = await db.query<{ id: string }>(
      `select id from copy where catalog_card_id in ('cardA','cardB') and binder_id = $1 and role = 'shelved'`,
      [SPEC],
    );
    expect(stillInOldBinder.rows.map((r) => r.id).sort()).toEqual([CA1, CA2, CB1].sort());
  });
});
