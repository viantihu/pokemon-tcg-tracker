/**
 * The plan state stamp (UIL-006) — what makes resuming a cached plan safe rather than merely fast.
 *
 * Her rule is "the only time the haul plan needs to reload is if there's been a change in the sync".
 * Honouring that means caching the run, and caching is only safe if the stamp reliably moves whenever
 * any cascade input does. A stamp that missed a change would silently show a plan computed against
 * state that no longer exists — worse than making her re-run. So every input gets a test, and the one
 * that a naive row-count stamp would miss (an in-place binder capacity edit) gets called out.
 */
import { describe, expect, it } from "vitest";
import { planFingerprint, type PlanFingerprintParts } from "@/lib/plan";

const BASE: PlanFingerprintParts = {
  copyCount: 685,
  pendingCopyIds: ["copy-a", "copy-b", "copy-c"],
  snapshotId: "snap-1",
  lineCount: 12,
  slotCount: 34,
  binders: [
    { id: "b1", type: "general", pages: 40, pocketsPerPage: 9, backHalfStartPage: 21 },
    { id: "b2", type: "specialty", pages: 30, pocketsPerPage: 9, backHalfStartPage: null },
  ],
  collections: [{ id: "c1", targetCount: 7 }],
  typeMap: [
    { cardType: "Fire", band: "red" },
    { cardType: "Water", band: "light_blue" },
  ],
};

const stamp = (over: Partial<PlanFingerprintParts> = {}) => planFingerprint({ ...BASE, ...over });

describe("planFingerprint is stable for unchanged state", () => {
  it("is deterministic", () => {
    expect(stamp()).toBe(stamp());
  });

  it("does not depend on the ORDER of sets it was handed", () => {
    expect(
      stamp({
        binders: [...BASE.binders].reverse(),
        typeMap: [...BASE.typeMap].reverse(),
      }),
    ).toBe(stamp());
  });

  it("DOES depend on the order of the pending queue — the plan's rows are worked in it", () => {
    expect(stamp({ pendingCopyIds: ["copy-c", "copy-b", "copy-a"] })).not.toBe(stamp());
  });
});

describe("planFingerprint moves when a cascade input moves", () => {
  const cases: [string, Partial<PlanFingerprintParts>][] = [
    ["a haul commit or sync add/retire changes the copy count", { copyCount: 686 }],
    ["the pending queue gains a card", { pendingCopyIds: [...BASE.pendingCopyIds, "copy-d"] }],
    ["the pending queue loses a card", { pendingCopyIds: ["copy-a", "copy-b"] }],
    ["a sync apply overwrites the undo snapshot", { snapshotId: "snap-2" }],
    ["an undo consumes the snapshot", { snapshotId: null }],
    ["a line is created", { lineCount: 13 }],
    ["a slot is filled or added", { slotCount: 35 }],
    [
      "a binder is added",
      {
        binders: [
          ...BASE.binders,
          { id: "b3", type: "general", pages: 20, pocketsPerPage: 9, backHalfStartPage: 11 },
        ],
      },
    ],
    ["a binder is deleted", { binders: [BASE.binders[0]] }],
    ["a collection's membership changes", { collections: [{ id: "c1", targetCount: 8 }] }],
    ["a collection is added", { collections: [...BASE.collections, { id: "c2", targetCount: 1 }] }],
    [
      "a type is remapped to another band",
      { typeMap: [{ cardType: "Fire", band: "orange" }, BASE.typeMap[1]] },
    ],
  ];

  for (const [label, over] of cases) {
    it(label, () => {
      expect(stamp(over)).not.toBe(stamp());
    });
  }

  /**
   * The case that justifies carrying whole binder rows rather than a count. Editing a binder's pages,
   * pockets or divider changes capacity — which steers front-half suggestion and new-line assignment —
   * without changing how many binders exist.
   */
  it("an IN-PLACE binder capacity edit, which a row count would miss entirely", () => {
    const countUnchanged = { ...BASE.binders[0], pages: 60 };
    const edited = stamp({ binders: [countUnchanged, BASE.binders[1]] });
    expect(edited).not.toBe(stamp());
    // Same number of binders — a count-based stamp would have called this unchanged.
    expect(BASE.binders.length).toBe(2);
  });

  it("a divider edit alone, same page and pocket counts", () => {
    const redivided = { ...BASE.binders[0], backHalfStartPage: 11 };
    expect(stamp({ binders: [redivided, BASE.binders[1]] })).not.toBe(stamp());
  });

  it("clearing a divider (the UIL-001 zero-back-half case) also moves it", () => {
    const noDivider = { ...BASE.binders[0], backHalfStartPage: null };
    expect(stamp({ binders: [noDivider, BASE.binders[1]] })).not.toBe(stamp());
  });
});

describe("planFingerprint edge shapes", () => {
  it("handles an empty everything without collapsing distinct states together", () => {
    const empty = planFingerprint({
      copyCount: 0,
      pendingCopyIds: [],
      snapshotId: null,
      lineCount: 0,
      slotCount: 0,
      binders: [],
      collections: [],
      typeMap: [],
    });
    expect(empty).toContain('"v":1');
    expect(empty).not.toBe(stamp());
  });

  it("does not confuse a null divider with a zero divider", () => {
    const a = stamp({
      binders: [
        { id: "b1", type: "general", pages: 40, pocketsPerPage: 9, backHalfStartPage: null },
      ],
    });
    const b = stamp({
      binders: [{ id: "b1", type: "general", pages: 40, pocketsPerPage: 9, backHalfStartPage: 0 }],
    });
    expect(a).not.toBe(b);
  });

  it("distinguishes a queue of one from a queue whose single id contains the separator", () => {
    expect(stamp({ pendingCopyIds: ["a|b"] })).not.toBe(stamp({ pendingCopyIds: ["a", "b"] }));
  });
});
