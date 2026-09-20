/**
 * Placement override → copy columns + audit (dev-spec §5 M7 acceptance: "a move rewrites placement
 * + audit"). Pure translation, mirrors the shelf / collection / bulk destinations the move panel
 * offers.
 */

import { describe, expect, it } from "vitest";
import {
  defaultMoveHalf,
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
  it("a front-half shelf move needs a band, and nothing else — no line concept applies", () => {
    expect(
      isMoveDestinationComplete({ kind: "shelf", binderId: "b1", half: "front", band: "" }),
    ).toBe(false);
    expect(
      isMoveDestinationComplete({ kind: "shelf", binderId: "b1", half: "front", band: "red" }),
    ).toBe(true);
  });
  it("a back-half shelf move ALSO needs a line choice (UIL-056) — a band alone is not enough", () => {
    expect(
      isMoveDestinationComplete({ kind: "shelf", binderId: "b1", half: "back", band: "red" }),
    ).toBe(false);
    expect(
      isMoveDestinationComplete({
        kind: "shelf",
        binderId: "b1",
        half: "back",
        band: "red",
        lineJoin: { mode: "new" },
      }),
    ).toBe(true);
    expect(
      isMoveDestinationComplete({
        kind: "shelf",
        binderId: "b1",
        half: "back",
        band: "red",
        lineJoin: { mode: "existing", lineId: "l1", slotId: "s1" },
      }),
    ).toBe(true);
  });
  it("a collection move needs a collection", () => {
    expect(
      isMoveDestinationComplete({ kind: "collection", binderId: "b2", collectionId: "" }),
    ).toBe(false);
  });
});

/**
 * Regression (UIL-056): defaulting a fresh panel to "back" when it has no line picker opened the
 * Plan spotlight and Collections' move panel on a destination `isMoveDestinationComplete` can never
 * confirm — Confirm sat disabled with nothing explaining why, on the two surfaces that got the
 * back-half-needs-a-line rule "for free" without the picker that makes it satisfiable.
 */
describe("defaultMoveHalf", () => {
  it("defaults to front without the line picker — a back-half default there is a dead end", () => {
    expect(defaultMoveHalf(undefined, false)).toBe("front");
  });
  it("defaults to back WITH the line picker (the Line screen) — that is the point of that flow", () => {
    expect(defaultMoveHalf(undefined, true)).toBe("back");
  });
  it("an explicit initial shelf destination wins over the default either way", () => {
    const initial = { kind: "shelf", binderId: "b1", half: "back", band: "red" } as const;
    expect(defaultMoveHalf(initial, false)).toBe("back");
    expect(defaultMoveHalf(initial, true)).toBe("back");
  });
  it("a non-shelf initial (bulk/collection) falls back to the same allowLineJoin-based default", () => {
    expect(defaultMoveHalf({ kind: "bulk" }, false)).toBe("front");
    expect(defaultMoveHalf({ kind: "collection", binderId: "b2", collectionId: "c1" }, true)).toBe(
      "back",
    );
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

describe("UIL-030 · the block destination", () => {
  const dest = { kind: "block", lineId: "L1", slotId: "S2", binderId: "b1" } as const;
  it("places the copy as a role-'block' card in the line's binder back half, no band, no slot link", () => {
    expect(placementForMove(dest)).toEqual({
      role: "block",
      binder_id: "b1",
      binder_half: "back",
      color_band: null,
      line_slot_id: null,
    });
  });
  it("is complete only with line, slot and binder", () => {
    expect(isMoveDestinationComplete(dest)).toBe(true);
    expect(isMoveDestinationComplete({ ...dest, slotId: "" })).toBe(false);
    expect(isMoveDestinationComplete({ ...dest, binderId: "" })).toBe(false);
  });
  it("is described and audited as a binder block", () => {
    expect(describeMove(dest, names)).toBe("Binder 1 · Back · Binder block");
    expect(moveDecisionReason(dest, "Binder 1 · Back · Binder block")).toContain(
      "a reserved pocket, as a repurposed binder block",
    );
  });
});
