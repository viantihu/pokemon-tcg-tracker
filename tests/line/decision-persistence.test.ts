/**
 * UIL-078 — a line decision she resolves must stay resolved. Pre-fix, `deriveDecisions` re-ran from
 * scratch on every load and every "confirm the recommendation" choice left its own trigger condition
 * true (state stays `placeholder`/`block`, a claimed collection stays claimed), so the identical
 * decision re-derived forever — "line decisions do not stick," her report.
 *
 * The marker lives on `line_slot` (`resolved_decision_kind`/`resolved_decision_choice`), not on
 * `placement_decision` — that table is already load-bearing for queue state (UIL-042) and must never
 * become load-bearing for a second kind of behaviour, or pruning audit history would silently make the
 * app start re-asking her everything. So this runs the REAL write path end to end: `applyDecision`
 * against real Postgres (PGlite), then a fresh `loadLineScreen` read — the same round trip
 * `resolveDecisionAction` performs — to prove the persisted marker, not just the pure resolver's
 * output, is what makes the decision disappear.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  applyDecision,
  applyMove,
  loadLineScreen,
  loadMoveOptions,
  moveNameLookups,
  releaseSlotOps,
} from "@/lib/line";
import { DECISION_RETIRED } from "@/lib/line/write";
import { executeApply, type SyncPlanBundle } from "@/lib/sync";
import { buildScreenModel } from "@/lib/line/load";
import type { ReconcilePlan } from "@/lib/sync/reconcile";
import { asOwner, asSuperuser, freshRpcDb, OWNER, seedBinders } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const B1 = "1c000000-0000-0000-0000-0000000000b1";

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedBinders(db, [{ id: B1, type: "general", name: "Binder 1" }]);
});
afterEach(async () => {
  await db.close();
});

async function seedCatalog(
  rows: {
    id: string;
    name: string;
    dexId: number;
    types?: string[];
    cardClass?: "standard" | "specialty";
  }[],
): Promise<void> {
  // price_market deliberately left NULL: PGlite's wire-protocol client returns a Postgres `numeric`
  // as a string, not a number (unlike production's PostgREST, which serialises it as JSON), and
  // `fmtPrice` calls `.toFixed()` unconditionally on a non-null value — a pre-existing mismatch this
  // suite has never tripped before because nothing had seeded a priced specialty printing. Not this
  // ticket's bug to fix; staying NULL avoids it entirely, and none of these tests assert on price text.
  for (const r of rows) {
    await db.query(
      `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from, card_class)
         values ($1, $2, $3, $4, 'Basic', null, $5)`,
      [r.id, r.name, [r.dexId], r.types ?? ["Fire"], r.cardClass ?? "standard"],
    );
  }
}

/**
 * The decisions the SERVER derives. Since UIL-121 A2c her screen shows only collection-vs-line (the other cards
 * retired), but the derivation and its UIL-078 markers stay on the server until the tightening migration (D), so
 * they are pinned here, where they still run (`applyDecision` reads the same derivation).
 */
async function decisionIds(): Promise<string[]> {
  return (await buildScreenModel(pgliteClient(db))).derived.map((d) => d.card.id);
}

/**
 * UIL-121 (0034): the cap, the block, the root block and the termination are no longer questions she is asked; their
 * writes (a 'capped' or 'terminated' status, an engine block slot) are gone from the data. They are still DERIVED on
 * the server (the card is hidden from her screen, A2c), and a stale tab could still send one: refused, nothing written.
 */
describe("UIL-121 · a retired decision sent anyway is refused, and nothing is written", () => {
  const LINE = "10000000-0000-0000-0000-00000000ec01";
  const SLOT = "50000000-0000-0000-0000-00000000ec01";
  const DEX = 9401;

  beforeEach(async () => {
    await seedCatalog([
      { id: "onlymon-ex-cheap", name: "Onlymon ex", dexId: DEX, cardClass: "specialty" },
      { id: "onlymon-ex-pricey", name: "Onlymon ex", dexId: DEX, cardClass: "specialty" },
    ]);
    await db.exec(`
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
        values ('${LINE}', '${OWNER}', ${DEX}, 'red', '${B1}', 'back', 'open');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, target_catalog_card_id)
        values ('${SLOT}', '${OWNER}', '${LINE}', 0, 'Basic', 'placeholder', 'onlymon-ex-cheap');
    `);
  });

  it.each(["confirm-cap", "cap-no-wishlist", "leave-it"] as const)(
    "an ex-only cap's '%s' is refused in her words",
    async (choice) => {
      await asOwner(db);
      expect(await decisionIds()).toContain(`${LINE}:ex-only-cap:0`); // still derived, only hidden
      await expect(
        applyDecision(pgliteClient(db), OWNER, `${LINE}:ex-only-cap:0`, choice),
      ).rejects.toThrow(DECISION_RETIRED);
      await asSuperuser(db);
      expect(
        (
          await db.query(
            `select l.status, s.resolved_decision_kind from evolution_line l join line_slot s on s.line_id = l.id`,
          )
        ).rows,
      ).toEqual([{ status: "open", resolved_decision_kind: null }]);
      expect((await db.query(`select count(*)::int n from placement_decision`)).rows).toEqual([
        { n: 0 },
      ]);
    },
  );
});

describe("UIL-078 · collection-vs-line stays resolved", () => {
  const LINE = "10000000-0000-0000-0000-00000000cc01";
  const DEX = 9402;

  beforeEach(async () => {
    await seedCatalog([{ id: "collectamon-basic", name: "Collectamon", dexId: DEX }]);
    await db.exec(`
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
        values ('${LINE}', '${OWNER}', ${DEX}, 'red', '${B1}', 'back', 'open');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, target_catalog_card_id)
        values ('50000000-0000-0000-0000-00000000cc01', '${OWNER}', '${LINE}', 0, 'Basic', 'placeholder', 'collectamon-basic');
      insert into collection (owner_id, name, target_catalog_card_ids)
        values ('${OWNER}', 'Fire Collection', array['collectamon-basic']);
    `);
  });

  it("collection-wins removes the decision on the next load", async () => {
    const client = pgliteClient(db);
    await asOwner(db);
    expect(await decisionIds()).toContain(`${LINE}:collection-vs-line:0`);

    await applyDecision(client, OWNER, `${LINE}:collection-vs-line:0`, "collection-wins");

    expect(await decisionIds()).not.toContain(`${LINE}:collection-vs-line:0`);
    // And keeps staying resolved: the same collection, still claiming, is the same question.
    expect(await decisionIds()).not.toContain(`${LINE}:collection-vs-line:0`);
  });

  it("UIL-121: 'collection wins' records her chase of the card it wishlists; 'nothing wishlisted' is her empty", async () => {
    // A second printing the collection does not claim: the one the line's stage can chase instead.
    await asSuperuser(db);
    await seedCatalog([{ id: "collectamon-alt", name: "Collectamon", dexId: DEX }]);
    const client = pgliteClient(db);
    await asOwner(db);
    await applyDecision(client, OWNER, `${LINE}:collection-vs-line:0`, "collection-wins");
    await asSuperuser(db);
    const [row] = (
      await db.query<{ stage_choice: string | null; target: string | null; chosen: string | null }>(
        `select s.stage_choice, s.target_catalog_card_id as target, w.chosen_catalog_card_id as chosen
           from line_slot s left join wishlist_item w on w.line_slot_id = s.id and w.resolved_at is null
          where s.id = '50000000-0000-0000-0000-00000000cc01'`,
      )
    ).rows;
    expect(row.stage_choice).toBe("chase");
    expect(row.target).toBe(row.chosen);
    expect(row.chosen).not.toBeNull();
  });

  /**
   * QA finding (3) on #188: the suppression compared the KIND only. "Collection wins" is an answer
   * about a PARTICULAR collection's claim; a different collection claiming the same card afterwards is
   * a new question, and kind alone silenced it. The marker must carry the claiming collection and the
   * loader must compare it.
   */
  it("a DIFFERENT collection claiming the same card is a new question — asked again", async () => {
    const client = pgliteClient(db);
    await asOwner(db);
    await applyDecision(client, OWNER, `${LINE}:collection-vs-line:0`, "collection-wins");
    expect(await decisionIds()).not.toContain(`${LINE}:collection-vs-line:0`);

    await asSuperuser(db);
    await db.exec(`
      insert into collection (owner_id, name, target_catalog_card_ids)
        values ('${OWNER}', 'Water Collection', array['collectamon-basic']);
    `);
    await asOwner(db);

    expect(await decisionIds()).toContain(`${LINE}:collection-vs-line:0`);
  });

  it("the resolved collection dropping its claim while another holds one asks again too", async () => {
    const client = pgliteClient(db);
    await asOwner(db);
    await applyDecision(client, OWNER, `${LINE}:collection-vs-line:0`, "collection-wins");

    await asSuperuser(db);
    await db.exec(`
      update collection set target_catalog_card_ids = '{}' where name = 'Fire Collection';
      insert into collection (owner_id, name, target_catalog_card_ids)
        values ('${OWNER}', 'Water Collection', array['collectamon-basic']);
    `);
    await asOwner(db);

    expect(await decisionIds()).toContain(`${LINE}:collection-vs-line:0`);
  });
});

/**
 * QA finding (4) on #188: nothing cleared the marker when a slot left `filled`. A slot she had
 * resolved a cap on, later filled by a card and then vacated again, is a genuinely new situation — and
 * with a stale marker it would never ask again, which the brief named as worse than the original bug.
 * `releaseSlotOps` is the ONE release path (UIL-062: Line move, Haul Plan pull, Haul Plan override all
 * emit it), so clearing there covers every caller.
 */
describe("UIL-078 · a released slot forgets its resolution", () => {
  const LINE = "10000000-0000-0000-0000-00000000fc01";
  const SLOT = "50000000-0000-0000-0000-00000000fc01";
  const COPY = "c0000000-0000-0000-0000-00000000fc01";
  const DEX = 9405;

  beforeEach(async () => {
    // UIL-121 (0034): the question a released slot asks afresh is the one still asked, collection-vs-line (the cap this
    // used before retired).
    await seedCatalog([
      { id: "refillmon-a", name: "Refillmon", dexId: DEX },
      { id: "refillmon-b", name: "Refillmon", dexId: DEX },
    ]);
    await db.exec(`
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
        values ('${LINE}', '${OWNER}', ${DEX}, 'red', '${B1}', 'back', 'open');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state)
        values ('${SLOT}', '${OWNER}', '${LINE}', 0, 'Basic', 'placeholder');
      insert into collection (owner_id, name, target_catalog_card_ids)
        values ('${OWNER}', 'Refill Collection', array['refillmon-a']);
    `);
  });

  it("releaseSlotOps clears every marker column along with the copy", () => {
    const [release] = releaseSlotOps("slot-x", null);
    expect(release).toEqual({
      op: "update_slot",
      id: "slot-x",
      patch: {
        state: "placeholder",
        copy_id: null,
        resolved_decision_kind: null,
        resolved_decision_choice: null,
        resolved_decision_collection_id: null,
        stage_choice: null, // UIL-121: a stage that lost its card is undecided again
      },
    });
  });

  it("collection wins, then filled, then vacated by a move: the question is asked afresh", async () => {
    const client = pgliteClient(db);
    await asOwner(db);
    await applyDecision(client, OWNER, `${LINE}:collection-vs-line:0`, "collection-wins");
    expect(await decisionIds()).not.toContain(`${LINE}:collection-vs-line:0`);

    // A card lands in the slot (as the Haul Plan or a line join would leave it)…
    await asSuperuser(db);
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band, line_slot_id)
        values ('${COPY}', '${OWNER}', 'refillmon-a', 'shelved', '${B1}', 'back', 'red', '${SLOT}');
      update line_slot set state = 'filled', copy_id = '${COPY}' where id = '${SLOT}';
    `);
    await asOwner(db);
    expect(await decisionIds()).not.toContain(`${LINE}:collection-vs-line:0`); // filled: nothing to ask

    // …and leaves again through the real move path, which releases the slot.
    await applyMove(
      client,
      { copyId: COPY, destination: { kind: "bulk" } },
      moveNameLookups(await loadMoveOptions(client)),
    );

    await asSuperuser(db);
    const slot = await db.query<{
      state: string;
      resolved_decision_kind: string | null;
      resolved_decision_choice: string | null;
    }>(
      `select state, resolved_decision_kind, resolved_decision_choice from line_slot where id = $1`,
      [SLOT],
    );
    expect(slot.rows[0]).toEqual({
      state: "placeholder",
      resolved_decision_kind: null,
      resolved_decision_choice: null,
    });
    await asOwner(db);
    expect(await decisionIds()).toContain(`${LINE}:collection-vs-line:0`);
  });

  /** A sync plan that retires exactly one copy — what the reconciler emits when the export drops it. */
  function retireBundle(copyId: string, catalogCardId: string): SyncPlanBundle {
    return {
      mode: "import",
      baseSnapshotId: null, // a collection that has never synced (UIL-099 E5)
      plan: {
        creates: [],
        retires: [
          {
            kind: "retire",
            copyId,
            catalogCardId,
            dexVariantRaw: "",
            consequence: "line-slot-freed",
            needsReview: false,
          },
        ],
        variantUpdates: [],
        flagFixes: [],
        unchanged: 0,
        unresolved: [],
        fastPath: false,
        forgetRemoved: [],
        returning: [], // UIL-089: nothing removed, nothing to forget.
        diff: { entries: [], migrations: [] } as unknown as ReconcilePlan["diff"],
      },
      current: [],
      queue: { parks: [], archiveEntryIds: [], dropEntryIds: [], stillWaiting: 0 },
      counts: {
        creates: 0,
        retires: 1,
        variantUpdates: 0,
        parks: 0,
        drops: 0,
        promotions: 0,
        dedupeUpdates: 0,
        unchanged: 0,
      },
    };
  }

  /**
   * The third door: a sync RETIRE (the export no longer lists the card) frees the slot too, through
   * lib/sync/exec.ts rather than the Line move. It must go through the same `releaseSlotOps`, or a slot
   * vacated this way keeps its stale marker and never asks again.
   */
  it("a slot vacated by a sync retire asks afresh", async () => {
    const client = pgliteClient(db);
    await asOwner(db);
    await applyDecision(client, OWNER, `${LINE}:collection-vs-line:0`, "collection-wins");
    expect(await decisionIds()).not.toContain(`${LINE}:collection-vs-line:0`);

    await asSuperuser(db);
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band, line_slot_id)
        values ('${COPY}', '${OWNER}', 'refillmon-a', 'shelved', '${B1}', 'back', 'red', '${SLOT}');
      update line_slot set state = 'filled', copy_id = '${COPY}' where id = '${SLOT}';
    `);
    await asOwner(db);

    await executeApply(client, retireBundle(COPY, "refillmon-a"), OWNER);

    await asSuperuser(db);
    const slot = await db.query<{
      state: string;
      copy_id: string | null;
      resolved_decision_kind: string | null;
    }>(`select state, copy_id, resolved_decision_kind from line_slot where id = $1`, [SLOT]);
    expect(slot.rows[0]).toEqual({
      state: "placeholder",
      copy_id: null,
      resolved_decision_kind: null,
    });
    expect((await db.query<{ n: number }>(`select count(*)::int n from copy`)).rows[0].n).toBe(0);
    await asOwner(db);
    expect(await decisionIds()).toContain(`${LINE}:collection-vs-line:0`);
  });
});

describe("UIL-078 · leave-it resurfaces by design — the one choice that must NOT stick", () => {
  const LINE = "10000000-0000-0000-0000-00000000ea01";
  const DEX = 9404;

  it("leaving a collection-vs-line decision unresolved shows it again on the next load", async () => {
    await seedCatalog([{ id: "leavemon", name: "Leavemon", dexId: DEX }]);
    await db.exec(`
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
        values ('${LINE}', '${OWNER}', ${DEX}, 'red', '${B1}', 'back', 'open');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state)
        values ('50000000-0000-0000-0000-00000000ea01', '${OWNER}', '${LINE}', 0, 'Basic', 'placeholder');
      insert into collection (owner_id, name, target_catalog_card_ids)
        values ('${OWNER}', 'Leave Collection', array['leavemon']);
    `);
    const client = pgliteClient(db);
    await asOwner(db);

    await applyDecision(client, OWNER, `${LINE}:collection-vs-line:0`, "leave-it");

    expect(await decisionIds()).toContain(`${LINE}:collection-vs-line:0`);
  });
});

/**
 * UIL-121 A2c (her Q5, 2026-09-27): only the collection-vs-line decision card remains on her screen. The server still
 * derives a cap (above), hidden; a termination can no longer exist (0034: no line reads 'terminated'). `loadLineScreen`
 * is what she sees.
 */
describe("UIL-121 A2c · her screen shows only the collection-vs-line decision card", () => {
  const CAPPED = "10000000-0000-0000-0000-00000000a2c1";
  const CLAIMED = "10000000-0000-0000-0000-00000000a2c3";

  beforeEach(async () => {
    await seedCatalog([
      { id: "onlymon-ex", name: "Onlymon ex", dexId: 9411, cardClass: "specialty" },
      { id: "collectamon", name: "Collectamon", dexId: 9413 },
    ]);
    await db.exec(`
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status) values
        ('${CAPPED}', '${OWNER}', 9411, 'red', '${B1}', 'back', 'open'),
        ('${CLAIMED}', '${OWNER}', 9413, 'red', '${B1}', 'back', 'open');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, target_catalog_card_id) values
        ('50000000-0000-0000-0000-00000000a2c1', '${OWNER}', '${CAPPED}', 0, 'Basic', 'placeholder', 'onlymon-ex'),
        ('50000000-0000-0000-0000-00000000a2c3', '${OWNER}', '${CLAIMED}', 0, 'Basic', 'placeholder', 'collectamon');
      insert into collection (owner_id, name, target_catalog_card_ids)
        values ('${OWNER}', 'Fire Collection', array['collectamon']);
    `);
  });

  it("a derived cap shows no card; the collection-vs-line one still does", async () => {
    await asOwner(db);
    // The server derives both (so the filter, not the data, is what hides the cap) ...
    expect(await decisionIds()).toEqual(
      expect.arrayContaining([`${CAPPED}:ex-only-cap:0`, `${CLAIMED}:collection-vs-line:0`]),
    );
    // ... and her screen gets only the collection-vs-line card.
    const screen = await loadLineScreen(pgliteClient(db));
    expect(screen.decisions.map((d) => d.id)).toEqual([`${CLAIMED}:collection-vs-line:0`]);
  });
});
