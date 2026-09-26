/**
 * UIL-077, both remaining Move sheets — Line screen (a filled slot, and a line-less card) and Lookup.
 * Each sheet's card is built by a pure, exported mapping (`slotMoveTarget` / `unlinedMoveTarget` /
 * `lookupMoveTarget`), because the click that builds it is not reachable from a static render. So the
 * assertion composes the REAL mapping with the REAL MoveOverlay: the number she reads on the sheet is
 * "099/182", and stays "099" when TCGdex reports no total.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CardIdentity, LineView, MoveOptions, SlotView, UnlinedCard } from "@/lib/line/types";
import type { LookupAnswer } from "@/lib/surfaces";
import { MoveOverlay, type MoveTargetCard } from "@/app/(ui)/_components/MoveOverlay";
import { slotMoveTarget, unlinedMoveTarget } from "@/app/(ui)/line/LineScreen";
import { lookupMoveTarget } from "@/app/(ui)/look/LookupScreen";

const OPTIONS: MoveOptions = {
  binders: [{ id: "b1", name: "Binder 1", type: "general" }],
  collectionsByBinder: {},
  bands: [{ key: "red", display: "Red fire" }],
};

const identity = (setCardCountOfficial: number | null): CardIdentity => ({
  tcgdexId: "sv03-099",
  name: "Charmeleon",
  setId: "sv03",
  setName: "Obsidian Flames",
  localId: "099",
  setCardCountOfficial,
  imageUrl: null,
  bandKey: "red",
});

const slot = (card: CardIdentity): SlotView => ({
  slotId: "s1",
  stageIndex: 1,
  stage: "Stage1",
  state: "filled",
  card,
  copyId: "c1",
  variant: "normal",
  priceMarket: null,
  willLiveInSpecialty: false,
  alternates: [],
  note: null,
  wedgeLabel: null,
  moveable: true,
  copyNotShelved: false,
});

const line = (s: SlotView): LineView => ({
  lineId: "L1",
  rootDexId: 4,
  speciesLabel: "CHARMANDER LINE",
  bandKey: "red",
  binderId: "b1",
  binderLabel: "BINDER 1 · BACK",
  status: "open",
  counts: { filled: 1, placeholder: 0, block: 0 },
  slots: [s],
  cap: null,
  info: [],
});

const unlined = (card: CardIdentity): UnlinedCard => ({
  copyId: "c2",
  card,
  currentLabel: "Binder 1 · Front · Red",
  dexId: 5,
  binderHalf: "front",
  naturalBandKey: "red",
  joinCandidates: [],
  existingLines: [],
});

const answer = (setCardCountOfficial: number | null): LookupAnswer => ({
  card: {
    tcgdexId: "sv03-099",
    name: "Charmeleon",
    setName: "Obsidian Flames",
    localId: "099",
    setCardCountOfficial,
    rarity: null,
    types: ["Fire"],
    stage: "Stage1",
    cardClass: "standard",
    imageUrl: null,
  },
  subtitle: "Fire · Stage1",
  bandKey: "red",
  bandDisplay: "Red fire",
  bandStack: [{ key: "red", active: true }],
  owned: true,
  ownedCount: 1,
  location: null,
  facts: [],
});

const sheet = (card: MoveTargetCard) =>
  renderToStaticMarkup(
    createElement(MoveOverlay, { card, options: OPTIONS, onConfirm: () => {}, onClose: () => {} }),
  );
const numberOn = (html: string) =>
  /<span class="no">([^<]*)<\/span>/.exec(html)?.[1]?.trim() ?? null;

describe("UIL-077 · the Line screen's Move sheet shows the full printed number", () => {
  it("for a filled slot's card: 099/182", () => {
    const s = slot(identity(182));
    const card = slotMoveTarget(line(s), s);
    expect(card).not.toBeNull();
    expect(card!.setCardCountOfficial).toBe(182); // the mapping carries it…
    expect(numberOn(sheet(card!))).toBe("099/182"); // …and the sheet renders it
  });

  it("for a line-less card offered the picker: 099/182", () => {
    const card = unlinedMoveTarget(unlined(identity(182)));
    expect(numberOn(sheet(card))).toBe("099/182");
  });

  it("falls back to the bare number when the set reports no total", () => {
    const s = slot(identity(null));
    expect(numberOn(sheet(slotMoveTarget(line(s), s)!))).toBe("099");
    expect(numberOn(sheet(unlinedMoveTarget(unlined(identity(null)))))).toBe("099");
  });

  it("a slot with no movable card yields no sheet at all", () => {
    const s: SlotView = { ...slot(identity(182)), copyId: null, state: "placeholder" };
    expect(slotMoveTarget(line(s), s)).toBeNull();
  });
});

describe("UIL-077 · Lookup's Move sheet shows the full printed number", () => {
  const copy = {
    copyId: "c3",
    role: "shelved" as const,
    currentLabel: "Binder 1 · Front · Red",
  };
  it("099/182 when the total is known, 099 when it is not", () => {
    expect(numberOn(sheet(lookupMoveTarget(answer(182), copy)))).toBe("099/182");
    expect(numberOn(sheet(lookupMoveTarget(answer(null), copy)))).toBe("099");
  });
});
