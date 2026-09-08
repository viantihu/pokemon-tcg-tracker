/**
 * Placement override → copy columns + audit (dev-spec §5 M7 acceptance: "a move rewrites placement
 * + audit"). Pure translation, mirrors the shelf / collection / bulk destinations the move panel
 * offers.
 */

import { describe, expect, it } from "vitest";
import {
  describeMove,
  isMoveDestinationComplete,
  moveDecisionReason,
  placementForMove,
  type MoveNameLookups,
} from "@/lib/line/move";

const names: MoveNameLookups = {
  binderName: (id) => (id === "b1" ? "Binder 1" : id === "b2" ? "Specialty Binder A" : "Binder"),
  collectionName: (id) => (id === "c1" ? "OKUBO" : null),
  bandDisplay: (key) => (key === "red" ? "Red" : key),
};

describe("placementForMove", () => {
  it("bulk carries no shelf location and clears any line slot", () => {
    expect(placementForMove({ kind: "bulk" })).toEqual({
      role: "bulk",
      binder_id: null,
      binder_half: null,
      color_band: null,
      line_slot_id: null,
    });
  });

  it("a collection move shelves in the specialty binder with no half/band", () => {
    expect(placementForMove({ kind: "collection", binderId: "b2", collectionId: "c1" })).toEqual({
      role: "shelved",
      binder_id: "b2",
      binder_half: null,
      color_band: null,
      line_slot_id: null,
    });
  });

  it("a shelf move sets binder + half + band and clears the line slot", () => {
    expect(placementForMove({ kind: "shelf", binderId: "b1", half: "front", band: "red" })).toEqual(
      {
        role: "shelved",
        binder_id: "b1",
        binder_half: "front",
        color_band: "red",
        line_slot_id: null,
      },
    );
  });
});

describe("isMoveDestinationComplete", () => {
  it("bulk is always complete", () => {
    expect(isMoveDestinationComplete({ kind: "bulk" })).toBe(true);
  });
  it("a shelf move needs a band", () => {
    expect(
      isMoveDestinationComplete({ kind: "shelf", binderId: "b1", half: "back", band: "" }),
    ).toBe(false);
    expect(
      isMoveDestinationComplete({ kind: "shelf", binderId: "b1", half: "back", band: "red" }),
    ).toBe(true);
  });
  it("a collection move needs a collection", () => {
    expect(
      isMoveDestinationComplete({ kind: "collection", binderId: "b2", collectionId: "" }),
    ).toBe(false);
  });
});

describe("describeMove + moveDecisionReason", () => {
  it("labels a shelf destination binder · half · band", () => {
    const label = describeMove({ kind: "shelf", binderId: "b1", half: "back", band: "red" }, names);
    expect(label).toBe("Binder 1 · Back · Red");
  });

  it("labels a collection destination binder · collection", () => {
    expect(describeMove({ kind: "collection", binderId: "b2", collectionId: "c1" }, names)).toBe(
      "Specialty Binder A · OKUBO",
    );
  });

  it("the audit reason is a user override and names the destination", () => {
    const dest = { kind: "bulk" } as const;
    const reason = moveDecisionReason(dest, describeMove(dest, names));
    expect(reason).toMatch(/override/i);
    expect(reason).toMatch(/bulk box/i);
  });
});
