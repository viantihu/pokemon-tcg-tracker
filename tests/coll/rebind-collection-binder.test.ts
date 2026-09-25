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
 *
 * STEP 2 (the second half of this file): the refusal's remedy — move the copies WITH the collection and
 * re-point it, as one transaction through the real `apply_write_ops` (migration 0017 added the
 * `set_collection_binders` branch it needs). Pinned here rather than in a new file so the guard and its
 * remedy are read together: the pre-fix shape for step 2 is "the rebind is refused and the only way on
 * is to move the cards out one by one", which the CONTROL test's copies still document.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  applyCollectionRebindMove,
  applyCollectionSave,
  blockedBinderRebind,
  blockedBinderRebindMessage,
  buildCollectionRebindOps,
  rebindRemedyFor,
} from "@/lib/coll";
import { collectionRepo, type WriteOp } from "@/lib/repo";
import {
  applyOps,
  asOwner,
  asSuperuser,
  count,
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
    expect(msg).toMatch(/move them with it/i); // step 2's remedy sits beside this text
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

/* ======================= step 2 — move them and rebind, one transaction (UIL-040) ======================= */

function migrationFn(file: string): string {
  const sql = readFileSync(path.join(process.cwd(), "supabase", "migrations", file), "utf8");
  const at = sql.indexOf("\ncreate or replace function apply_write_ops(payload jsonb)");
  expect(at).toBeGreaterThan(0);
  return sql.slice(at);
}

const COL2 = "a0000000-0000-0000-0000-000000000002";
const GONE = "b0000000-0000-0000-0000-0000000000ff";

async function binderOfEveryCopy(): Promise<Record<string, string | null>> {
  const rows = await db.query<{ id: string; binder_id: string | null }>(
    `select id, binder_id from copy order by id`,
  );
  return Object.fromEntries(rows.rows.map((r) => [r.id, r.binder_id]));
}

describe("0017 · the migration", () => {
  it("is 0015's function verbatim plus the one set_collection_binders branch", () => {
    // 0016 left apply_write_ops alone, so 0015's body is the one that runs before this file.
    const base = migrationFn("0015_stand_in_catalog_card.sql");
    const mine = migrationFn("0017_collection_rebind_op.sql");
    const start = mine.indexOf("      -- NEW in 0017");
    const end = mine.indexOf("      else\n", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(mine.slice(0, start) + mine.slice(end)).toBe(base);
    expect(mine.slice(start, end)).toContain("when 'set_collection_binders' then");
    // The inherited branches are still there: the composed function carries every earlier addition.
    expect(mine).toContain("when 'insert_catalog_stand_in' then");
    expect(mine).toContain("when 'delete_set_alias' then");
    expect(mine).toContain("when 'subtract_collection_targets' then");
  });

  it("set_collection_binders rewrites the list as the owner; an id matching no row is a silent no-op", async () => {
    await seed();
    await asOwner(db);
    await applyOps(db, {
      ops: [{ op: "set_collection_binders", collection_id: COL, binder_ids: [SPEC2] }],
    });
    expect(await binderIdsOf(COL)).toEqual([SPEC2]);
    // Same contract as the two target-list ops: no row, no error, nothing else touched.
    await applyOps(db, {
      ops: [{ op: "set_collection_binders", collection_id: COL2, binder_ids: [SPEC] }],
    });
    expect(await binderIdsOf(COL)).toEqual([SPEC2]);
  });
});

describe("applyCollectionRebindMove — the copies and the collection change binder together (real RPC)", () => {
  it("carries every shelved target copy into the new binder, re-points the collection, deletes nothing, audits each copy", async () => {
    await seed();
    await asOwner(db);
    const client = pgliteClient(db);
    expect(await orphanedCopies()).toEqual([]);

    const res = await applyCollectionRebindMove(client, { collectionId: COL, toBinderId: SPEC2 });
    expect([...res.movedCopyIds].sort()).toEqual([CA1, CA2, CB1].sort());
    expect(res.toBinderName).toBe("Specialty B");
    expect(res.staying).toEqual([]);

    await asSuperuser(db);
    expect(await binderIdsOf(COL)).toEqual([SPEC2]);
    const rows = await db.query<{
      id: string;
      binder_id: string | null;
      role: string;
      binder_half: string | null;
      color_band: string | null;
      line_slot_id: string | null;
    }>(`select id, binder_id, role, binder_half, color_band, line_slot_id from copy order by id`);
    expect(rows.rows).toHaveLength(3); // never a delete
    for (const r of rows.rows) {
      // The specialty placement, exactly as `placementForMove`'s collection branch defines it.
      expect(r).toMatchObject({
        binder_id: SPEC2,
        role: "shelved",
        binder_half: null,
        color_band: null,
        line_slot_id: null,
      });
    }
    expect(await orphanedCopies()).toEqual([]);

    const decisions = await db.query<{
      copy_id: string | null;
      decision: string;
      resolved_by: string;
      reason: string;
    }>(`select copy_id, decision, resolved_by, reason from placement_decision order by copy_id`);
    expect(decisions.rows.map((d) => d.copy_id).sort()).toEqual([CA1, CA2, CB1].sort());
    for (const d of decisions.rows) {
      expect(d.decision).toBe("collection-rebind");
      expect(d.resolved_by).toBe("user");
      expect(d.reason).toContain("Matsuno");
      expect(d.reason).toContain("Specialty A");
      expect(d.reason).toContain("Specialty B");
    }

    // And the guard has nothing left to refuse: the collection is where its cards are.
    const col = await collectionRepo.getByPk(pgliteClient(db), COL);
    expect(await blockedBinderRebind(pgliteClient(db), col!, [SPEC2])).toEqual([]);
  });

  it("leaves a copy in the old binder alone when its card is not on this collection's list", async () => {
    await seed();
    await seedCatalogCards(db, ["cardC"]);
    const CC1 = "c0000000-0000-0000-0000-000000000c01";
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, role, binder_id)
        values ('${CC1}', '${OWNER}', 'cardC', 'shelved', '${SPEC}');
    `);
    await asOwner(db);
    const res = await applyCollectionRebindMove(pgliteClient(db), {
      collectionId: COL,
      toBinderId: SPEC2,
    });
    expect(res.movedCopyIds).not.toContain(CC1);
    await asSuperuser(db);
    expect((await binderOfEveryCopy())[CC1]).toBe(SPEC);
  });

  it("a card ANOTHER collection still in the old binder chases STAYS, and is named — the flagged default", async () => {
    await seed();
    await seedCollections(db, [
      { id: COL2, name: "Kagemaru", targetCatalogCardIds: ["cardB"], currentBinderIds: [SPEC] },
    ]);
    await asOwner(db);
    const client = pgliteClient(db);

    // The remedy the refusal carries says the same thing the write will do — one shared read.
    const col = await collectionRepo.getByPk(client, COL);
    const remedy = await rebindRemedyFor(client, col!, SPEC2);
    expect(remedy).toMatchObject({
      kind: "rebind-move",
      collectionId: COL,
      toBinderId: SPEC2,
      toBinderName: "Specialty B",
      fromBinderNames: ["Specialty A"],
      copyCount: 2,
    });
    expect(remedy!.cards.map((c) => [c.tcgdexId, c.copyCount])).toEqual([["cardA", 2]]);
    expect(remedy!.staying).toHaveLength(1);
    expect(remedy!.staying[0]).toMatchObject({
      tcgdexId: "cardB",
      copyCount: 1,
      alsoChasedBy: ["Kagemaru"],
    });

    const res = await applyCollectionRebindMove(client, { collectionId: COL, toBinderId: SPEC2 });
    expect([...res.movedCopyIds].sort()).toEqual([CA1, CA2].sort());
    expect(res.staying.map((s) => s.tcgdexId)).toEqual(["cardB"]);

    await asSuperuser(db);
    expect(await binderOfEveryCopy()).toEqual({ [CA1]: SPEC2, [CA2]: SPEC2, [CB1]: SPEC });
    expect(await binderIdsOf(COL)).toEqual([SPEC2]);
    // CB1 is not stranded: Kagemaru still chases it in the binder it is in. Nothing is an orphan.
    expect(await orphanedCopies()).toEqual([]);
  });

  it("a poison op mid-batch rolls back EVERYTHING — the copies AND the collection's binder list", async () => {
    await seed();
    await asOwner(db);
    const ops: WriteOp[] = [
      ...buildCollectionRebindOps({
        collectionId: COL,
        collectionName: "Matsuno",
        fromBinderNames: ["Specialty A"],
        toBinderId: SPEC2,
        toBinderName: "Specialty B",
        copies: [CA1, CA2, CB1].map((id) => ({ id, reopenSlotId: null, demoteLineId: null })),
        stayingNames: [],
      }),
      {
        op: "insert_copy",
        presence_group_id: "00000000-0000-4000-8000-00000000900d",
        id: crypto.randomUUID(),
        catalog_card_id: "ghost",
        role: "bulk",
      }, // poison
    ];
    await expect(applyOps(db, { ops })).rejects.toThrow();

    await asSuperuser(db);
    expect(await binderIdsOf(COL)).toEqual([SPEC]);
    expect(await binderOfEveryCopy()).toEqual({ [CA1]: SPEC, [CA2]: SPEC, [CB1]: SPEC });
    expect(await count(db, "placement_decision")).toBe(0);
    expect(await orphanedCopies()).toEqual([]);
  });

  it("a copy that (defensively) still holds a line slot reopens it and demotes a complete line, in the same transaction", async () => {
    // A specialty copy carries no slot by construction, so this is the belt-and-braces path the removal
    // path also keeps: a stale relink could leave one, and moving it must not leave a filled slot behind.
    await seed();
    const GEN = "b0000000-0000-0000-0000-000000000001";
    const LINE = "10000000-0000-0000-0000-000000000001";
    const SLOT = "50000000-0000-0000-0000-000000000001";
    await seedBinders(db, [{ id: GEN, type: "general", name: "Binder 1" }]);
    await db.exec(`
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
        values ('${LINE}', '${OWNER}', 1, 'red', '${GEN}', 'back', 'complete');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
        values ('${SLOT}', '${OWNER}', '${LINE}', 0, 'Basic', 'filled', '${CA1}');
      update copy set line_slot_id = '${SLOT}' where id = '${CA1}';
    `);
    await asOwner(db);
    await applyCollectionRebindMove(pgliteClient(db), { collectionId: COL, toBinderId: SPEC2 });

    await asSuperuser(db);
    const slot = await db.query<{ state: string; copy_id: string | null }>(
      `select state, copy_id from line_slot where id = $1`,
      [SLOT],
    );
    expect(slot.rows[0]).toEqual({ state: "placeholder", copy_id: null });
    const line = await db.query<{ status: string }>(
      `select status from evolution_line where id = $1`,
      [LINE],
    );
    expect(line.rows[0].status).toBe("open");
    const ca1 = await db.query<{ line_slot_id: string | null; binder_id: string | null }>(
      `select line_slot_id, binder_id from copy where id = $1`,
      [CA1],
    );
    expect(ca1.rows[0]).toEqual({ line_slot_id: null, binder_id: SPEC2 });
  });

  it("refuses a stale click — already in that binder, or the binder is gone — and writes nothing", async () => {
    await seed();
    await asOwner(db);
    const client = pgliteClient(db);
    await expect(
      applyCollectionRebindMove(client, { collectionId: COL, toBinderId: SPEC }),
    ).rejects.toThrow(/already in that binder/);
    await expect(
      applyCollectionRebindMove(client, { collectionId: COL, toBinderId: GONE }),
    ).rejects.toThrow(/binder no longer exists/);

    await asSuperuser(db);
    expect(await binderIdsOf(COL)).toEqual([SPEC]);
    expect(await binderOfEveryCopy()).toEqual({ [CA1]: SPEC, [CA2]: SPEC, [CB1]: SPEC });
    expect(await count(db, "placement_decision")).toBe(0);
  });
});

describe("applyCollectionSave's rebind refusal carries its remedy (UIL-040 step 2)", () => {
  it("names the destination, the count and the cards, so the editor can offer the move on the same bar", async () => {
    await seed();
    await asOwner(db);
    const res = await applyCollectionSave(pgliteClient(db), OWNER, {
      id: COL,
      name: "Matsuno",
      mode: "finite",
      binderId: SPEC2,
      newBinderName: "",
      targetTcgdexIds: ["cardA", "cardB"],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/move them with it/i);
    expect(res.remedy).toMatchObject({
      kind: "rebind-move",
      collectionId: COL,
      toBinderId: SPEC2,
      toBinderName: "Specialty B",
      fromBinderNames: ["Specialty A"],
      copyCount: 3,
      staying: [],
    });
    expect(res.remedy!.cards.map((c) => [c.tcgdexId, c.copyCount])).toEqual([
      ["cardA", 2],
      ["cardB", 1],
    ]);
    // Refused means refused: nothing moved, nothing re-pointed.
    await asSuperuser(db);
    expect(await binderIdsOf(COL)).toEqual([SPEC]);
    expect(await binderOfEveryCopy()).toEqual({ [CA1]: SPEC, [CA2]: SPEC, [CB1]: SPEC });
  });

  it("every OTHER refusal stays a bare message — a target drop offers no rebind remedy", async () => {
    await seed();
    await asOwner(db);
    const res = await applyCollectionSave(pgliteClient(db), OWNER, {
      id: COL,
      name: "Matsuno",
      mode: "finite",
      binderId: SPEC,
      newBinderName: "",
      targetTcgdexIds: ["cardB"], // drops owned cardA → UIL-014's guard
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/You still own/);
    expect(res.remedy).toBeUndefined();
  });
});

describe("buildCollectionRebindOps — the ordered write set (pure)", () => {
  const plan = {
    collectionId: "col",
    collectionName: "Matsuno",
    fromBinderNames: ["Specialty A"],
    toBinderId: "to",
    toBinderName: "Specialty B",
  };

  it("placements, then vacated slots, then demoted lines, then the collection, then one audit row per copy", () => {
    const ops = buildCollectionRebindOps({
      ...plan,
      copies: [
        { id: "c1", reopenSlotId: "s1", demoteLineId: "l1" },
        { id: "c2", reopenSlotId: null, demoteLineId: null },
      ],
      stayingNames: [],
    });
    expect(ops.map((o) => o.op)).toEqual([
      "update_copy",
      "update_copy",
      "update_slot",
      "update_line",
      "set_collection_binders",
      "insert_decision",
      "insert_decision",
    ]);
    expect(ops[0]).toMatchObject({
      id: "c1",
      patch: {
        role: "shelved",
        binder_id: "to",
        binder_half: null,
        color_band: null,
        line_slot_id: null,
      },
    });
    expect(ops[2]).toMatchObject({ id: "s1", patch: { state: "placeholder", copy_id: null } });
    expect(ops[3]).toMatchObject({ id: "l1", patch: { status: "open" } });
    expect(ops[4]).toEqual({
      op: "set_collection_binders",
      collection_id: "col",
      binder_ids: ["to"],
    });
    expect(ops[5]).toMatchObject({
      copy_id: "c1",
      decision: "collection-rebind",
      resolved_by: "user",
    });
    expect(ops[6]).toMatchObject({
      copy_id: "c2",
      decision: "collection-rebind",
      resolved_by: "user",
    });
    expect(ops.some((o) => o.op === "delete_copy")).toBe(false);
  });

  it("with no copy to move it still re-points the collection and leaves ONE audit row naming who stayed", () => {
    const ops = buildCollectionRebindOps({ ...plan, copies: [], stayingNames: ["cardB"] });
    expect(ops.map((o) => o.op)).toEqual(["set_collection_binders", "insert_decision"]);
    expect(ops[1]).toMatchObject({
      copy_id: null,
      decision: "collection-rebind",
      resolved_by: "user",
    });
    expect((ops[1] as { reason: string }).reason).toContain("cardB");
  });
});
