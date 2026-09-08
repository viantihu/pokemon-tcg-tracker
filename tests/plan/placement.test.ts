/**
 * Cascade target → stored copy placement (dev-spec §5 M6; system-design §4 Copy). Smoke coverage
 * for the columns the commit writes per card.
 */

import { describe, expect, it } from "vitest";
import type { Band } from "@/lib/engine";
import { copyPlacementFromTarget } from "@/lib/plan";

// In production the engine runs in DB-key band space (see adapt.ts): a DB key like "red" flows
// through the `Band`-typed field via a cast. The tests mirror that.
const dbBand = (key: string) => key as Band;

describe("copyPlacementFromTarget", () => {
  it("bulk copies carry no shelf location", () => {
    expect(copyPlacementFromTarget({ kind: "bulk" })).toEqual({
      role: "bulk",
      binderId: null,
      binderHalf: null,
      colorBand: null,
    });
  });

  it("specialty copies sit in a specialty binder with no half or band", () => {
    expect(
      copyPlacementFromTarget({ kind: "specialty", binderId: "spec1", collectionId: "coll1" }),
    ).toEqual({ role: "shelved", binderId: "spec1", binderHalf: null, colorBand: null });
  });

  it("front-half copies carry binder + front + band", () => {
    expect(
      copyPlacementFromTarget({ kind: "front-half", binderId: "b1", band: dbBand("red") }),
    ).toEqual({
      role: "shelved",
      binderId: "b1",
      binderHalf: "front",
      colorBand: "red",
    });
  });

  it("back-half line copies carry binder + back + band", () => {
    expect(
      copyPlacementFromTarget({
        kind: "back-half-line",
        binderId: "b1",
        band: dbBand("dark_blue"),
        lineId: "L1",
        stageIndex: 1,
      }),
    ).toEqual({ role: "shelved", binderId: "b1", binderHalf: "back", colorBand: "dark_blue" });
  });
});
