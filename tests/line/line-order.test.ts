/**
 * UIL-074 — the loader orders the Lines screen (real Postgres via PGlite, real migrations, real seeded
 * `color_band` order).
 *
 * PRE-FIX-FAILING: `evolutionLineRepo.listAll` is unordered, so until this change `loadLineScreen`
 * handed back lines in insertion order — the fixture below inserts them in an order that is wrong by
 * band, by name and by binder at once, and asserts the loader fixes all three.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { loadLineScreen } from "@/lib/line";
import { OWNER, freshRpcDb } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

// Two binders whose NAMES sort the other way round from their CREATION, so the grouping order proves
// it is creation order (the order the Move panel and Settings list them), not alphabetical.
const ZETA = "b0000000-0000-0000-0000-0000000000d1"; // created first
const ALPHA = "b0000000-0000-0000-0000-0000000000d2"; // created second
const L_ZEPHYR = "10000000-0000-0000-0000-0000000000d1";
const L_CHARCOAL = "10000000-0000-0000-0000-0000000000d2";
const L_AARDVARK = "10000000-0000-0000-0000-0000000000d3";
const L_MOTHLESS = "10000000-0000-0000-0000-0000000000d4";

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await db.query(
    `insert into binder (id, owner_id, name, type, created_at) values
       ($1, $3, 'Zeta binder', 'general', '2026-01-01T00:00:00Z'),
       ($2, $3, 'Alpha binder', 'general', '2026-06-01T00:00:00Z')`,
    [ZETA, ALPHA, OWNER],
  );
  // One Basic per fictional species; the line's own colour_band is what the sort reads.
  for (const [id, name, dex] of [
    ["aardvark", "Aardvark", 9801],
    ["charcoal", "Charcoal", 9802],
    ["mothless", "Mothless", 9803],
    ["zephyr", "Zephyr", 9804],
  ] as const) {
    await db.query(
      `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, card_class)
         values ($1, $2, $3, '{Fire}', 'Basic', 'standard')`,
      [id, name, [dex]],
    );
  }
  // Inserted in an order that is wrong on every axis: green before red, Z before A, Alpha before Zeta.
  // Each line gets its root slot (a real line always has one per stage): the strip's species label is
  // read off the slots, so a slot-less line would read as the generic "EVOLUTION LINE".
  await db.exec(`
    insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status) values
      ('${L_ZEPHYR}',   '${OWNER}', 9804, 'green', '${ALPHA}', 'back', 'open'),
      ('${L_CHARCOAL}', '${OWNER}', 9802, 'red',   '${ZETA}',  'back', 'open'),
      ('${L_AARDVARK}', '${OWNER}', 9801, 'red',   '${ALPHA}', 'back', 'open'),
      ('${L_MOTHLESS}', '${OWNER}', 9803, 'red',   null,       'back', 'open');
    insert into line_slot (owner_id, line_id, stage_index, stage, state, target_catalog_card_id) values
      ('${OWNER}', '${L_ZEPHYR}',   0, 'Basic', 'placeholder', 'zephyr'),
      ('${OWNER}', '${L_CHARCOAL}', 0, 'Basic', 'placeholder', 'charcoal'),
      ('${OWNER}', '${L_AARDVARK}', 0, 'Basic', 'placeholder', 'aardvark'),
      ('${OWNER}', '${L_MOTHLESS}', 0, 'Basic', 'placeholder', 'mothless');
  `);
});
afterEach(async () => {
  await db.close();
});

const ids = (d: { lines: { lineId: string }[] }) => d.lines.map((l) => l.lineId);

describe("UIL-074 · loadLineScreen orders the strip", () => {
  it("default: colour (seeded rainbow order) then species A to Z — NOT insertion order", async () => {
    const data = await loadLineScreen(pgliteClient(db));
    expect(data.view).toBe("color");
    // red (position 1) before green (5); within red, Aardvark < Charcoal < Mothless.
    expect(ids(data)).toEqual([L_AARDVARK, L_CHARCOAL, L_MOTHLESS, L_ZEPHYR]);
    expect(data.lines.map((l) => l.speciesLabel)).toEqual([
      "AARDVARK LINE",
      "CHARCOAL LINE",
      "MOTHLESS LINE",
      "ZEPHYR LINE",
    ]);
  });

  it("by binder: binders in creation order, colour + A–Z inside each, no-binder lines last", async () => {
    const data = await loadLineScreen(pgliteClient(db), { view: "binder" });
    expect(data.view).toBe("binder");
    // Zeta was created first → its run comes first even though "Alpha" sorts first by name.
    expect(ids(data)).toEqual([L_CHARCOAL, L_AARDVARK, L_ZEPHYR, L_MOTHLESS]);
    expect(data.lines.map((l) => l.binderLabel)).toEqual([
      "Zeta binder · BACK",
      "Alpha binder · BACK",
      "Alpha binder · BACK",
      "Binder · BACK", // no binder: the loader's generic label; the strip heads it "NO BINDER"
    ]);
  });
});
