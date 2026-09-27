/**
 * UIL-117, the Senior BA's follow-up to #422: the Haul Plan's own Move sheet sends a back half through the ONE line
 * popup, as Lines, Lookup and Collections do. Its line choice rides with the back-half move (`override`), and the one
 * line builder writes it, stage choices included, whatever the cascade routed the card to. Before, the sheet's inline
 * line picker wrote the line with every unfilled stage undecided, and she was never asked.
 *
 * The REAL commit (`commitCardPlacement`), the REAL `apply_write_ops`, on PGlite, as the owner.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { clearCatalogCache, commitCardPlacement, LINE_CHOICE, type DraftItem } from "@/lib/plan";
import type { LineChoice } from "@/lib/line/popup";
import type { MoveDestination } from "@/lib/line/types";
import { KEEP_IS_NO_LINE_MOVE } from "@/lib/line/write";
import { CHARMANDER_SV03_026, CHARMELEON_SV03_027 } from "../engine/fixtures";
import { OWNER } from "../support/pglite-rpc";
import {
  asOwner,
  asSuperuser,
  freshRpcDb,
  haulRow,
  seedBinders,
  seedCatalogCardsFull,
  seedHaulRows,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const KB1 = "1c000000-0000-0000-0000-0000000000b1";
const BACK: MoveDestination = { kind: "shelf", binderId: KB1, half: "back", band: "red" };
/** Her Charmander: a Basic the cascade files in a front half (nothing to join, no line yet). */
const CMD: DraftItem = haulRow(
  "d0000000-0000-4000-8000-0000000000e1",
  CHARMANDER_SV03_026.tcgdexId,
);
/** She starts its line here and CHASES the Stage 1: a stage choice the old inline picker never asked. */
const START_CHASING: LineChoice = {
  mode: "start",
  binderId: KB1,
  band: "red",
  pulls: [],
  stages: { 1: { kind: "chase", catalogCardId: CHARMELEON_SV03_027.tcgdexId } },
};

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedCatalogCardsFull(db, [CHARMANDER_SV03_026, CHARMELEON_SV03_027]);
  await seedBinders(db, [{ id: KB1, type: "general", name: "KB-001" }]);
  await seedHaulRows(db, [CMD]);
  clearCatalogCache();
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

async function read<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  await asSuperuser(db);
  const r = await db.query<T>(sql, params);
  await asOwner(db);
  return r.rows;
}
const move = (override: MoveDestination, lineChoice: LineChoice) =>
  commitCardPlacement(pgliteClient(db), { card: CMD, override, lineChoice });
const nothingWritten = async () => {
  expect(await read(`select id from evolution_line`)).toEqual([]);
  expect(await read(`select role from copy where id = $1`, [CMD.id])).toEqual([{ role: "haul" }]);
};

describe("the Plan's Move sheet → back half → the line popup's choice is what is written", () => {
  it("her start, with the Stage 1 she chose to chase, is written by the one line builder", async () => {
    const res = await move(BACK, START_CHASING);
    expect(res.counts.lines).toBe(1);
    expect(
      await read(
        `select stage_index, state, stage_choice, target_catalog_card_id target from line_slot order by stage_index`,
      ),
    ).toEqual([
      { stage_index: 0, state: "filled", stage_choice: null, target: CHARMANDER_SV03_026.tcgdexId },
      {
        stage_index: 1,
        state: "placeholder",
        stage_choice: "chase",
        target: CHARMELEON_SV03_027.tcgdexId,
      },
    ]);
    expect(await read(`select chosen_catalog_card_id c from wishlist_item`)).toEqual([
      { c: CHARMELEON_SV03_027.tcgdexId },
    ]);
    expect(
      await read(
        `select role, binder_half, line_slot_id is not null in_slot from copy where id = $1`,
        [CMD.id],
      ),
    ).toEqual([{ role: "shelved", binder_half: "back", in_slot: true }]);
    expect(
      await read(`select decision from placement_decision where copy_id = $1`, [CMD.id]),
    ).toEqual([{ decision: "line-start" }]);
  });

  it("a stage she has not decided is refused in the shared rule's words, with nothing written", async () => {
    await expect(move(BACK, { ...START_CHASING, stages: {} })).rejects.toThrow(
      "Choose what goes in the Stage 1 slot.",
    );
    await nothingWritten();
  });

  it("a line choice with a move anywhere but a back half is refused: the screen and the server disagree", async () => {
    await expect(
      move({ kind: "shelf", binderId: KB1, half: "front", band: "red" }, START_CHASING),
    ).rejects.toThrow(LINE_CHOICE.notALineCard);
    await nothingWritten();
  });

  it("a Keep is no move into a line, and is refused", async () => {
    await expect(
      move(BACK, { mode: "replace", lineId: "L", slotId: "S", keep: true }),
    ).rejects.toThrow(KEEP_IS_NO_LINE_MOVE);
    await nothingWritten();
  });
});

describe("…and a JOIN through the Move sheet is held to the line's own slot (TL review of #434)", () => {
  const LINE = "10000000-0000-0000-0000-0000000000e1";
  const S0 = "50000000-0000-0000-0000-0000000000e0";
  const S1 = "50000000-0000-0000-0000-0000000000e1";
  const OWNED_CMD = "c0000000-0000-0000-0000-0000000000e0";
  /** Her Charmeleon, waiting in the haul. */
  const CML: DraftItem = haulRow(
    "d0000000-0000-4000-8000-0000000000e2",
    CHARMELEON_SV03_027.tcgdexId,
  );
  beforeEach(async () => {
    await seedHaulRows(db, [CML]);
    await asSuperuser(db);
    // Her Charmander line in KB-001 · Back · Red: the Basic filled, the Stage 1 an open slot.
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band) values
        ('${OWNED_CMD}', '${OWNER}', '${CHARMANDER_SV03_026.tcgdexId}', 'normal', 'shelved', '${KB1}', 'back', 'red');
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
        values ('${LINE}', '${OWNER}', 4, 'red', '${KB1}', 'back', 'open');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id, target_catalog_card_id) values
        ('${S0}', '${OWNER}', '${LINE}', 0, 'Basic', 'filled', '${OWNED_CMD}', null),
        ('${S1}', '${OWNER}', '${LINE}', 1, 'Stage1', 'placeholder', null, null);
      update copy set line_slot_id = '${S0}' where id = '${OWNED_CMD}';
    `);
    await asOwner(db);
  });
  const join = (card: DraftItem, slotId: string) =>
    commitCardPlacement(pgliteClient(db), {
      card,
      override: BACK,
      // A two-stage line her join completes: she says what fills its third pocket (UIL-121 Q4).
      lineChoice: { mode: "join", lineId: LINE, slotId, thirdPocket: { material: "empty" } },
    });

  it("an Add to the open slot of the card's stage fills it, both pointers agreeing, with a line-join decision", async () => {
    await join(CML, S1);
    expect(await read(`select state, copy_id from line_slot where id = $1`, [S1])).toEqual([
      { state: "filled", copy_id: CML.id },
    ]);
    expect(
      await read(`select role, binder_half, line_slot_id from copy where id = $1`, [CML.id]),
    ).toEqual([{ role: "shelved", binder_half: "back", line_slot_id: S1 }]);
    expect(
      await read(`select decision, line_id from placement_decision where copy_id = $1`, [CML.id]),
    ).toEqual([{ decision: "line-join", line_id: LINE }]);
  });

  it("a join naming a slot of ANOTHER species is refused, with nothing written", async () => {
    // Her Charmander (the Basic) named for the Stage 1 slot: any card can bring a line choice now, so this holds it.
    const err = await join(CMD, S1).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Error).message).toBe(
      "That slot is for a different card — pick the slot for this card's own stage.",
    );
    expect(await read(`select state, copy_id from line_slot where id = $1`, [S1])).toEqual([
      { state: "placeholder", copy_id: null },
    ]);
    expect(await read(`select role, line_slot_id from copy where id = $1`, [CMD.id])).toEqual([
      { role: "haul", line_slot_id: null },
    ]);
    expect(await read(`select id from placement_decision`)).toEqual([]);
  });

  it("…and so is a join into ANOTHER family's line at the card's own stage: the line's root is held too", async () => {
    // A Squirtle line (root 7) with an undecided Stage 1: her Charmeleon is a Stage 1, but not of this line.
    const SQUIRTLE_LINE = "10000000-0000-0000-0000-0000000000e7";
    const SQ1 = "50000000-0000-0000-0000-0000000000e7";
    await asSuperuser(db);
    await db.exec(`
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
        values ('${SQUIRTLE_LINE}', '${OWNER}', 7, 'red', '${KB1}', 'back', 'open');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id, target_catalog_card_id)
        values ('${SQ1}', '${OWNER}', '${SQUIRTLE_LINE}', 1, 'Stage1', 'placeholder', null, null);
    `);
    await asOwner(db);
    await expect(
      commitCardPlacement(pgliteClient(db), {
        card: CML,
        override: BACK,
        lineChoice: { mode: "join", lineId: SQUIRTLE_LINE, slotId: SQ1 },
      }),
    ).rejects.toThrow("That slot is for a different card");
    expect(await read(`select state from line_slot where id = $1`, [SQ1])).toEqual([
      { state: "placeholder" },
    ]);
    expect(await read(`select role from copy where id = $1`, [CML.id])).toEqual([{ role: "haul" }]);
  });
});
