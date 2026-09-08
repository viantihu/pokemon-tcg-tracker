/**
 * type_color_map → stored colorBand recompute (dev-spec §5 M8 acceptance:
 * "editing type_color_map recomputes stored colorBand on affected copies").
 *
 * Pure test over `recomputeBands` with real, TCGdex-verified fixtures. DB-key band space (see
 * lib/plan/adapt.ts): the map and stored bands are keys like `red`, matching production.
 */

import { describe, expect, it } from "vitest";
import type { CatalogCard } from "@/lib/engine";
import { recomputeBands, type RecomputeCopy, type RecomputeLine } from "@/lib/surfaces";
import {
  CHARIZARD_EX_SV035_006,
  CHARMANDER_SV03_026,
  VAPOREON_SV035_134,
} from "../engine/fixtures";

// The confirmed DB-key type→band map (mirrors 0003_config.sql).
const MAP: Record<string, string> = {
  Fire: "red",
  Fighting: "orange",
  Lightning: "yellow",
  Dragon: "olive",
  Grass: "green",
  Darkness: "dark_blue",
  Water: "light_blue",
  Psychic: "purple",
  Fairy: "pink",
  Colorless: "white",
  Metal: "white",
  Trainer: "white",
  Supporter: "white",
  Item: "white",
};

const catalogById = new Map<string, CatalogCard>([
  [CHARMANDER_SV03_026.tcgdexId, CHARMANDER_SV03_026], // Fire → red
  [VAPOREON_SV035_134.tcgdexId, VAPOREON_SV035_134], // Water → light_blue
  [CHARIZARD_EX_SV035_006.tcgdexId, CHARIZARD_EX_SV035_006], // Fire, specialty
]);

describe("recomputeBands", () => {
  it("moves only the copies whose type was remapped; leaves the rest untouched", () => {
    const copies: RecomputeCopy[] = [
      { id: "c1", catalogCardId: CHARMANDER_SV03_026.tcgdexId, colorBand: "red" }, // Fire, front
      { id: "c2", catalogCardId: VAPOREON_SV035_134.tcgdexId, colorBand: "light_blue" }, // Water, front
      { id: "c3", catalogCardId: CHARIZARD_EX_SV035_006.tcgdexId, colorBand: null }, // specialty (no band)
      { id: "c4", catalogCardId: CHARMANDER_SV03_026.tcgdexId, colorBand: null }, // bulk (no band)
      { id: "c5", catalogCardId: "ghost-999", colorBand: "red" }, // catalog miss
    ];

    // Remap Fire from red → orange.
    const newMap = { ...MAP, Fire: "orange" };
    const { copyUpdates } = recomputeBands(copies, [], catalogById, newMap);

    expect(copyUpdates).toEqual([{ id: "c1", band: "orange", previous: "red" }]);
  });

  it("recomputes a back-half line's band alongside its members so they never disagree", () => {
    const lines: RecomputeLine[] = [
      { id: "l1", colorBand: "red", representativeCardId: CHARMANDER_SV03_026.tcgdexId }, // Fire line
      { id: "l2", colorBand: "light_blue", representativeCardId: VAPOREON_SV035_134.tcgdexId }, // Water line
      { id: "l3", colorBand: "red", representativeCardId: null }, // unresolvable → skipped
    ];
    const newMap = { ...MAP, Fire: "orange" };
    const { lineUpdates } = recomputeBands([], lines, catalogById, newMap);

    expect(lineUpdates).toEqual([{ id: "l1", band: "orange", previous: "red" }]);
  });

  it("is a no-op when the map is unchanged (idempotent)", () => {
    const copies: RecomputeCopy[] = [
      { id: "c1", catalogCardId: CHARMANDER_SV03_026.tcgdexId, colorBand: "red" },
      { id: "c2", catalogCardId: VAPOREON_SV035_134.tcgdexId, colorBand: "light_blue" },
    ];
    const lines: RecomputeLine[] = [
      { id: "l1", colorBand: "red", representativeCardId: CHARMANDER_SV03_026.tcgdexId },
    ];
    const { copyUpdates, lineUpdates } = recomputeBands(copies, lines, catalogById, MAP);
    expect(copyUpdates).toEqual([]);
    expect(lineUpdates).toEqual([]);
  });

  it("never assigns a band to a bulk/specialty copy even if its type is remapped", () => {
    const copies: RecomputeCopy[] = [
      { id: "spec", catalogCardId: CHARIZARD_EX_SV035_006.tcgdexId, colorBand: null }, // Fire specialty
    ];
    const { copyUpdates } = recomputeBands(copies, [], catalogById, { ...MAP, Fire: "orange" });
    expect(copyUpdates).toEqual([]);
  });
});
