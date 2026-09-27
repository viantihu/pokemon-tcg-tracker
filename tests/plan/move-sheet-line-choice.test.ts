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
import { CHARMANDER_SV03_026, CHARMELEON_SV03_027 } from "../engine/fixtures";
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
    ).rejects.toThrow("That destination is incomplete");
    await nothingWritten();
  });
});
