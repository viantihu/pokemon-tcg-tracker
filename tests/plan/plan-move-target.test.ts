/**
 * UIL-070 part 1 follow-up (QA's debt item on #222): the Plan's Move panel gets its picker from
 * `card.joinCandidates`, and this is the ONE place the Plan puts them on the card. Pinning the mapping
 * closes the chain the render tests could not reach — `openMove` runs after two awaited server actions,
 * so the component's own state is not renderable statically.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MoveOverlay } from "@/app/(ui)/_components/MoveOverlay";
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
  locale: "en",
  naturalBandKey: "red",
  joinCandidates: [],
  existingLines: [
    {
      lineId: "L2",
      speciesLabel: "CHARMANDER LINE",
      filledCount: 2,
      totalCount: 2,
      binderId: "b2",
      bandKey: "green",
      locale: "en",
    },
  ],
};
const INITIAL = { kind: "shelf", binderId: "b1", half: "front", band: "red" } as const;

describe("UIL-070 · moveTargetFor threads the line-join lookup onto the Move panel's card", () => {
  it("a lookup result — even with NO candidates — puts joinCandidates on the card, which is what turns the picker on", () => {
    const card = moveTargetFor(ITEM, JOIN, INITIAL);
    expect(card.joinCandidates).toEqual([]); // present, not undefined: the Plan's common case
    expect(card.existingLines).toEqual(JOIN.existingLines);
    expect(card.naturalBandKey).toBe("red");
  });

  it("no lookup result (Trainer, or the action failed) leaves them absent → the plain move", () => {
    const card = moveTargetFor(ITEM, null, INITIAL);
    expect(card.joinCandidates).toBeUndefined();
    expect(card.existingLines).toBeUndefined();
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

describe("a Basic with no evolutions is never a line (Karvi, 2026-09-27): the Plan's Move sheet card carries it", () => {
  it("a card whose species forms no line: formsALine false on the card, so its back half is off", () => {
    expect(moveTargetFor({ ...ITEM, formsALine: false }, JOIN, INITIAL).formsALine).toBe(false);
  });

  it("the real Move sheet then offers no line to pick at all, and her words say why", () => {
    const html = renderToStaticMarkup(
      createElement(MoveOverlay, {
        card: moveTargetFor({ ...ITEM, formsALine: false }, JOIN, INITIAL),
        options: {
          binders: [{ id: "b1", name: "Binder 1", type: "general" }],
          collectionsByBinder: {},
          bands: [{ key: "red", display: "Red" }],
        },
        onConfirm: () => {},
        onClose: () => {},
      }),
    );
    expect(html).not.toContain("Start a new line");
    expect(html).toMatch(/A Basic with no evolutions can(?:&#x27;|')t start a line\./);
    expect(/<button[^>]*>BACK HALF<\/button>/.exec(html)?.[0]).toContain("disabled");
  });

  it("a card that forms a line, or an older plan with no flag: nothing added, the back half as before", () => {
    expect(moveTargetFor({ ...ITEM, formsALine: true }, JOIN, INITIAL)).not.toHaveProperty(
      "formsALine",
    );
    expect(moveTargetFor(ITEM, JOIN, INITIAL)).not.toHaveProperty("formsALine");
  });
});
