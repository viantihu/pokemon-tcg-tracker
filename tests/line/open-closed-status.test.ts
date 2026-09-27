/**
 * UIL-121 A1 — the TS side of "a line is OPEN or CLOSED": the one status derivation every line writer uses, the one
 * reader every demote asks, and what a fill and a release now write for her stage choice (0030 checks all three).
 */
import { describe, expect, it } from "vitest";
import { lineReadsClosed, lineStatusFor, lineStatusShown } from "@/lib/line/popup";
import { buildExistingLineJoinOps, releaseSlotOps } from "@/lib/line/move";

describe("lineStatusFor · closed when every slot is filled, else open; nothing capped for her", () => {
  it("closed only when every slot holds a card", () => {
    expect(lineStatusFor(["filled", "filled"])).toBe("closed");
    expect(lineStatusFor(["filled", "placeholder"])).toBe("open");
    expect(lineStatusFor(["filled", "block"])).toBe("open");
    expect(lineStatusFor([])).toBe("open");
  });
  it("an engine cap no longer caps her line", () => {
    expect(lineStatusFor(["filled", "placeholder"], true)).toBe("open");
  });
});

describe("lineReadsClosed · the pre-0030 words read the way she means them", () => {
  it.each([
    ["closed", true],
    ["complete", true],
    ["terminated", true],
    ["open", false],
    ["capped", false],
    [null, false],
    [undefined, false],
  ])("%s → %s", (status, closed) => {
    expect(lineReadsClosed(status as string | null | undefined)).toBe(closed);
    // …and the word Lines and Lookup show for it.
    expect(lineStatusShown(status as string | null | undefined)).toBe(closed ? "closed" : "open");
  });
});

describe("a fill and a release, in stage-choice terms", () => {
  it("filling the last open slot closes the line, clears the stage's choice and closes its wish", () => {
    expect(
      buildExistingLineJoinOps({ copyId: "c", lineId: "L", slotId: "S", slotIsLastOpen: true }).ops,
    ).toEqual([
      { op: "update_slot", id: "S", patch: { state: "filled", copy_id: "c", stage_choice: null } },
      { op: "resolve_wishlist_for_slot", line_slot_id: "S" },
      { op: "update_line", id: "L", patch: { status: "closed" } },
    ]);
  });
  it("a released slot is undecided again, and a closed line it leaves reopens", () => {
    const ops = releaseSlotOps("S", "L");
    expect(ops[0]).toMatchObject({ op: "update_slot", id: "S", patch: { stage_choice: null } });
    expect(ops[1]).toEqual({ op: "update_line", id: "L", patch: { status: "open" } });
  });
});
