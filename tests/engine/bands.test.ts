import { describe, expect, it } from "vitest";

import {
  assertBandConfig,
  BAND_ORDER,
  band,
  bandPosition,
  DEFAULT_TYPE_COLOR_MAP,
  whiteKey,
} from "@/lib/engine/bands";
import {
  ARVEN_SV03_186,
  CHARMELEON_SV03_027,
  EEVEE_SV035_133,
  FLYGON_XY5_110,
  NEST_BALL_SV01_181,
  SCIZOR_SV03_141,
  VAPOREON_SV035_134,
} from "./fixtures";

const MAP = DEFAULT_TYPE_COLOR_MAP;

describe("bands: ordered band list", () => {
  it("has all ten bands including the empty Pink, in rainbow order with Fairy after Purple", () => {
    expect(BAND_ORDER).toEqual([
      "Red",
      "Orange",
      "Yellow",
      "Olive",
      "Green",
      "Dark blue",
      "Light blue",
      "Purple",
      "Pink",
      "White",
    ]);
    // Pink (Fairy) sits immediately after Purple.
    expect(bandPosition("Pink")).toBe(bandPosition("Purple") + 1);
    // Pink is present even though the collection owns no Fairy cards (position reserved).
    expect(BAND_ORDER).toContain("Pink");
  });
});

describe("bands: band(card) from the injected TypeColorMap", () => {
  it("maps energy types to their rainbow band", () => {
    expect(band(CHARMELEON_SV03_027, MAP)).toBe("Red"); // Fire
    expect(band(VAPOREON_SV035_134, MAP)).toBe("Light blue"); // Water
    expect(band(FLYGON_XY5_110, MAP)).toBe("Olive"); // Dragon
  });

  it("White absorbs Colorless, Metal, Trainer, Supporter and Item", () => {
    expect(band(EEVEE_SV035_133, MAP)).toBe("White"); // Colorless
    expect(band(SCIZOR_SV03_141, MAP)).toBe("White"); // Metal
    expect(band(NEST_BALL_SV01_181, MAP)).toBe("White"); // Trainer / Item
    expect(band(ARVEN_SV03_186, MAP)).toBe("White"); // Trainer / Supporter
  });

  it("falls back to White for any type not in the map", () => {
    expect(band({ types: ["Zorse"], category: "Pokemon", trainerType: null }, MAP)).toBe("White");
  });

  it("honours an injected map that differs from the default", () => {
    const custom = { ...MAP, Fire: "Orange" };
    expect(band(CHARMELEON_SV03_027, custom)).toBe("Orange");
  });
});

// The DB `type_color_map` uses band KEYS, not display names. `band()`'s fallback must land in this
// same space (UIL-012): a display-name "White" is not a color_band row and violated the FK at commit.
const DB_KEY_MAP = {
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
} as const;
const DB_BAND_KEYS = [
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

describe("bands: whiteKey / fallback resolve in the caller's own space (UIL-012)", () => {
  it("returns the map's OWN white key, never a hard-coded display constant", () => {
    expect(whiteKey(DB_KEY_MAP)).toBe("white"); // DB-key space
    expect(whiteKey(DEFAULT_TYPE_COLOR_MAP)).toBe("White"); // display-name space
  });

  it("band() falls back to the map's white key for an unmapped type — DB-key space", () => {
    const unmapped = { types: ["Zorse"], category: "Pokemon" as const, trainerType: null };
    expect(band(unmapped, DB_KEY_MAP)).toBe("white");
  });

  it("falls back to the WHITE display constant only when the map cannot resolve white at all", () => {
    // A degenerate map with no White-absorbed type — nothing to resolve white from.
    expect(whiteKey({ Fire: "red" })).toBe("White");
  });
});

describe("bands: bandPosition accepts DB keys and display names (UIL-012)", () => {
  it("scores a DB key the same as its display name", () => {
    expect(bandPosition("dark_blue")).toBe(bandPosition("Dark blue"));
    expect(bandPosition("light_blue")).toBe(bandPosition("Light blue"));
    expect(bandPosition("white")).toBe(bandPosition("White"));
  });

  it("places the DB keys in rainbow order", () => {
    expect(bandPosition("red")).toBe(0);
    expect(bandPosition("light_blue")).toBe(6);
    expect(bandPosition("white")).toBe(9);
  });

  it("still sorts a truly unknown band last", () => {
    expect(bandPosition("chartreuse")).toBe(BAND_ORDER.length);
  });
});

describe("bands: assertBandConfig catches broken config before commit (UIL-012)", () => {
  it("passes for canonical DB config", () => {
    expect(() => assertBandConfig(DB_KEY_MAP, DB_BAND_KEYS)).not.toThrow();
  });

  it("throws when color_band is empty", () => {
    expect(() => assertBandConfig(DB_KEY_MAP, [])).toThrow(/color_band has no rows/);
  });

  it("throws when type_color_map is empty", () => {
    expect(() => assertBandConfig({}, DB_BAND_KEYS)).toThrow(/type_color_map has no rows/);
  });

  it("throws naming a display-name row that color_band does not have", () => {
    // The exact UIL-012 candidate: a hand-entered "White" beside the migration's "white".
    expect(() => assertBandConfig({ ...DB_KEY_MAP, Trainer: "White" }, DB_BAND_KEYS)).toThrow(
      /Trainer → "White"/,
    );
  });
});
