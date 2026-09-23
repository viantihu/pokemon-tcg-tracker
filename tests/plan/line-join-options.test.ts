/**
 * UIL-070 part 1 — the Haul Plan offers a draft card EXACTLY the lines the Line screen offers a stranded
 * copy of the same printing. Parity, not just plausibility: both sides are computed here against the
 * same real Postgres state (PGlite, real migrations) and compared field for field, so the extraction
 * cannot have silently changed the Line screen's answer, and the Plan's answer cannot drift from it.
 *
 * Same fixture shape as tests/line/unlined-cards.test.ts: one Fire family, one line with the root
 * filled and the Stage1 open, plus a duplicate of the root that can join nothing but is explained.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { loadLineScreen } from "@/lib/line";
import { clearCatalogCache, lineJoinOptionsFromContext, loadPlanContext } from "@/lib/plan";
import { OWNER, freshRpcDb, seedBinders } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const GEN = "b0000000-0000-0000-0000-0000000000a1";
const LINE = "10000000-0000-0000-0000-0000000000a1";
const SLOT_ROOT = "50000000-0000-0000-0000-0000000000a1";
const SLOT_NEXT = "50000000-0000-0000-0000-0000000000a2";
const OWNED_EMBERLING = "c0000000-0000-0000-0000-0000000000a1";
const UNLINED_EMBERDRAKE = "c0000000-0000-0000-0000-0000000000a2";
const DUPLICATE_EMBERLING = "c0000000-0000-0000-0000-0000000000a3";

const EMBERLING_DEX = 9501;
const EMBERDRAKE_DEX = 9502;

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  clearCatalogCache();
  await seedBinders(db, [{ id: GEN, type: "general", name: "Binder 1" }]);
  for (const [id, name, dex, stage, from] of [
    ["emberling", "Emberling", EMBERLING_DEX, "Basic", null],
    ["emberdrake", "Emberdrake", EMBERDRAKE_DEX, "Stage1", "Emberling"],
  ] as const) {
    await db.query(
      `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from, card_class)
         values ($1, $2, $3, '{Fire}', $4, $5, 'standard')`,
      [id, name, [dex], stage, from],
    );
  }
  // A Trainer, to prove the no-species case on both sides.
  await db.query(
    `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, card_class)
       values ('nest-ball', 'Nest Ball', '{}', '{}', null, 'standard')`,
  );
  for (const [copyId, catalogId] of [
    [OWNED_EMBERLING, "emberling"],
    [UNLINED_EMBERDRAKE, "emberdrake"],
    [DUPLICATE_EMBERLING, "emberling"],
  ]) {
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
         values ($1, $2, $3, 'shelved', $4, 'front', 'red')`,
      [copyId, OWNER, catalogId, GEN],
    );
  }
  await db.exec(`
    insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
      values ('${LINE}', '${OWNER}', ${EMBERLING_DEX}, 'red', '${GEN}', 'back', 'open');
    insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
      values ('${SLOT_ROOT}', '${OWNER}', '${LINE}', 0, 'Basic', 'filled', '${OWNED_EMBERLING}');
    insert into line_slot (id, owner_id, line_id, stage_index, stage, state)
      values ('${SLOT_NEXT}', '${OWNER}', '${LINE}', 1, 'Stage1', 'placeholder');
    update copy set line_slot_id = '${SLOT_ROOT}', binder_half = 'back' where id = '${OWNED_EMBERLING}';
  `);
});
afterEach(async () => {
  await db.close();
});

describe("UIL-070 part 1 · the Plan's line picker agrees with the Line screen's, field for field", () => {
  it("a card with an open slot: same candidate, same binder, same counts, same natural band", async () => {
    const client = pgliteClient(db);
    const screen = await loadLineScreen(client);
    const drake = screen.unlinedCards.find((c) => c.copyId === UNLINED_EMBERDRAKE)!;
    expect(drake.joinCandidates).toHaveLength(1); // the fixture is live, not vacuous

    const pc = await loadPlanContext(client);
    const plan = lineJoinOptionsFromContext(pc, "emberdrake")!;
    expect(plan.joinCandidates).toEqual(drake.joinCandidates);
    expect(plan.existingLines).toEqual(drake.existingLines);
    expect(plan.naturalBandKey).toBe(drake.naturalBandKey);
    expect(plan.dexId).toBe(drake.dexId);
    // And the candidate is the real open slot, carrying its line's binder.
    expect(plan.joinCandidates[0]).toMatchObject({
      lineId: LINE,
      slotId: SLOT_NEXT,
      binderId: GEN,
      bandKey: "red",
      speciesLabel: "EMBERLING LINE",
      filledCount: 1,
      totalCount: 2,
    });
  });

  it("a duplicate of the filled root: no candidate on either side, and the same explanation", async () => {
    const client = pgliteClient(db);
    const screen = await loadLineScreen(client);
    const dupe = screen.unlinedCards.find((c) => c.copyId === DUPLICATE_EMBERLING)!;
    const plan = lineJoinOptionsFromContext(await loadPlanContext(client), "emberling")!;
    expect(plan.joinCandidates).toEqual([]);
    expect(dupe.joinCandidates).toEqual([]);
    expect(plan.existingLines).toEqual(dupe.existingLines);
    expect(plan.existingLines[0]).toMatchObject({
      speciesLabel: "EMBERLING LINE",
      filledCount: 1,
      totalCount: 2,
    });
  });

  it("a Trainer gets no picker at all (null), matching the Line screen never listing it as unlined", async () => {
    const client = pgliteClient(db);
    expect(lineJoinOptionsFromContext(await loadPlanContext(client), "nest-ball")).toBeNull();
    const screen = await loadLineScreen(client);
    expect(screen.unlinedCards.some((c) => c.card.tcgdexId === "nest-ball")).toBe(false);
  });

  it("an unknown printing is null rather than a throw", async () => {
    expect(
      lineJoinOptionsFromContext(await loadPlanContext(pgliteClient(db)), "no-such-card"),
    ).toBeNull();
  });
});
