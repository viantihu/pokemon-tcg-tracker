/**
 * UIL-022 — moving a card INTO a collection joins that collection's chase list.
 * UIL-023 — and the whole move is ONE transaction.
 *
 * Collection membership is derived from two facts together (app/(ui)/coll/actions.ts `loadCollHub`): a
 * shelved copy sits in one of the collection's binders AND its catalog id is on
 * `collection.target_catalog_card_ids`. `placementForMove` only ever produced the first, so a
 * `{kind: "collection"}` move shelved the card in the collection's binder and left it off the list —
 * invisible in the very collection holding it, while occupying a real pocket.
 *
 * TWO SURFACES, ONE DEFINITION. The defect was reachable from two independent sites: the Line screen's
 * move panel (`applyMove`) and the Plan screen's placement override, which is NOT `applyMove` at all —
 * it is a draft-time override keyed by draft id and applied by `buildHaulCommitPayload` at commit
 * (`writeOverriddenCard`). Both are covered below, and both take their membership op from the single
 * `collectionTargetJoinOp` so "joining a collection" cannot mean two things (UIL-012's failure shape).
 *
 * Everything runs the REAL modules against REAL Postgres (PGlite): the real 0001→0008 migrations, the
 * real `apply_write_ops` function, RLS on as `authenticated`, and `applyMove` driven through a
 * `DbClient` shim whose only write path is the RPC. A hand-rolled applier would prove the ops match the
 * author's expectation and nothing about the function that runs in production — which is where the
 * `union_collection_targets` branch actually lives (UIL-012 shipped through a green suite exactly that
 * way).
 *
 * Every "no orphans" assertion is paired with a CONTROL that performs the pre-fix write and asserts the
 * orphan APPEARS, so an empty result proves absence rather than a query that can never return a row.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  applyMove,
  buildMoveOps,
  collectionTargetJoinOp,
  placementForMove,
  type MoveNameLookups,
} from "@/lib/line";
import { buildCollectionRemovalOps } from "@/lib/coll";
import {
  buildHaulCommitPayload,
  planFromDraft,
  type DraftItem,
  type PlanContext,
} from "@/lib/plan";
import type { EngineContext } from "@/lib/engine";
import type { WriteOp } from "@/lib/repo";
import { CHARMELEON_SV03_027, VAPOREON_SV035_134 } from "../engine/fixtures";
import {
  applyOps,
  asOwner,
  asSuperuser,
  freshRpcDb,
  orphanedCopies,
  OWNER,
  referencedCatalogIds,
  haulRow,
  seedBinders,
  seedCatalogCards,
  seedCollections,
  seedHaulRows,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const SPEC = "b0000000-0000-0000-0000-0000000000f1"; // specialty binder — where collections live
const GEN = "b0000000-0000-0000-0000-0000000000f2"; // general binder
const COL = "a0000000-0000-0000-0000-0000000000f1"; // "Matsuno", lives in SPEC
const COL2 = "a0000000-0000-0000-0000-0000000000f2"; // "Kagemaru", also lives in SPEC
const CARD = "c0000000-0000-0000-0000-0000000000f1"; // the copy being moved
const OTHER = "c0000000-0000-0000-0000-0000000000f2"; // an unrelated copy holding a slot
const LINE = "10000000-0000-0000-0000-0000000000f1";
const SLOT = "50000000-0000-0000-0000-0000000000f1";

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

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function targetsOf(id: string): Promise<string[]> {
  const rows = await q<{ t: string[] }>(
    `select target_catalog_card_ids t from collection where id = $1`,
    [id],
  );
  return rows[0].t;
}

async function copyRow(): Promise<{
  role: string;
  binder_id: string | null;
  binder_half: string | null;
  color_band: string | null;
  line_slot_id: string | null;
}> {
  return (
    await q<{
      role: string;
      binder_id: string | null;
      binder_half: string | null;
      color_band: string | null;
      line_slot_id: string | null;
    }>(`select role, binder_id, binder_half, color_band, line_slot_id from copy where id = $1`, [
      CARD,
    ])
  )[0];
}

/**
 * The state before a sorting pass: two collections share the specialty binder, `Matsuno` already
 * chases `cardX`, `Kagemaru` chases nothing, and the copy being moved is shelved on a band in the
 * GENERAL binder (so the pre-move state is consistent — it is in no collection's binder).
 */
async function seedShelved(): Promise<void> {
  await seedCatalogCards(db, ["cardA", "cardX"]);
  await seedBinders(db, [
    { id: SPEC, type: "specialty", name: "Specialty A" },
    { id: GEN, type: "general", name: "Binder 1" },
  ]);
  await seedCollections(db, [
    { id: COL, name: "Matsuno", targetCatalogCardIds: ["cardX"], currentBinderIds: [SPEC] },
    { id: COL2, name: "Kagemaru", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
  ]);
  await db.exec(`
    insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
      values ('${CARD}', '${OWNER}', 'cardA', 'shelved', '${GEN}', 'front', 'red');
  `);
}

/** As above, but the copy fills the last slot of a `complete` line, so a move must demote it. */
async function seedOnCompleteLine(): Promise<void> {
  await seedShelved();
  await db.exec(`
    insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
      values ('${LINE}', '${OWNER}', 4, 'red', '${GEN}', 'back', 'complete');
    insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
      values ('${SLOT}', '${OWNER}', '${LINE}', 0, 'Basic', 'filled', '${CARD}');
    update copy set line_slot_id = '${SLOT}', binder_half = 'back' where id = '${CARD}';
  `);
}

/* ============================ CONTROL: the pre-fix write ============================ */

describe("CONTROL — the pre-fix move (placement only, no chase-list write)", () => {
  it("strands the copy in the collection's binder, on no list: the orphan APPEARS", async () => {
    await seedShelved();
    expect(await orphanedCopies(db)).toEqual([]); // the seed itself is consistent

    // EXACTLY what `applyMove` did before this fix: `placementForMove` → `copyRepo.update`, and
    // nothing at all touching `collection.target_catalog_card_ids`.
    const patch = placementForMove({ kind: "collection", binderId: SPEC, collectionId: COL2 });
    await db.query(
      `update copy set role = $1, binder_id = $2, binder_half = $3, color_band = $4, line_slot_id = $5
         where id = $6`,
      [patch.role, patch.binder_id, patch.binder_half, patch.color_band, patch.line_slot_id, CARD],
    );

    // The card is physically in Kagemaru's binder and on nobody's chase list.
    expect((await copyRow()).binder_id).toBe(SPEC);
    expect(await targetsOf(COL2)).toEqual([]);
    expect(await orphanedCopies(db)).toEqual([CARD]);
  });

  it("the Plan override's pre-fix payload strands it the same way (a DIFFERENT site, same defect)", async () => {
    // The Plan screen's override never goes through `applyMove`: it is applied by the haul commit.
    // Its pre-fix shape was `insert_copy` at the override placement and no union — reproduced here as
    // the bare op set, so this control keeps documenting the hazard after the fix lands.
    await seedCatalogCards(db, ["cardA"]);
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await seedCollections(db, [
      { id: COL2, name: "Kagemaru", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
    ]);
    await asOwner(db);
    await applyOps(db, {
      ops: [
        {
          op: "insert_copy",
          id: CARD,
          catalog_card_id: "cardA",
          role: "shelved",
          binder_id: SPEC,
          binder_half: null,
          color_band: null,
        },
      ],
    });
    await asSuperuser(db);
    expect(await orphanedCopies(db)).toEqual([CARD]);
  });
});

/* ==================== the Line screen's move panel (`applyMove`) ==================== */

describe("applyMove into a collection (real modules, real Postgres, real RPC)", () => {
  it("shelves the copy in the binder AND joins the chase list — no orphan", async () => {
    await seedShelved();
    await asOwner(db);

    const res = await applyMove(
      pgliteClient(db),
      { copyId: CARD, destination: { kind: "collection", binderId: SPEC, collectionId: COL2 } },
      names,
    );
    expect(res.destinationLabel).toBe("Specialty A · Kagemaru");

    await asSuperuser(db);
    // Fact one: the placement. A specialty binder is a single section — no half, no rainbow band.
    expect(await copyRow()).toEqual({
      role: "shelved",
      binder_id: SPEC,
      binder_half: null,
      color_band: null,
      line_slot_id: null,
    });
    // Fact two: membership. This is the write UIL-022 was missing.
    expect(await targetsOf(COL2)).toEqual(["cardA"]);
    // The collection she did NOT move it into is untouched.
    expect(await targetsOf(COL)).toEqual(["cardX"]);
    expect(await orphanedCopies(db)).toEqual([]);

    // Audit: one row, the user's call, naming the destination (dev-spec §4).
    const audit = await q<{
      decision: string;
      resolved_by: string;
      copy_id: string;
      reason: string;
    }>(`select decision, resolved_by, copy_id, reason from placement_decision`);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      decision: "placement-move",
      resolved_by: "user",
      copy_id: CARD,
    });
    expect(audit[0].reason).toMatch(/Kagemaru/);
    // owner_id was never in the payload — it defaulted to auth.uid() under SECURITY INVOKER.
    expect(
      (await q<{ owner_id: string }>(`select owner_id from placement_decision`))[0].owner_id,
    ).toBe(OWNER);
  });

  it("re-tagging a card the collection already chases is a no-op, not a duplicate", async () => {
    await seedShelved();
    await db.query(`update collection set target_catalog_card_ids = $1 where id = $2`, [
      ["cardX", "cardA"],
      COL2,
    ]);
    await asOwner(db);
    await applyMove(
      pgliteClient(db),
      { copyId: CARD, destination: { kind: "collection", binderId: SPEC, collectionId: COL2 } },
      names,
    );
    await asSuperuser(db);
    // Order preserved, no second "cardA" — the union is idempotent server-side (0007).
    expect(await targetsOf(COL2)).toEqual(["cardX", "cardA"]);
  });

  it("off a complete line into a collection: slot reopens, line demotes, list joins — together", async () => {
    await seedOnCompleteLine();
    await asOwner(db);

    await applyMove(
      pgliteClient(db),
      { copyId: CARD, destination: { kind: "collection", binderId: SPEC, collectionId: COL } },
      names,
    );

    await asSuperuser(db);
    expect(await copyRow()).toEqual({
      role: "shelved",
      binder_id: SPEC,
      binder_half: null,
      color_band: null,
      line_slot_id: null,
    });
    // Removal symmetry (sync-arch §1.6) survived the conversion to the RPC.
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
    expect(await targetsOf(COL)).toEqual(["cardX", "cardA"]);
    expect(await orphanedCopies(db)).toEqual([]);
  });

  it("does NOT touch any chase list when the destination is bulk or a shelf", async () => {
    await seedShelved();
    await db.query(`update collection set target_catalog_card_ids = $1 where id = $2`, [
      ["cardA"],
      COL2,
    ]);
    await asOwner(db);
    const client = pgliteClient(db);

    await applyMove(client, { copyId: CARD, destination: { kind: "bulk" } }, names);
    // Front half, deliberately (UIL-056): a back-half shelf now needs a `lineJoin`, which is not
    // what this test is about — that rule has its own coverage below.
    await applyMove(
      client,
      { copyId: CARD, destination: { kind: "shelf", binderId: GEN, half: "front", band: "red" } },
      names,
    );

    await asSuperuser(db);
    // A move out of a collection's binder deliberately leaves her curated lists alone (see below).
    expect(await targetsOf(COL2)).toEqual(["cardA"]);
    expect(await targetsOf(COL)).toEqual(["cardX"]);
    expect(await copyRow()).toMatchObject({
      binder_id: GEN,
      binder_half: "front",
      color_band: "red",
    });
  });

  it("REFUSES a collection that has been deleted — a no-op union would orphan the card silently", async () => {
    await seedShelved();
    await db.exec(`delete from collection where id = '${COL2}';`);
    await asOwner(db);
    await expect(
      applyMove(
        pgliteClient(db),
        { copyId: CARD, destination: { kind: "collection", binderId: SPEC, collectionId: COL2 } },
        names,
      ),
    ).rejects.toThrow(/no longer exists/i);

    await asSuperuser(db);
    // Nothing moved, so nothing was stranded.
    expect(await copyRow()).toMatchObject({ binder_id: GEN, color_band: "red" });
    expect(await orphanedCopies(db)).toEqual([]);
    expect(await q(`select 1 from placement_decision`)).toHaveLength(0);
  });

  it("CONTROL — without that refusal the union matches no row and the card IS orphaned", async () => {
    // Proves the guard above is load-bearing: `union_collection_targets` writes nothing when no
    // collection matches, and the placement lands anyway. Same payload, guard bypassed.
    await seedShelved();
    await db.exec(`delete from collection where id = '${COL2}';`);
    await asOwner(db);
    await applyOps(db, {
      ops: buildMoveOps({
        copyId: CARD,
        catalogCardId: "cardA",
        destination: { kind: "collection", binderId: SPEC, collectionId: COL2 },
        reopenSlotId: null,
        demoteLineId: null,
        destinationLabel: "Specialty A · Kagemaru",
      }),
    });
    await asSuperuser(db);
    expect((await copyRow()).binder_id).toBe(SPEC);
    expect(await orphanedCopies(db)).toEqual([CARD]);
  });

  it("REFUSES a collection that has since moved to a different binder", async () => {
    // The union WOULD land here, but membership is derived from `current_binder_ids`, so the card
    // would read as an un-owned target she is chasing while she is holding it.
    await seedShelved();
    await db.query(`update collection set current_binder_ids = $1 where id = $2`, [[GEN], COL2]);
    await asOwner(db);
    await expect(
      applyMove(
        pgliteClient(db),
        { copyId: CARD, destination: { kind: "collection", binderId: SPEC, collectionId: COL2 } },
        names,
      ),
    ).rejects.toThrow(/does not live in that binder/i);
    await asSuperuser(db);
    expect(await targetsOf(COL2)).toEqual([]);
  });

  it("leaves a still-filled slot alone when the copy does not actually own it", async () => {
    // A stale `copy.line_slot_id` pointing at a slot filled by someone else must not reopen it.
    await seedOnCompleteLine();
    // The slot is filled by a DIFFERENT copy while this copy's `line_slot_id` still points at it.
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
        values ('${OTHER}', '${OWNER}', 'cardX', 'shelved', '${GEN}', 'back', 'red');
      update line_slot set copy_id = '${OTHER}' where id = '${SLOT}';
      update copy set line_slot_id = '${SLOT}' where id = '${OTHER}';
    `);
    await asOwner(db);
    await applyMove(
      pgliteClient(db),
      { copyId: CARD, destination: { kind: "collection", binderId: SPEC, collectionId: COL } },
      names,
    );
    await asSuperuser(db);
    // The line was NOT demoted, because this copy did not hold the slot.
    expect(
      (await q<{ status: string }>(`select status from evolution_line where id = '${LINE}'`))[0]
        .status,
    ).toBe("complete");
  });

  it("refuses a copy that no longer exists rather than writing a decision for nothing", async () => {
    await seedShelved();
    await asOwner(db);
    await expect(
      applyMove(
        pgliteClient(db),
        {
          copyId: "99999999-9999-9999-9999-999999999999",
          destination: { kind: "bulk" },
        },
        names,
      ),
    ).rejects.toThrow(/no longer in the collection/i);
    await asSuperuser(db);
    expect(await q(`select 1 from placement_decision`)).toHaveLength(0);
  });
});

/* ============================ UIL-023: the move is atomic ============================ */

describe("a move cannot half-apply (UIL-023)", () => {
  it("a poison op mid-batch rolls the WHOLE move back — placement, slot, line AND chase list", async () => {
    await seedOnCompleteLine();
    await asOwner(db);

    const ops = buildMoveOps({
      copyId: CARD,
      catalogCardId: "cardA",
      destination: { kind: "collection", binderId: SPEC, collectionId: COL2 },
      reopenSlotId: SLOT,
      demoteLineId: LINE,
      destinationLabel: "Specialty A · Kagemaru",
    });
    // Trailing op references a catalog card that does not exist → FK violation after the earlier ops.
    const poisoned: WriteOp[] = [
      ...ops,
      { op: "insert_copy", id: crypto.randomUUID(), catalog_card_id: "ghost", role: "bulk" },
    ];
    await expect(applyOps(db, { ops: poisoned })).rejects.toThrow();

    await asSuperuser(db);
    // Pre-fix this path was four un-transacted statements: the first three would have stuck.
    expect(await copyRow()).toMatchObject({
      binder_id: GEN,
      binder_half: "back",
      color_band: "red",
      line_slot_id: SLOT,
    });
    expect(
      (
        await q<{ state: string; copy_id: string | null }>(
          `select state, copy_id from line_slot where id = '${SLOT}'`,
        )
      )[0],
    ).toEqual({ state: "filled", copy_id: CARD });
    expect(
      (await q<{ status: string }>(`select status from evolution_line where id = '${LINE}'`))[0]
        .status,
    ).toBe("complete");
    expect(await targetsOf(COL2)).toEqual([]);
    expect(await q(`select 1 from placement_decision`)).toHaveLength(0);
  });

  it("a failure AFTER the chase-list write still leaves the list untouched", async () => {
    // The mirror image of the test above, and the specific half-apply UIL-022's naive fix would have
    // introduced in reverse: with the union appended as a fifth un-transacted statement, a placement
    // that had already committed could not be taken back. Inside one transaction it can.
    await seedShelved();
    await asOwner(db);
    const ops = buildMoveOps({
      copyId: CARD,
      catalogCardId: "cardA",
      destination: { kind: "collection", binderId: SPEC, collectionId: COL2 },
      reopenSlotId: null,
      demoteLineId: null,
      destinationLabel: "Specialty A · Kagemaru",
    });
    await expect(
      applyOps(db, {
        ops: [...ops, { op: "insert_copy", id: crypto.randomUUID(), catalog_card_id: "ghost" }],
      }),
    ).rejects.toThrow();
    await asSuperuser(db);
    expect(await copyRow()).toMatchObject({ binder_id: GEN, color_band: "red" });
    expect(await targetsOf(COL2)).toEqual([]);
    expect(await orphanedCopies(db)).toEqual([]);
  });
});

/* =============== the Plan screen's placement override (a different site) =============== */

const BANDS = [
  "red",
  "orange",
  "yellow",
  "olive",
  "green",
  "dark_blue",
  "light_blue",
  "purple",
  "pink",
  "white",
];

/** A minimal PlanContext over two real catalog fixtures, with the two binders the override targets. */
function planContext(): PlanContext {
  const catalog = [CHARMELEON_SV03_027, VAPOREON_SV035_134];
  const ctx: EngineContext = {
    typeColorMap: { Fire: "red", Water: "light_blue", Colorless: "white" },
    catalog,
    owned: [],
    binders: [
      { id: GEN, name: "Binder 1", type: "general", isActive: true },
      { id: SPEC, name: "Specialty A", type: "specialty", isActive: false },
    ],
    lines: [],
    collections: [],
    now: "2026-09-13T00:00:00.000Z",
  };
  return {
    ctx,
    catalogById: new Map(catalog.map((c) => [c.tcgdexId, c])),
    copyRowById: new Map(),
    slotRowsByLine: new Map(),
    orderedBandKeys: BANDS,
    lookups: {
      binderNameById: new Map([
        [GEN, "Binder 1"],
        [SPEC, "Specialty A"],
      ]),
      bandDisplayByKey: new Map(BANDS.map((b) => [b, b])),
      collectionNameById: new Map([[COL2, "Kagemaru"]]),
      // Required by AssembleLookups since UIL-016 (#78) put card artwork on the plan rows. Empty
      // here: these cases assert the collection-join write set, not how a row renders.
      imageUrlByTcgdexId: new Map(),
    },
  };
}

describe("Plan-screen placement override into a collection (haul commit, already atomic)", () => {
  it("the commit payload joins the destination collection's chase list — no orphan", async () => {
    const pc = planContext();
    // A copy her import made, waiting in her haul (UIL-098 part 2): the commit places it.
    const draft: DraftItem[] = [
      haulRow("d0000000-0000-4000-8000-0000000c0e01", CHARMELEON_SV03_027.tcgdexId),
    ];
    const { planned } = planFromDraft(pc, draft);
    const { payload } = buildHaulCommitPayload(pc, planned, {
      draft,
      overrides: { [draft[0].id]: { kind: "collection", binderId: SPEC, collectionId: COL2 } },
    });

    // The union rides in the SAME payload as the copy, so it commits with it or not at all.
    expect(payload.ops.filter((o) => o.op === "union_collection_targets")).toEqual([
      {
        op: "union_collection_targets",
        collection_id: COL2,
        catalog_card_ids: [CHARMELEON_SV03_027.tcgdexId],
      },
    ]);

    await seedCatalogCards(db, referencedCatalogIds(payload));
    await seedBinders(db, [
      { id: GEN, type: "general" },
      { id: SPEC, type: "specialty" },
    ]);
    await seedCollections(db, [
      { id: COL2, name: "Kagemaru", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
    ]);
    await seedHaulRows(db, draft);
    await asOwner(db);
    await applyOps(db, payload);
    await asSuperuser(db);

    expect(await targetsOf(COL2)).toEqual([CHARMELEON_SV03_027.tcgdexId]);
    const copies = await q<{ role: string; binder_id: string }>(`select role, binder_id from copy`);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toEqual({ role: "shelved", binder_id: SPEC });
    expect(await orphanedCopies(db)).toEqual([]);
  });

  it("a bulk or shelf override still joins nothing", async () => {
    const pc = planContext();
    const draft: DraftItem[] = [
      haulRow("d0000000-0000-4000-8000-0000000c0e02", VAPOREON_SV035_134.tcgdexId),
    ];
    const { planned } = planFromDraft(pc, draft);
    for (const dest of [
      { kind: "bulk" } as const,
      { kind: "shelf", binderId: GEN, half: "front", band: "light_blue" } as const,
    ]) {
      const { payload } = buildHaulCommitPayload(pc, planned, {
        draft,
        overrides: { [draft[0].id]: dest },
      });
      expect(payload.ops.some((o) => o.op === "union_collection_targets")).toBe(false);
    }
  });
});

/* ==================== one definition of "joining a collection" ==================== */

describe("collectionTargetJoinOp is the single definition all three surfaces use", () => {
  it("returns the union op for a collection destination and null for every other kind", () => {
    expect(
      collectionTargetJoinOp({ kind: "collection", binderId: SPEC, collectionId: COL2 }, "cardA"),
    ).toEqual({
      op: "union_collection_targets",
      collection_id: COL2,
      catalog_card_ids: ["cardA"],
    });
    expect(collectionTargetJoinOp({ kind: "bulk" }, "cardA")).toBeNull();
    expect(
      collectionTargetJoinOp({ kind: "shelf", binderId: GEN, half: "front", band: "red" }, "cardA"),
    ).toBeNull();
  });

  it("the Line move, the Plan override and the collection removal all emit the IDENTICAL op", () => {
    const dest = { kind: "collection", binderId: SPEC, collectionId: COL2 } as const;
    const expected = {
      op: "union_collection_targets",
      collection_id: COL2,
      catalog_card_ids: ["cardA"],
    };

    // 1. the Line screen's move panel
    const fromMove = buildMoveOps({
      copyId: CARD,
      catalogCardId: "cardA",
      destination: dest,
      reopenSlotId: null,
      demoteLineId: null,
      destinationLabel: "Specialty A · Kagemaru",
    }).filter((o) => o.op === "union_collection_targets");

    // 2. the collection-removal path (UIL-014), moving into a DIFFERENT collection
    const fromRemoval = buildCollectionRemovalOps({
      collectionId: COL,
      collectionName: "Matsuno",
      tcgdexId: "cardA",
      copies: [{ id: CARD, reopenSlotId: null, demoteLineId: null }],
      destination: dest,
      destinationLabel: "Specialty A · Kagemaru",
      destinationCollectionId: COL2,
    }).filter((o) => o.op === "union_collection_targets");

    expect(fromMove).toEqual([expected]);
    expect(fromRemoval).toEqual([expected]);
    // 3. the Plan override is asserted against the same literal in its own suite above.
  });

  it("the removal path still refuses to re-join the collection it is removing FROM", () => {
    const ops = buildCollectionRemovalOps({
      collectionId: COL,
      collectionName: "Matsuno",
      tcgdexId: "cardA",
      copies: [{ id: CARD, reopenSlotId: null, demoteLineId: null }],
      destination: { kind: "collection", binderId: SPEC, collectionId: COL },
      destinationLabel: "Specialty A · Matsuno",
      destinationCollectionId: COL,
    });
    expect(ops.some((o) => o.op === "union_collection_targets")).toBe(false);
  });
});

/* ============================== the pure op set, in order ============================== */

describe("buildMoveOps", () => {
  it("orders placement → vacated slot → demoted line → chase list → audit", () => {
    const ops = buildMoveOps({
      copyId: CARD,
      catalogCardId: "cardA",
      destination: { kind: "collection", binderId: SPEC, collectionId: COL2 },
      reopenSlotId: SLOT,
      demoteLineId: LINE,
      destinationLabel: "Specialty A · Kagemaru",
    });
    expect(ops.map((o) => o.op)).toEqual([
      "update_copy",
      "update_slot",
      "update_line",
      "union_collection_targets",
      "insert_decision",
    ]);
  });

  it("emits placement + audit only for a bulk move with no slot to vacate", () => {
    const ops = buildMoveOps({
      copyId: CARD,
      catalogCardId: "cardA",
      destination: { kind: "bulk" },
      reopenSlotId: null,
      demoteLineId: null,
      destinationLabel: "Bulk box (not shelved)",
    });
    expect(ops.map((o) => o.op)).toEqual(["update_copy", "insert_decision"]);
  });

  it("takes the placement columns from placementForMove, not a second copy of the rules", () => {
    const dest = { kind: "shelf", binderId: GEN, half: "back", band: "green" } as const;
    const ops = buildMoveOps({
      copyId: CARD,
      catalogCardId: "cardA",
      destination: dest,
      reopenSlotId: null,
      demoteLineId: null,
      destinationLabel: "Binder 1 · Back · GREEN",
    });
    expect(ops[0]).toEqual({
      op: "update_copy",
      id: CARD,
      patch: {
        role: "shelved",
        binder_id: GEN,
        binder_half: "back",
        color_band: "green",
        line_slot_id: null,
      },
    });
    // The same columns `placementForMove` produces — asserted against it, not re-typed.
    const patch = placementForMove(dest);
    expect(ops[0]).toMatchObject({ patch });
  });

  it("carries no owner_id in any op — the RPC defaults it to auth.uid()", () => {
    const ops = buildMoveOps({
      copyId: CARD,
      catalogCardId: "cardA",
      destination: { kind: "collection", binderId: SPEC, collectionId: COL2 },
      reopenSlotId: SLOT,
      demoteLineId: LINE,
      destinationLabel: "Specialty A · Kagemaru",
    });
    expect(JSON.stringify(ops)).not.toContain("owner_id");
  });
});
