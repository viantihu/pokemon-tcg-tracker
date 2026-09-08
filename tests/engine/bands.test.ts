import { describe, expect, it } from "vitest";

import { BAND_ORDER, band, bandPosition, DEFAULT_TYPE_COLOR_MAP } from "@/lib/engine/bands";
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
