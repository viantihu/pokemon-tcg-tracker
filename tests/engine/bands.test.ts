import { describe, expect, it } from "vitest";

import { assertBandConfig, BAND_ORDER, band, bandPosition, whiteKey } from "@/lib/engine/bands";
import {
  ARVEN_SV03_186,
  BAND_KEYS,
  CHARMELEON_SV03_027,
  EEVEE_SV035_133,
  FLYGON_XY5_110,
  KEY_FORM_TYPE_COLOR_MAP,
  NEST_BALL_SV01_181,
  SCIZOR_SV03_141,
  VAPOREON_SV035_134,
} from "./fixtures";

/**
 * Every `band()` assertion below runs on the KEY-FORM map production feeds the engine (UIL-013). The old
 * display-form default (`Fire: "Red"`) is gone: a literal "White" used as a band value was indistinguishable
 * from a correct answer under it, and that is exactly how UIL-012 shipped past a green suite.
 */
const MAP = KEY_FORM_TYPE_COLOR_MAP;

describe("bands: ordered band list", () => {
  it("has all ten bands including the empty Pink, in rainbow order with Fairy after Purple", () => {
    // BAND_ORDER is the DISPLAY-name list; it stays because the `Band` type and `bandPosition` derive
    // from it (readers in lib/engine, lib/line, lib/backfill). Display names are what it holds.
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

describe("bands: band(card) from the injected, key-form TypeColorMap", () => {
  it("maps energy types to their rainbow band KEY", () => {
    expect(band(CHARMELEON_SV03_027, MAP)).toBe("red"); // Fire
    expect(band(VAPOREON_SV035_134, MAP)).toBe("light_blue"); // Water
    expect(band(FLYGON_XY5_110, MAP)).toBe("olive"); // Dragon
  });

  it("white absorbs Colorless, Metal, Trainer, Supporter and Item — as the map's own white key", () => {
    expect(band(EEVEE_SV035_133, MAP)).toBe("white"); // Colorless
    expect(band(SCIZOR_SV03_141, MAP)).toBe("white"); // Metal
    expect(band(NEST_BALL_SV01_181, MAP)).toBe("white"); // Trainer / Item
    expect(band(ARVEN_SV03_186, MAP)).toBe("white"); // Trainer / Supporter
  });

  it("a Trainer's band is the map's own white KEY, never the display literal (UIL-012 / UIL-013)", () => {
    // The assertion that would have caught UIL-012: under a display-form map "White" and the map's white
    // were the same string, so a hard-coded literal passed. On the key-form map they differ.
    const trainer = band(ARVEN_SV03_186, MAP);
    expect(trainer).toBe(MAP.Trainer);
    expect(trainer).not.toBe("White");
    expect(BAND_KEYS).toContain(trainer); // a real color_band row, so the FK at commit holds
  });

  it("falls back to the map's white key for any type not in the map", () => {
    expect(band({ types: ["Zorse"], category: "Pokemon", trainerType: null }, MAP)).toBe("white");
  });

  it("honours an injected map that differs from the shipped rows", () => {
    const custom = { ...MAP, Fire: "orange" };
    expect(band(CHARMELEON_SV03_027, custom)).toBe("orange");
  });
});

describe("bands: whiteKey / fallback resolve in the caller's own space (UIL-012)", () => {
  it("returns the map's OWN white key, never a hard-coded display constant", () => {
    expect(whiteKey(MAP)).toBe("white"); // DB-key space
    // A hand-built display-space map resolves to ITS white — the function has no favourite vocabulary.
    expect(whiteKey({ Colorless: "White", Fire: "Red" })).toBe("White");
  });

  it("band() falls back to the map's white key for an unmapped type — DB-key space", () => {
    const unmapped = { types: ["Zorse"], category: "Pokemon" as const, trainerType: null };
    expect(band(unmapped, MAP)).toBe("white");
  });

  it("falls back to the WHITE display constant only when the map cannot resolve white at all", () => {
    // A degenerate map with no White-absorbed type — nothing to resolve white from. assertBandConfig
    // rejects such a map before the cascade ever runs in production; this is the last-resort constant.
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
    expect(() => assertBandConfig(MAP, BAND_KEYS)).not.toThrow();
  });

  it("throws when color_band is empty", () => {
    expect(() => assertBandConfig(MAP, [])).toThrow(/color_band has no rows/);
  });

  it("throws when type_color_map is empty", () => {
    expect(() => assertBandConfig({}, BAND_KEYS)).toThrow(/type_color_map has no rows/);
  });

  it("throws naming a display-name row that color_band does not have", () => {
    // The exact UIL-012 candidate: a hand-entered "White" beside the migration's "white".
    expect(() => assertBandConfig({ ...MAP, Trainer: "White" }, BAND_KEYS)).toThrow(
      /Trainer → "White"/,
    );
  });
});
