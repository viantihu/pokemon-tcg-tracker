/**
 * UIL-051 — the Lookup screen's per-copy move rows: how a copy's present home is labelled (in the Line
 * screen's own words, so the two screens cannot disagree about the same copy) and how it is handed to
 * the move picker as the destination it opens on.
 */
import { describe, expect, it } from "vitest";
import {
  copyHomeDestination,
  copyHomeLabel,
  toMovableCopy,
  type CopyHome,
  type HomeNames,
} from "@/app/(ui)/look/lookup-copies";

const NAMES: HomeNames = {
  binderName: (id) => ({ b1: "Main", sp: "Eeveelutions" })[id],
  bandDisplay: (key) => ({ red: "Red", olive: "Olive" })[key],
  collectionIn: (binderId) => (binderId === "sp" ? "coll-eevee" : null),
};

const home = (over: Partial<CopyHome>): CopyHome => ({
  id: "c1",
  role: "shelved",
  binderId: "b1",
  binderHalf: "back",
  colorBand: "red",
  lineSlotId: null,
  ...over,
});

describe("UIL-051 · a copy's present home, labelled and as a destination", () => {
  it("shelved on a general binder: Binder · Half · Band, and the picker opens there", () => {
    const c = home({});
    expect(copyHomeLabel(c, NAMES)).toBe("Main · Back · Red");
    expect(copyHomeDestination(c, NAMES)).toEqual({
      kind: "shelf",
      binderId: "b1",
      half: "back",
      band: "red",
    });
  });

  it("a copy filling a line slot says so — moving it is what vacates the slot", () => {
    const c = home({ lineSlotId: "slot-9" });
    expect(copyHomeLabel(c, NAMES)).toBe("Main · Back · Red · in a line");
    expect(copyHomeDestination(c, NAMES)?.kind).toBe("shelf");
  });

  it("shelved in a specialty binder: named by binder, opens on the collection that claims it", () => {
    const c = home({ binderId: "sp", binderHalf: null, colorBand: null });
    expect(copyHomeLabel(c, NAMES)).toBe("Eeveelutions · Specialty");
    expect(copyHomeDestination(c, NAMES)).toEqual({
      kind: "collection",
      binderId: "sp",
      collectionId: "coll-eevee",
    });
  });

  it("a specialty copy whose binder holds no collection claiming it gets no pre-selection", () => {
    const names: HomeNames = { ...NAMES, collectionIn: () => null };
    expect(copyHomeDestination(home({ binderId: "sp", binderHalf: null }), names)).toBeUndefined();
  });

  it("bulk uses the move panel's own words and opens on bulk", () => {
    const c = home({ role: "bulk", binderId: null, binderHalf: null, colorBand: null });
    expect(copyHomeLabel(c, NAMES)).toBe("Bulk box (not shelved)");
    expect(copyHomeDestination(c, NAMES)).toEqual({ kind: "bulk" });
  });

  it("in-haul is NOT the bulk box, and the picker opens on nothing (UIL-088)", () => {
    // Pre-UIL-088 an import stored this copy as `'bulk'`, so this row read "Bulk box (not shelved)" and
    // the picker opened pre-selected on bulk — a placement she never made, offered back to her as fact.
    const c = home({ role: "haul", binderId: null, binderHalf: null, colorBand: null });
    expect(copyHomeLabel(c, NAMES)).toBe("In haul (not placed yet)");
    expect(copyHomeDestination(c, NAMES)).toBeUndefined();
    // Still movable — the whole point of the row (always-movable).
    expect(toMovableCopy(c, NAMES)).toEqual({
      copyId: "c1",
      role: "haul",
      currentLabel: "In haul (not placed yet)",
      initial: undefined,
      // No presence group on this fixture, so it reads as hand-typed (UIL-089): nothing would re-create it.
      dexTracked: false,
    });
  });

  it("a binder block is named as one and has no destination — the row carries the remedy instead", () => {
    const c = home({ role: "block", binderHalf: null, colorBand: null });
    expect(copyHomeLabel(c, NAMES)).toBe("Main · binder block");
    expect(copyHomeDestination(c, NAMES)).toBeUndefined();
  });

  it("unknown names fall back rather than blanking the row", () => {
    const names: HomeNames = {
      binderName: () => undefined,
      bandDisplay: () => undefined,
      collectionIn: () => null,
    };
    expect(copyHomeLabel(home({}), names)).toBe("Binder · Back · red");
  });

  it("toMovableCopy carries the copy id the old LookupCopy dropped — the whole point of the entry", () => {
    expect(toMovableCopy(home({ id: "the-copy" }), NAMES)).toEqual({
      copyId: "the-copy",
      role: "shelved",
      currentLabel: "Main · Back · Red",
      initial: { kind: "shelf", binderId: "b1", half: "back", band: "red" },
      dexTracked: false,
    });
  });

  it("dexTracked follows the presence group, which is what makes a record Dex's (UIL-089)", () => {
    // It decides two things: whether a removal has to be REMEMBERED so the next import does not re-create
    // the card, and which of two records of one card carries the identity in a merge. A hand-typed copy is
    // in no group, so no import counts it and none will bring it back.
    expect(toMovableCopy(home({ presenceGroupId: "pg-1" }), NAMES).dexTracked).toBe(true);
    expect(toMovableCopy(home({ presenceGroupId: null }), NAMES).dexTracked).toBe(false);
    expect(toMovableCopy(home({}), NAMES).dexTracked).toBe(false); // absent reads as hand-typed
  });
});
