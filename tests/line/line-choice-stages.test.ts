/**
 * UIL-121 A2b — the one line builder takes HER choice for every stage a new line leaves unfilled, and for a complete
 * short line's third pocket, through the real `applyMove` on real Postgres (PGlite, every migration, 0030/0032's
 * rules included), as the owner. Karvi, 2026-09-27: nothing is written for her.
 *
 *   START  each unfilled stage is written as she chose (a chase, left empty, a filler, a placeholder card of her
 *          own); a missing choice is refused with the stage named and nothing written; the line reads closed once
 *          no stage waits; a complete two-card line asks its third pocket.
 *   JOIN   a card joining a stage that held a filler takes its pocket (the filler comes out, a spare card back to
 *          bulk); completing a short line asks its pocket once, never again once she has said.
 *   OLDER  a Move's `lineJoin` "new line" (no popup) writes the other stages UNDECIDED: no block, no card, no wish.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyMove, type MoveNameLookups } from "@/lib/line";
import type { LineChoice, StageDecision } from "@/lib/line/popup";
import { loadLinePopupModel } from "@/lib/line/popup-load";
import { asOwner, asSuperuser, freshRpcDb, OWNER, seedBinders } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";
import { clearCatalogCache } from "@/lib/plan/catalog-cache";

const GEN = "b0000000-0000-4000-8000-0000000121b2";
const MOVING = "c0000000-0000-4000-8000-0000000121b1";
const SPARE = "c0000000-0000-4000-8000-0000000121b2";
const LINE = "10000000-0000-4000-8000-0000000121b2";
const [SL0, SL1] = ["20000000-0000-4000-8000-0000000121b0", "20000000-0000-4000-8000-0000000121b1"];
const names: MoveNameLookups = {
  binderName: () => "KB-001",
  collectionName: () => null,
  bandDisplay: (k) => k,
};

let db: PGlite;
afterEach(async () => {
  if (db && !db.closed) await db.close();
});

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  await asSuperuser(db);
  return (await db.query<T>(sql, params)).rows;
}
async function copy(id: string, card: string, role = "shelved") {
  await q(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
       values ($1, $2, $3, $4, $5, $6, $7)`,
    role === "shelved"
      ? [id, OWNER, card, role, GEN, "front", "red"]
      : [id, OWNER, card, role, null, null, null],
  );
}
const move = async (choice: LineChoice | null, lineJoin?: { mode: "new" }) => {
  await asOwner(db);
  return applyMove(
    pgliteClient(db),
    {
      copyId: MOVING,
      destination: {
        kind: "shelf",
        binderId: GEN,
        half: "back",
        band: "red",
        ...(lineJoin ? { lineJoin } : {}),
      },
      ...(choice ? { lineChoice: choice } : {}),
    },
    names,
  );
};
const start = (over: Partial<Extract<LineChoice, { mode: "start" }>> = {}): LineChoice => ({
  mode: "start",
  binderId: GEN,
  band: "red",
  pulls: [],
  stages: {},
  ...over,
});
const slotRows = () =>
  q<{ stage_index: number; state: string; stage_choice: string | null; target: string | null }>(
    `select stage_index, state, stage_choice, target_catalog_card_id as target from line_slot order by stage_index`,
  );

beforeEach(async () => {
  db = await freshRpcDb();
  // Every catalog loader reads through the shared cache (module state): each fresh database starts it cold.
  clearCatalogCache();
  await seedBinders(db, [{ id: GEN, type: "general", name: "KB-001" }]);
  await q(
    `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from, card_class, set_name, local_id) values
       ('emberling', 'Emberling', '{9301}', '{Fire}', 'Basic', null, 'standard', 'S', '1'),
       ('emberdrake', 'Emberdrake', '{9302}', '{Fire}', 'Stage1', 'Emberling', 'standard', 'S', '2'),
       ('emberlord', 'Emberlord', '{9303}', '{Fire}', 'Stage2', 'Emberdrake', 'standard', 'S', '3')`,
  );
});

describe("START · every stage the line leaves unfilled is hers to decide", () => {
  beforeEach(async () => {
    await copy(MOVING, "emberdrake"); // the Stage 1 starts a three-stage line
  });

  it("a chase and an empty: the chase is on her wishlist, the empty is not, and the line reads open", async () => {
    await move(
      start({ stages: { 0: { kind: "empty" }, 2: { kind: "chase", catalogCardId: "emberlord" } } }),
    );
    expect(await slotRows()).toEqual([
      { stage_index: 0, state: "placeholder", stage_choice: "empty", target: null },
      { stage_index: 1, state: "filled", stage_choice: null, target: "emberdrake" },
      { stage_index: 2, state: "placeholder", stage_choice: "chase", target: "emberlord" },
    ]);
    expect(
      await q(`select chosen_catalog_card_id from wishlist_item where resolved_at is null`),
    ).toEqual([{ chosen_catalog_card_id: "emberlord" }]);
    expect(await q(`select status from evolution_line`)).toEqual([{ status: "open" }]);
  });

  it("every other stage left empty or given a filler: the line reads closed, and nothing is on her wishlist", async () => {
    await move(
      start({
        stages: { 0: { kind: "empty" }, 2: { kind: "filler", filler: { material: "energy" } } },
      }),
    );
    expect(await q(`select status from evolution_line`)).toEqual([{ status: "closed" }]);
    expect(await q(`select count(*)::int n from wishlist_item`)).toEqual([{ n: 0 }]);
    expect(
      await q(`select material, line_slot_id is not null as on_slot from binder_block`),
    ).toEqual([{ material: "basicEnergy", on_slot: true }]);
  });

  it("a placeholder card she makes: a catalog-only stand-in for that stage, chased, with no copy", async () => {
    await move(
      start({
        stages: {
          0: { kind: "empty" },
          2: {
            kind: "chase",
            newStandIn: { name: "Emberlord ex", setName: "Promo", localId: "P1", language: "en" },
          },
        },
      }),
    );
    const [si] = await q<{ tcgdex_id: string; dex_id: number[]; stage: string }>(
      `select tcgdex_id, dex_id, stage from catalog_card where source = 'user'`,
    );
    expect(si).toMatchObject({ dex_id: [9303], stage: "Stage2" });
    expect((await slotRows())[2]).toMatchObject({ stage_choice: "chase", target: si.tcgdex_id });
    expect(
      await q(`select count(*)::int n from copy where catalog_card_id = $1`, [si.tcgdex_id]),
    ).toEqual([{ n: 0 }]);
  });

  it("'Decide later' on a START writes nothing for that stage: open, not decided, and the line reads open (QA's Z3)", async () => {
    await move(start({ stages: { 0: { kind: "later" }, 2: { kind: "empty" } } }));
    expect(await slotRows()).toEqual([
      { stage_index: 0, state: "placeholder", stage_choice: null, target: null },
      { stage_index: 1, state: "filled", stage_choice: null, target: "emberdrake" },
      { stage_index: 2, state: "placeholder", stage_choice: "empty", target: null },
    ]);
    expect(await q(`select status from evolution_line`)).toEqual([{ status: "open" }]);
    expect(await q(`select count(*)::int n from wishlist_item`)).toEqual([{ n: 0 }]);
  });

  it("one spare card cannot fill two pockets: the second is refused and nothing is written", async () => {
    await copy(SPARE, "emberling", "bulk");
    await expect(
      move(
        start({
          stages: {
            0: { kind: "filler", filler: { material: "card", copyId: SPARE } },
            2: { kind: "filler", filler: { material: "card", copyId: SPARE } },
          },
        }),
      ),
    ).rejects.toThrow("That card is already filling another pocket.");
    expect(await q(`select count(*)::int n from evolution_line`)).toEqual([{ n: 0 }]);
    expect(await q(`select role from copy where id = $1`, [SPARE])).toEqual([{ role: "bulk" }]);
  });

  it("a stage with no choice is refused, the stage named, and nothing is written", async () => {
    await expect(move(start({ stages: { 0: { kind: "empty" } } }))).rejects.toThrow(
      "Choose what goes in the Stage 2 slot.",
    );
    expect(await q(`select count(*)::int n from evolution_line`)).toEqual([{ n: 0 }]);
    expect(await q(`select binder_half from copy where id = $1`, [MOVING])).toEqual([
      { binder_half: "front" },
    ]);
  });
});

describe("START · a stage whose card is still in her haul is not asked about yet (Karvi's ruling)", () => {
  beforeEach(async () => {
    await copy(MOVING, "emberdrake");
    await copy(SPARE, "emberling", "haul"); // her Emberling is waiting in this haul
  });

  it("the popup shows it as coming in this haul, and asks only about the Stage 2", async () => {
    await asOwner(db);
    // The screen (the Haul Plan) names the haul copies it routes to this same line; only those are coming.
    const m = await loadLinePopupModel(
      pgliteClient(db),
      MOVING,
      { kind: "start", binderId: GEN, band: "red" },
      { comingCopyIds: [SPARE] },
    );
    expect(m.stages.map((st) => [st.stage, st.state])).toEqual([
      ["Basic", "coming"],
      ["Stage1", "incoming"],
      ["Stage2", "wanted"],
    ]);
    expect(m.stages[0].coming).toEqual({ copyId: SPARE });
  });

  it("a start that decides only the Stage 2 is accepted; the Basic stays open and undecided for its card", async () => {
    await move(start({ stages: { 2: { kind: "empty" } }, comingCopyIds: [SPARE] }));
    expect((await slotRows())[0]).toEqual({
      stage_index: 0,
      state: "placeholder",
      stage_choice: null,
      target: null,
    });
    expect(await q(`select status from evolution_line`)).toEqual([{ status: "open" }]);
  });
});

describe("the popup's model of an EXISTING line never shows an engine's stored card as her chase", () => {
  it("an undecided stage with a stored target shows no card and says it is not decided", async () => {
    await copy(MOVING, "emberdrake");
    await q(
      `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
         values ($1, $2, 9301, 'red', $3, 'back', 'open')`,
      [LINE, OWNER, GEN],
    );
    await q(
      `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, target_catalog_card_id) values
         ($1, $3, $4, 0, 'Basic', 'placeholder', 'emberling'),
         ($2, $3, $4, 1, 'Stage1', 'placeholder', null)`,
      [SL0, SL1, OWNER, LINE],
    );
    await asOwner(db);
    const m = await loadLinePopupModel(pgliteClient(db), MOVING, {
      kind: "add",
      lineId: LINE,
      slotId: SL1,
    });
    expect(m.stages[0]).toMatchObject({ state: "wanted", card: null, choice: null });
  });
});

describe("START · a complete two-card line asks what fills its third pocket", () => {
  beforeEach(async () => {
    await q(`delete from catalog_card where tcgdex_id = 'emberlord'`); // a two-stage family
    await copy(SPARE, "emberling"); // she owns the Basic, and ticks it
    await copy(MOVING, "emberdrake");
  });

  it("'Decide later' for the pocket leaves it undecided: nothing recorded, no filler", async () => {
    await move(start({ pulls: [SPARE], thirdPocket: { material: "later" } }));
    expect(await q(`select status, extra_pocket from evolution_line`)).toEqual([
      { status: "closed", extra_pocket: null },
    ]);
    expect(await q(`select count(*)::int n from binder_block`)).toEqual([{ n: 0 }]);
  });

  it("without her answer it is refused; with it, the pocket is recorded and its filler written", async () => {
    await expect(move(start({ pulls: [SPARE] }))).rejects.toThrow(
      "Choose what fills the third pocket.",
    );
    expect(await q(`select count(*)::int n from evolution_line`)).toEqual([{ n: 0 }]);
    await move(start({ pulls: [SPARE], thirdPocket: { material: "energy" } }));
    expect(await q(`select status, extra_pocket from evolution_line`)).toEqual([
      { status: "closed", extra_pocket: "energy" },
    ]);
    expect(await q(`select line_slot_id from binder_block`)).toEqual([{ line_slot_id: null }]);
  });
});

describe("JOIN · a stage that held a filler, and the third pocket once", () => {
  beforeEach(async () => {
    await q(`delete from catalog_card where tcgdex_id = 'emberlord'`);
    await q(
      `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
         values ($1, $2, 9301, 'red', $3, 'back', 'closed')`,
      [LINE, OWNER, GEN],
    );
    // Stage 0 holds her Emberling; stage 1's pocket holds a spare card as its filler.
    await copy("c0000000-0000-4000-8000-0000000121c0", "emberling");
    await q(
      `update copy set binder_half = 'back' where id = 'c0000000-0000-4000-8000-0000000121c0'`,
    );
    await q(
      `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id, stage_choice) values
         ($1, $3, $4, 0, 'Basic', 'filled', 'c0000000-0000-4000-8000-0000000121c0', null),
         ($2, $3, $4, 1, 'Stage1', 'block', null, 'filler')`,
      [SL0, SL1, OWNER, LINE],
    );
    await q(`update copy set line_slot_id = $1 where id = 'c0000000-0000-4000-8000-0000000121c0'`, [
      SL0,
    ]);
    await q(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half) values ($1, $2, 'emberling', 'block', $3, 'back')`,
      [SPARE, OWNER, GEN],
    );
    await q(
      `insert into binder_block (owner_id, binder_id, half, pocket_count, purpose, material, copy_id, line_id, line_slot_id)
         values ($1, $2, 'back', 1, 'line-filler', 'repurposedDuplicate', $3, $4, $5)`,
      [OWNER, GEN, SPARE, LINE, SL1],
    );
    await copy(MOVING, "emberdrake");
  });

  it("the card takes the filler's pocket: the filler block comes out, the spare card back to bulk, the pocket asked", async () => {
    await move({ mode: "join", lineId: LINE, slotId: SL1, thirdPocket: { material: "empty" } });
    expect(await q(`select state, copy_id from line_slot where id = $1`, [SL1])).toEqual([
      { state: "filled", copy_id: MOVING },
    ]);
    expect(await q(`select count(*)::int n from binder_block`)).toEqual([{ n: 0 }]);
    expect(await q(`select role, binder_id from copy where id = $1`, [SPARE])).toEqual([
      { role: "bulk", binder_id: null },
    ]);
    expect(await q(`select extra_pocket from evolution_line where id = $1`, [LINE])).toEqual([
      { extra_pocket: "empty" },
    ]);
  });

  it("a line whose pocket she already chose does not ask again, and a second answer is refused", async () => {
    await q(`update evolution_line set extra_pocket = 'empty' where id = $1`, [LINE]);
    await expect(
      move({ mode: "join", lineId: LINE, slotId: SL1, thirdPocket: { material: "energy" } }),
    ).rejects.toThrow("This line has no third pocket to fill.");
    await move({ mode: "join", lineId: LINE, slotId: SL1 });
    expect(await q(`select extra_pocket from evolution_line where id = $1`, [LINE])).toEqual([
      { extra_pocket: "empty" },
    ]);
  });
});

describe("JOIN / SWAP · the last card she has for a line asks about its other open stages (Karvi's ruling)", () => {
  const S2 = "20000000-0000-4000-8000-0000000121b3";
  /** An open line: her Emberling in the Basic, the Stage 1 and Stage 2 open and not decided. */
  beforeEach(async () => {
    await q(
      `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
         values ($1, $2, 9301, 'red', $3, 'back', 'open')`,
      [LINE, OWNER, GEN],
    );
    await copy("c0000000-0000-4000-8000-0000000121c0", "emberling");
    await q(
      `update copy set binder_half = 'back' where id = 'c0000000-0000-4000-8000-0000000121c0'`,
    );
    await q(
      `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id) values
         ($1, $4, $5, 0, 'Basic', 'filled', 'c0000000-0000-4000-8000-0000000121c0'),
         ($2, $4, $5, 1, 'Stage1', 'placeholder', null),
         ($3, $4, $5, 2, 'Stage2', 'placeholder', null)`,
      [SL0, SL1, S2, OWNER, LINE],
    );
    await q(`update copy set line_slot_id = $1 where id = 'c0000000-0000-4000-8000-0000000121c0'`, [
      SL0,
    ]);
    await copy(MOVING, "emberdrake", "haul"); // her Stage 1, the last card she has for the line
  });

  it("without her answer for the Stage 2 it is refused and nothing is written; nothing is chosen for her", async () => {
    await expect(move({ mode: "join", lineId: LINE, slotId: SL1 })).rejects.toThrow(
      "Choose what goes in the Stage 2 slot.",
    );
    expect(await q(`select state, stage_choice from line_slot where id = $1`, [S2])).toEqual([
      { state: "placeholder", stage_choice: null },
    ]);
    expect(await q(`select state from line_slot where id = $1`, [SL1])).toEqual([
      { state: "placeholder" },
    ]);
  });

  it("her chase is written with the card; 'Decide later' writes nothing for it and the line stays open", async () => {
    await move({ mode: "join", lineId: LINE, slotId: SL1, stages: { 2: { kind: "later" } } });
    expect(
      await q(`select state, stage_choice, target_catalog_card_id t from line_slot where id = $1`, [
        S2,
      ]),
    ).toEqual([{ state: "placeholder", stage_choice: null, t: null }]);
    expect(await q(`select status from evolution_line where id = $1`, [LINE])).toEqual([
      { status: "open" },
    ]);
    expect(await q(`select count(*)::int n from wishlist_item`)).toEqual([{ n: 0 }]);
  });

  it("a chase answer is her wishlist add", async () => {
    await move({
      mode: "join",
      lineId: LINE,
      slotId: SL1,
      stages: { 2: { kind: "chase", catalogCardId: "emberlord" } },
    });
    expect(
      await q(`select stage_choice, target_catalog_card_id t from line_slot where id = $1`, [S2]),
    ).toEqual([{ stage_choice: "chase", t: "emberlord" }]);
  });

  it("with another card for the line still in the haul, this one asks nothing: the last one asks (condition 1)", async () => {
    await copy(SPARE, "emberlord", "haul"); // her Stage 2 is waiting too, and the screen routes it to this line
    await move({ mode: "join", lineId: LINE, slotId: SL1, comingCopyIds: [SPARE] });
    expect(await q(`select state, stage_choice from line_slot where id = $1`, [S2])).toEqual([
      { state: "placeholder", stage_choice: null },
    ]);
  });

  it("a SWAP places her card too, so it asks the same", async () => {
    // Put a card in the Stage 1 to swap out: a second Emberdrake, shelved there.
    await q(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band, line_slot_id)
         values ('c0000000-0000-4000-8000-0000000121c9', $1, 'emberdrake', 'shelved', $2, 'back', 'red', null)`,
      [OWNER, GEN],
    );
    await q(
      `update line_slot set state = 'filled', copy_id = 'c0000000-0000-4000-8000-0000000121c9' where id = $1`,
      [SL1],
    );
    await q(`update copy set line_slot_id = $1 where id = 'c0000000-0000-4000-8000-0000000121c9'`, [
      SL1,
    ]);
    const swap: LineChoice = {
      mode: "replace",
      lineId: LINE,
      slotId: SL1,
      keep: false,
      outgoing: { kind: "bulk" },
    };
    await expect(move(swap)).rejects.toThrow("Choose what goes in the Stage 2 slot.");
    await move({ ...swap, stages: { 2: { kind: "empty" } } } as LineChoice);
    expect(await q(`select stage_choice from line_slot where id = $1`, [S2])).toEqual([
      { stage_choice: "empty" },
    ]);
  });
});

describe("a haul card counts as coming only when the screen routes it to THIS line (QA's hold on #430)", () => {
  it("the same species waiting for ANOTHER line does not suppress this line's ask", async () => {
    await copy(MOVING, "emberdrake");
    await copy(SPARE, "emberling", "haul"); // an Emberling in the haul, routed elsewhere (not named)
    await expect(move(start())).rejects.toThrow("Choose what goes in the Basic slot.");
    await asOwner(db);
    const m = await loadLinePopupModel(pgliteClient(db), MOVING, {
      kind: "start",
      binderId: GEN,
      band: "red",
    });
    expect(m.stages[0].state).toBe("wanted");
  });
});

describe("the Senior BA's case: Basic + Stage 1 in the haul, Stage 2 missing", () => {
  it("the Basic's start asks nothing; the Stage 1's join, the last card, asks about the Stage 2 only", async () => {
    await copy(MOVING, "emberling", "haul");
    await copy(SPARE, "emberdrake", "haul");
    // The Basic: another card for the line (the Stage 1, which the screen routes here) waits, so nothing is asked.
    await move(start({ comingCopyIds: [SPARE] }));
    const [line] = await q<{ id: string }>(`select id from evolution_line`);
    const slots = await q<{ id: string; stage_index: number; stage_choice: string | null }>(
      `select id, stage_index, stage_choice from line_slot order by stage_index`,
    );
    expect(slots.map((s) => s.stage_choice)).toEqual([null, null, null]);
    await asOwner(db);
    const join = (stages?: Record<number, StageDecision>) =>
      applyMove(
        pgliteClient(db),
        {
          copyId: SPARE,
          destination: { kind: "shelf", binderId: GEN, half: "back", band: "red" },
          lineChoice: {
            mode: "join",
            lineId: line.id,
            slotId: slots[1].id,
            ...(stages ? { stages } : {}),
          },
        },
        names,
      );
    await expect(join()).rejects.toThrow("Choose what goes in the Stage 2 slot.");
    await join({ 2: { kind: "empty" } });
    expect(
      (
        await q<{ stage_choice: string | null }>(
          `select stage_choice from line_slot order by stage_index`,
        )
      ).map((s) => s.stage_choice),
    ).toEqual([null, null, "empty"]);
  });
});

describe("OLDER requests (a Move's lineJoin, no popup) write nothing for her", () => {
  it("the other stages are open and undecided: no block, no card, no wish", async () => {
    await copy(MOVING, "emberdrake");
    await move(null, { mode: "new" });
    expect(await slotRows()).toEqual([
      { stage_index: 0, state: "placeholder", stage_choice: null, target: null },
      { stage_index: 1, state: "filled", stage_choice: null, target: "emberdrake" },
      { stage_index: 2, state: "placeholder", stage_choice: null, target: null },
    ]);
    expect(await q(`select count(*)::int n from binder_block`)).toEqual([{ n: 0 }]);
    expect(await q(`select count(*)::int n from wishlist_item`)).toEqual([{ n: 0 }]);
    expect(await q(`select status from evolution_line`)).toEqual([{ status: "open" }]);
  });
});
