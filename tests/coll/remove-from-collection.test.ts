/**
 * UIL-014 — removing a card from a collection is a MOVE, and it is ATOMIC.
 *
 * `copy` has no `collection_id` (0002_domain.sql): membership is derived from a shelved copy sitting in
 * one of the collection's binders AND the card being on `collection.target_catalog_card_ids`. So a
 * removal rewrites the copy's placement and edits the chase list, and the two have to land together.
 *
 * Everything below runs the REAL modules against REAL Postgres (PGlite): the real 0001→0008 migrations,
 * the real `apply_write_ops` function, RLS on as `authenticated`, and `applyCollectionRemoval` /
 * `blockedTargetDrops` driven through a `DbClient` shim rather than a hand-built fake. A fake would only
 * prove the ops matched the author's expectation; it could not prove Postgres agrees, which is where the
 * `subtract_collection_targets` / `update_line` branches of 0008 actually live.
 *
 * The orphan invariant is asserted directly (`orphanedCopies`), and the pre-fix behaviour — persisting a
 * shorter target list on its own, which is exactly what the Edit modal's "✕" did — is exercised as a
 * control so the hazard stays documented rather than folklore.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  applyCollectionRemoval,
  blockedTargetDrops,
  blockedTargetDropsMessage,
  buildCollectionRemovalOps,
  rejectSelfDestination,
} from "@/lib/coll";
import { collectionRepo, type WriteOp } from "@/lib/repo";
import type { MoveNameLookups } from "@/lib/line";
import {
  applyOps,
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
const GEN = "b0000000-0000-0000-0000-000000000022";
const COL = "a0000000-0000-0000-0000-000000000001";
const COL2 = "a0000000-0000-0000-0000-000000000002";
const CA1 = "c0000000-0000-0000-0000-000000000a01";
const CA2 = "c0000000-0000-0000-0000-000000000a02";
const CB1 = "c0000000-0000-0000-0000-000000000b01";
const LINE = "10000000-0000-0000-0000-000000000001";
const SLOT = "50000000-0000-0000-0000-000000000001";

const names: MoveNameLookups = {
  binderName: (id) => (id === SPEC ? "Specialty A" : id === GEN ? "Binder 1" : "Binder"),
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
 * The state the report describes: a finite collection in a specialty binder chasing cardA + cardB, with
 * TWO shelved copies of cardA in that binder (one of them filling the last slot of a `complete` line), a
 * second collection sharing the same binder, and an unrelated copy of cardB.
 */
async function seed(): Promise<void> {
  await seedCatalogCards(db, ["cardA", "cardB"]);
  await seedBinders(db, [
    { id: SPEC, type: "specialty", name: "Specialty A" },
    { id: GEN, type: "general", name: "Binder 1" },
  ]);
  await seedCollections(db, [
    {
      id: COL,
      name: "Matsuno",
      targetCatalogCardIds: ["cardA", "cardB"],
      currentBinderIds: [SPEC],
    },
    { id: COL2, name: "Kagemaru", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
  ]);
  await db.exec(`
    insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, status)
      values ('${LINE}', '${OWNER}', 1, 'red', '${SPEC}', 'complete');
    insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
      values ('${CA1}', '${OWNER}', 'cardA', 'shelved', '${SPEC}', null, null),
             ('${CA2}', '${OWNER}', 'cardA', 'shelved', '${SPEC}', null, null),
             ('${CB1}', '${OWNER}', 'cardB', 'shelved', '${SPEC}', null, null);
    insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
      values ('${SLOT}', '${OWNER}', '${LINE}', 0, 'Basic', 'filled', '${CA1}');
    update copy set line_slot_id = '${SLOT}' where id = '${CA1}';
  `);
}

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

/**
 * The invariant the whole fix exists to protect. Defined once in the shared harness so this file and
 * the UIL-022 move tests cannot drift into two readings of "orphan" (`../support/pglite-rpc`).
 */
async function orphanedCopies(): Promise<string[]> {
  return orphanedCopiesIn(db);
}

async function targetsOf(id: string): Promise<string[]> {
  const rows = await q<{ t: string[] }>(
    `select target_catalog_card_ids t from collection where id = $1`,
    [id],
  );
  return rows[0].t;
}

/* ------------------- defect 2: the chase list cannot strand a copy ------------------- */

describe("dropping an owned target from the chase list", () => {
  it("is REFUSED, naming the card and its binder — pre-fix it silently orphaned the copy", async () => {
    await seed();
    await asOwner(db);
    const client = pgliteClient(db);

    const col = await collectionRepo.getByPk(client, COL);
    expect(col).not.toBeNull();

    // What the Edit modal's "✕" produced: cardA gone from the draft list, cardA still shelved in SPEC.
    const blocked = await blockedTargetDrops(client, col!, ["cardB"]);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({
      tcgdexId: "cardA",
      name: "cardA",
      binderName: "Specialty A",
      copyCount: 2,
    });

    const msg = blockedTargetDropsMessage(blocked);
    expect(msg).toContain("cardA");
    expect(msg).toContain("Specialty A");
    expect(msg).toMatch(/Remove/);
  });

  it("is ALLOWED for a target she does not own — there is no copy to strand", async () => {
    await seedCatalogCards(db, ["cardA"]);
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: ["cardA"], currentBinderIds: [SPEC] },
    ]);
    await asOwner(db);
    const client = pgliteClient(db);
    const col = await collectionRepo.getByPk(client, COL);
    expect(await blockedTargetDrops(client, col!, [])).toEqual([]);
  });

  it("is ALLOWED when the copy is in the bulk box rather than the collection's binder", async () => {
    await seedCatalogCards(db, ["cardA"]);
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: ["cardA"], currentBinderIds: [SPEC] },
    ]);
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, role)
        values ('${CA1}', '${OWNER}', 'cardA', 'bulk');
    `);
    await asOwner(db);
    const client = pgliteClient(db);
    const col = await collectionRepo.getByPk(client, COL);
    expect(await blockedTargetDrops(client, col!, [])).toEqual([]);
  });

  it("ignores a save that adds targets without dropping any", async () => {
    await seed();
    await asOwner(db);
    const client = pgliteClient(db);
    const col = await collectionRepo.getByPk(client, COL);
    expect(await blockedTargetDrops(client, col!, ["cardA", "cardB", "cardC"])).toEqual([]);
  });
});

/* --------------------- defect 1: there is now a removal, and it moves --------------------- */

describe("applyCollectionRemoval (real modules, real Postgres)", () => {
  it("moves EVERY copy to the bulk box, reopens the vacated slot, demotes the line, drops the target", async () => {
    await seed();
    expect(await orphanedCopies()).toEqual([]); // the seed itself is consistent
    await asOwner(db);

    const res = await applyCollectionRemoval(
      pgliteClient(db),
      { collectionId: COL, tcgdexId: "cardA", destination: { kind: "bulk" } },
      names,
    );
    expect(res.movedCopyIds.sort()).toEqual([CA1, CA2].sort());
    expect(res.destinationLabel).toBe("Bulk box (not shelved)");

    await asSuperuser(db);
    const copies = await q<{
      id: string;
      role: string;
      binder_id: string | null;
      line_slot_id: string | null;
      color_band: string | null;
    }>(
      `select id, role, binder_id, line_slot_id, color_band from copy where catalog_card_id = 'cardA' order by id`,
    );
    expect(copies).toHaveLength(2);
    for (const c of copies) {
      expect(c.role).toBe("bulk");
      expect(c.binder_id).toBeNull();
      expect(c.line_slot_id).toBeNull();
      expect(c.color_band).toBeNull();
    }

    // Removal symmetry: the slot CA1 filled is a placeholder again and its line is no longer complete.
    expect(
      (
        await q<{ state: string; copy_id: string | null }>(
          `select state, copy_id from line_slot where id = '${SLOT}'`,
        )
      )[0],
    ).toEqual({ state: "placeholder", copy_id: null });
    expect(
      (await q<{ status: string }>(`select status from evolution_line where id = '${LINE}'`))[0]
        .status,
    ).toBe("open");

    // The chase list lost cardA and kept cardB, in order.
    expect(await targetsOf(COL)).toEqual(["cardB"]);

    // One audit row per moved copy (dev-spec §4), always the user's call.
    const audit = await q<{ decision: string; resolved_by: string; copy_id: string }>(
      `select decision, resolved_by, copy_id from placement_decision order by copy_id`,
    );
    expect(audit).toHaveLength(2);
    expect(audit.every((a) => a.decision === "collection-remove" && a.resolved_by === "user")).toBe(
      true,
    );

    // And nothing is stranded: cardB's copy is still tracked, cardA's are no longer in any binder.
    expect(await orphanedCopies()).toEqual([]);
  });

  it("re-homes onto a shelf: binder + half + band, and the target still leaves the list", async () => {
    await seed();
    await asOwner(db);
    await applyCollectionRemoval(
      pgliteClient(db),
      {
        collectionId: COL,
        tcgdexId: "cardA",
        destination: { kind: "shelf", binderId: GEN, half: "front", band: "red" },
      },
      names,
    );
    await asSuperuser(db);
    const copies = await q<{
      role: string;
      binder_id: string;
      binder_half: string;
      color_band: string;
    }>(`select role, binder_id, binder_half, color_band from copy where catalog_card_id = 'cardA'`);
    expect(copies).toHaveLength(2);
    for (const c of copies) {
      expect(c).toEqual({
        role: "shelved",
        binder_id: GEN,
        binder_half: "front",
        color_band: "red",
      });
    }
    expect(await targetsOf(COL)).toEqual(["cardB"]);
    expect(await orphanedCopies()).toEqual([]);
  });

  it("into ANOTHER collection sharing the same binder: it joins that chase list, so it stays tracked", async () => {
    await seed();
    await asOwner(db);
    await applyCollectionRemoval(
      pgliteClient(db),
      {
        collectionId: COL,
        tcgdexId: "cardA",
        destination: { kind: "collection", binderId: SPEC, collectionId: COL2 },
      },
      names,
    );
    await asSuperuser(db);
    expect(await targetsOf(COL)).toEqual(["cardB"]);
    expect(await targetsOf(COL2)).toEqual(["cardA"]);
    // Still shelved in the shared specialty binder — and NOT an orphan, because COL2 now lists it.
    const copies = await q<{ role: string; binder_id: string }>(
      `select role, binder_id from copy where catalog_card_id = 'cardA'`,
    );
    expect(copies.every((c) => c.role === "shelved" && c.binder_id === SPEC)).toBe(true);
    expect(await orphanedCopies()).toEqual([]);
  });

  it("refuses the collection it is being removed from, and its own binder as a shelf", async () => {
    await seed();
    await asOwner(db);
    const client = pgliteClient(db);
    await expect(
      applyCollectionRemoval(
        client,
        {
          collectionId: COL,
          tcgdexId: "cardA",
          destination: { kind: "collection", binderId: SPEC, collectionId: COL },
        },
        names,
      ),
    ).rejects.toThrow(/different home/i);
    await expect(
      applyCollectionRemoval(
        client,
        {
          collectionId: COL,
          tcgdexId: "cardA",
          destination: { kind: "shelf", binderId: SPEC, half: "front", band: "red" },
        },
        names,
      ),
    ).rejects.toThrow(/own binder/i);

    await asSuperuser(db);
    expect(await targetsOf(COL)).toEqual(["cardA", "cardB"]);
  });

  it("refuses a card that is no longer on the collection's list", async () => {
    await seed();
    await asOwner(db);
    await expect(
      applyCollectionRemoval(
        pgliteClient(db),
        { collectionId: COL, tcgdexId: "cardZ", destination: { kind: "bulk" } },
        names,
      ),
    ).rejects.toThrow(/no longer in this collection/i);
  });

  it("drops a list-only target (no copy shelved here) without inventing a placement", async () => {
    await seedCatalogCards(db, ["cardA", "cardB"]);
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await seedCollections(db, [
      {
        id: COL,
        name: "Matsuno",
        targetCatalogCardIds: ["cardA", "cardB"],
        currentBinderIds: [SPEC],
      },
    ]);
    await asOwner(db);
    const res = await applyCollectionRemoval(
      pgliteClient(db),
      { collectionId: COL, tcgdexId: "cardA", destination: { kind: "bulk" } },
      names,
    );
    expect(res.movedCopyIds).toEqual([]);
    await asSuperuser(db);
    expect(await targetsOf(COL)).toEqual(["cardB"]);
    const audit = await q<{ copy_id: string | null; reason: string }>(
      `select copy_id, reason from placement_decision`,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].copy_id).toBeNull();
    expect(audit[0].reason).toMatch(/list only/i);
  });
});

/* ------------------------------- atomicity ------------------------------- */

describe("a removal cannot half-apply", () => {
  it("a poison op mid-batch rolls the WHOLE removal back — placement AND chase list unchanged", async () => {
    await seed();
    await asOwner(db);

    const ops = buildCollectionRemovalOps({
      collectionId: COL,
      collectionName: "Matsuno",
      tcgdexId: "cardA",
      copies: [
        { id: CA1, reopenSlotId: SLOT, demoteLineId: LINE },
        { id: CA2, reopenSlotId: null, demoteLineId: null },
      ],
      destination: { kind: "bulk" },
      destinationLabel: "Bulk box (not shelved)",
      destinationCollectionId: null,
    });
    // Trailing op references a catalog card that does not exist → FK violation after the earlier ops.
    const poisoned: WriteOp[] = [
      ...ops,
      { op: "insert_copy", id: crypto.randomUUID(), catalog_card_id: "ghost", role: "bulk" },
    ];
    await expect(applyOps(db, { ops: poisoned })).rejects.toThrow();

    await asSuperuser(db);
    expect(await targetsOf(COL)).toEqual(["cardA", "cardB"]);
    const copies = await q<{ role: string; binder_id: string | null; line_slot_id: string | null }>(
      `select role, binder_id, line_slot_id from copy where catalog_card_id = 'cardA' order by id`,
    );
    expect(copies.every((c) => c.role === "shelved" && c.binder_id === SPEC)).toBe(true);
    expect(copies[0].line_slot_id).toBe(SLOT);
    expect(
      (
        await q<{ state: string; copy_id: string | null }>(
          `select state, copy_id from line_slot where id = '${SLOT}'`,
        )
      )[0],
    ).toEqual({ state: "filled", copy_id: CA1 });
    expect(
      (await q<{ status: string }>(`select status from evolution_line where id = '${LINE}'`))[0]
        .status,
    ).toBe("complete");
    expect(await q(`select 1 from placement_decision`)).toHaveLength(0);
  });

  it("CONTROL — the pre-fix shape (persist a shorter list, leave the copy alone) strands the copy", async () => {
    await seed();
    // Exactly what `saveCollection` did with the Edit modal's "✕": one write, the chase list only.
    await asOwner(db);
    await db.query(`update collection set target_catalog_card_ids = $1 where id = $2`, [
      ["cardB"],
      COL,
    ]);
    await asSuperuser(db);
    // Both copies of cardA are still shelved in the collection's binder and on no list at all.
    expect(await orphanedCopies()).toEqual([CA1, CA2].sort());
  });
});

/* ------------------------- the pure op set, in order ------------------------- */

describe("buildCollectionRemovalOps", () => {
  const base = {
    collectionId: COL,
    collectionName: "Matsuno",
    tcgdexId: "cardA",
    destinationLabel: "Bulk box (not shelved)",
  };

  it("orders placement → vacated slot → demoted line → both lists → audit", () => {
    const ops = buildCollectionRemovalOps({
      ...base,
      copies: [
        { id: CA1, reopenSlotId: SLOT, demoteLineId: LINE },
        { id: CA2, reopenSlotId: null, demoteLineId: null },
      ],
      destination: { kind: "collection", binderId: SPEC, collectionId: COL2 },
      destinationCollectionId: COL2,
    });
    expect(ops.map((o) => o.op)).toEqual([
      "update_copy",
      "update_copy",
      "update_slot",
      "update_line",
      "subtract_collection_targets",
      "union_collection_targets",
      "insert_decision",
      "insert_decision",
    ]);
  });

  it("emits no union when the destination is not a collection, and none for the same collection", () => {
    const bulk = buildCollectionRemovalOps({
      ...base,
      copies: [{ id: CA1, reopenSlotId: null, demoteLineId: null }],
      destination: { kind: "bulk" },
      destinationCollectionId: null,
    });
    expect(bulk.some((o) => o.op === "union_collection_targets")).toBe(false);

    const same = buildCollectionRemovalOps({
      ...base,
      copies: [{ id: CA1, reopenSlotId: null, demoteLineId: null }],
      destination: { kind: "collection", binderId: SPEC, collectionId: COL },
      destinationCollectionId: COL,
    });
    expect(same.some((o) => o.op === "union_collection_targets")).toBe(false);
  });

  it("takes the placement columns from placementForMove, not from a second copy of the rules", () => {
    const ops = buildCollectionRemovalOps({
      ...base,
      copies: [{ id: CA1, reopenSlotId: null, demoteLineId: null }],
      destination: { kind: "shelf", binderId: GEN, half: "back", band: "green" },
      destinationCollectionId: null,
    });
    expect(ops[0]).toEqual({
      op: "update_copy",
      id: CA1,
      patch: {
        role: "shelved",
        binder_id: GEN,
        binder_half: "back",
        color_band: "green",
        line_slot_id: null,
      },
    });
  });
});

describe("rejectSelfDestination", () => {
  it("blocks the source collection and the source binder as a shelf, allows everything else", () => {
    expect(
      rejectSelfDestination({ kind: "collection", binderId: SPEC, collectionId: COL }, COL, [SPEC]),
    ).toMatch(/different home/i);
    expect(
      rejectSelfDestination({ kind: "shelf", binderId: SPEC, half: "front", band: "red" }, COL, [
        SPEC,
      ]),
    ).toMatch(/own binder/i);
    // Another collection in the SAME binder is fine — the card joins that collection's list.
    expect(
      rejectSelfDestination({ kind: "collection", binderId: SPEC, collectionId: COL2 }, COL, [
        SPEC,
      ]),
    ).toBeNull();
    expect(rejectSelfDestination({ kind: "bulk" }, COL, [SPEC])).toBeNull();
    expect(
      rejectSelfDestination({ kind: "shelf", binderId: GEN, half: "front", band: "red" }, COL, [
        SPEC,
      ]),
    ).toBeNull();
  });
});
