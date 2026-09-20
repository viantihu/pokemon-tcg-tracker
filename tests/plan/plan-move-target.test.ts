/**
 * UIL-070 part 1 follow-up (QA's debt item on #222): the Plan's Move panel gets its picker from
 * `card.joinCandidates`, and this is the ONE place the Plan puts them on the card. Pinning the mapping
 * closes the chain the render tests could not reach — `openMove` runs after two awaited server actions,
 * so the component's own state is not renderable statically.
 */
import { describe, expect, it } from "vitest";
import type { PlanItem } from "@/lib/plan";
import type { LineJoinOptions } from "@/lib/line/join-options";
import { moveTargetFor } from "@/app/(ui)/plan/PlanScreen";

const ITEM: PlanItem = {
  incomingId: "d-42",
  tcgdexId: "sv03-027",
  name: "Charmeleon",
  setId: "sv03",
  localId: "027",
  setCardCountOfficial: 197,
  imageUrl: "https://assets.tcgdex.net/en/sv/sv03/027",
  variant: "normal",
  stage: "Stage1",
  isBasic: false,
  bandKey: "red",
  action: "FRONT",
  destination: "Binder 1 · Front · Red",
  reason: "Front half.",
  needsDecision: false,
};
const JOIN: LineJoinOptions = {
  dexId: 5,
  naturalBandKey: "red",
  joinCandidates: [],
  existingLineByBand: { green: { speciesLabel: "CHARMANDER LINE", filledCount: 2, totalCount: 2 } },
};
const INITIAL = { kind: "shelf", binderId: "b1", half: "front", band: "red" } as const;

describe("UIL-070 · moveTargetFor threads the line-join lookup onto the Move panel's card", () => {
  it("a lookup result — even with NO candidates — puts joinCandidates on the card, which is what turns the picker on", () => {
    const card = moveTargetFor(ITEM, JOIN, INITIAL);
    expect(card.joinCandidates).toEqual([]); // present, not undefined: the Plan's common case
    expect(card.existingLineByBand).toEqual(JOIN.existingLineByBand);
    expect(card.naturalBandKey).toBe("red");
  });

  it("no lookup result (Trainer, or the action failed) leaves them absent → the plain move", () => {
    const card = moveTargetFor(ITEM, null, INITIAL);
    expect(card.joinCandidates).toBeUndefined();
    expect(card.existingLineByBand).toBeUndefined();
    expect(card.naturalBandKey).toBeUndefined();
  });

  it("carries the draft id as copyId, the full collector-number inputs, and the initial destination", () => {
    const card = moveTargetFor(ITEM, JOIN, INITIAL);
    expect(card).toMatchObject({
      copyId: "d-42",
      name: "Charmeleon",
      localId: "027",
      setCardCountOfficial: 197,
      imageUrl: ITEM.imageUrl,
      bandKey: "red",
      currentLabel: "Binder 1 · Front · Red",
      initial: INITIAL,
    });
    // A row parked before UIL-016 has no imageUrl; the card must say null, not undefined (CardFace's contract).
    expect(
      moveTargetFor({ ...ITEM, imageUrl: undefined as unknown as null }, null, undefined).imageUrl,
    ).toBeNull();
  });
});

describe("UIL-030 · moveTargetFor attaches the open block needs ONLY for a card the engine offered as a block", () => {
  const NEEDS = [
    {
      lineId: "L1",
      slotId: "S2",
      binderId: "b1",
      binderName: "Binder 1",
      speciesLabel: "CHARMANDER LINE",
      stage: "Stage2",
      bandKey: "red",
    },
  ];

  it("offered (offerBlockRepurpose true) + open needs → the card carries blockNeeds, so the panel shows its block section", () => {
    const card = moveTargetFor({ ...ITEM, offerBlockRepurpose: true }, null, INITIAL, NEEDS);
    expect(card.blockNeeds).toEqual(NEEDS);
  });

  it("NOT offered, even with open needs → no blockNeeds: a card the engine did not offer never sees the section", () => {
    expect(
      moveTargetFor({ ...ITEM, offerBlockRepurpose: false }, null, INITIAL, NEEDS).blockNeeds,
    ).toBeUndefined();
    expect(moveTargetFor(ITEM, null, INITIAL, NEEDS).blockNeeds).toBeUndefined(); // field absent = not offered
  });

  it("offered but no open needs (or none passed) → no blockNeeds either", () => {
    expect(
      moveTargetFor({ ...ITEM, offerBlockRepurpose: true }, null, INITIAL, []).blockNeeds,
    ).toBeUndefined();
    expect(
      moveTargetFor({ ...ITEM, offerBlockRepurpose: true }, null, INITIAL).blockNeeds,
    ).toBeUndefined();
  });
});
