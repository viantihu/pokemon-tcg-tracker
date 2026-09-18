/**
 * UIL-065 — a line she manually created in a band other than the card's natural one must still be
 * found by the cascade, for every future card of that species. Pre-fix, `existingLineSlot` filtered
 * `ctx.lines` on `line.colorBand !== b` where `b` is the incoming card's own type-derived band —
 * but a manually-created line's band is her free pick (UIL-056 "start a new line"), not something
 * the cascade ever derives. A line she built in a non-natural band was therefore invisible to this
 * lookup forever, silently defeating UIL-063's fix for exactly the lines she made by hand, and
 * reproducing the original "no line yet" symptom by a second, independent route.
 *
 * Key-form bands throughout (UIL-012's lesson) — the line lives in "red", the species' own natural
 * band is "olive"; the two must never be confused with each other by this test.
 */
import { describe, expect, it } from "vitest";
import { placeCard, type EngineContext } from "@/lib/engine/cascade";
import type {
  Binder,
  CatalogCard,
  Collection,
  EvolutionLine,
  IncomingCard,
} from "@/lib/engine/types";

const DRATINI_DEX = 147;
const DRAGONAIR_DEX = 148;

const MAP = { Dragon: "olive" }; // Dragon's NATURAL band — the line below deliberately lives in "red".

const dratini: CatalogCard = {
  tcgdexId: "dratini-147",
  name: "Dratini",
  dexId: [DRATINI_DEX],
  setId: "b2",
  setName: "Base Set 2",
  localId: "147",
  rarity: "Common",
  types: ["Dragon"],
  stage: "Basic",
  evolveFrom: null,
  illustrator: null,
  hp: null,
  variants: { normal: true, holo: false, reverse: false, firstEdition: false, wPromo: false },
  artworkGroupId: "art-dratini-147",
  cardClass: "standard",
  isDigitalOnly: false,
  priceLow: null,
  priceMarket: 1,
  category: "Pokemon",
  trainerType: null,
};

const dragonair: CatalogCard = {
  ...dratini,
  tcgdexId: "dragonair-148",
  name: "Dragonair",
  dexId: [DRAGONAIR_DEX],
  localId: "148",
  stage: "Stage1",
  evolveFrom: "Dratini",
  artworkGroupId: "art-dragonair-148", // distinct — see UIL-063's test for why this matters.
};

const B1: Binder = { id: "B1", name: "Binder 1", type: "general", isActive: true };

function ctx(over: Partial<EngineContext> = {}): EngineContext {
  return {
    typeColorMap: MAP,
    catalog: [dratini, dragonair],
    owned: [],
    binders: [B1],
    lines: [],
    collections: [],
    now: "2026-09-17T00:00:00.000Z",
    ...over,
  };
}

const incomingDratini = (id = "inc"): IncomingCard => ({ id, card: dratini, variant: "normal" });
const incomingDragonair = (id = "inc"): IncomingCard => ({
  id,
  card: dragonair,
  variant: "normal",
});

/** The line lives in "red" — NOT Dragon's natural "olive" — because she picked it herself. */
const redDratiniLine: EvolutionLine = {
  id: "line-dratini-red",
  rootDexId: DRATINI_DEX,
  colorBand: "red",
  binderId: "B1",
  status: "open",
  slots: [
    {
      id: "s0",
      stageIndex: 0,
      stage: "Basic",
      state: "placeholder",
      copyId: null,
      dexId: DRATINI_DEX,
      targetCatalogCardId: "dratini-147",
    },
    {
      id: "s1",
      stageIndex: 1,
      stage: "Stage1",
      state: "placeholder",
      copyId: null,
      dexId: DRAGONAIR_DEX,
      targetCatalogCardId: "dragonair-148",
    },
  ],
};

describe("UIL-065 — an existing line is matched by species alone, never band", () => {
  it("finds a manually red-banded line for an incoming Basic whose natural band is olive", () => {
    const res = placeCard(incomingDratini(), ctx({ lines: [redDratiniLine] }));

    expect(res.step).toBe("line-existing");
    expect(res.target).toMatchObject({
      kind: "back-half-line",
      band: "red", // the LINE's band, not Dratini's natural "olive"
      lineId: "line-dratini-red",
      stageIndex: 0,
    });
    expect(res.filledExistingSlot).toEqual({ lineId: "line-dratini-red", stageIndex: 0 });
    // The reason must name the line's REAL band, never a wrong one, and — since red/olive disagree —
    // must ALSO name the card's own colour: this is UIL-069's mismatch case, surfaced, not decided.
    expect(res.reason).toMatch(/red/i);
    expect(res.reason).toMatch(/olive/i);
    // UIL-069: a disagreement is never resolved silently — the other option rides along for whoever
    // presents the choice, and the line target above is NOT treated as a decided default.
    expect(res.bandMismatch).toMatchObject({
      ownColorTarget: { kind: "front-half", band: "olive" },
      lineRootDexId: DRATINI_DEX,
    });
  });

  it("also finds it for an incoming Stage1 — the bug was not Basic-specific", () => {
    const res = placeCard(incomingDragonair(), ctx({ lines: [redDratiniLine] }));

    expect(res.step).toBe("line-existing");
    expect(res.target).toMatchObject({
      kind: "back-half-line",
      band: "red",
      lineId: "line-dratini-red",
      stageIndex: 1,
    });
    expect(res.reason).toMatch(/red/i);
    // UIL-069: the mismatch ask is not Basic-specific either — a Stage1 joining a cross-band line
    // gets the same two-option offer.
    expect(res.bandMismatch).toMatchObject({
      ownColorTarget: { kind: "front-half", band: "olive" },
    });
  });

  it("a duplicate of an already-filled cross-band stage falls to the front half in its OWN natural band, not the line's", () => {
    const filledRedLine: EvolutionLine = {
      ...redDratiniLine,
      slots: [
        { ...redDratiniLine.slots[0], state: "filled", copyId: "own-dratini-1" },
        redDratiniLine.slots[1],
      ],
    };
    const res = placeCard(incomingDratini("inc-2nd"), ctx({ lines: [filledRedLine] }));

    expect(res.step).toBe("line-existing");
    // The FRONT half is not the line: a spare copy shelves by its own type-derived band (olive),
    // not the red line it cannot re-join.
    expect(res.target).toMatchObject({ kind: "front-half", band: "olive" });
    expect(res.reason).toMatch(/red/i); // still names the correct line in the explanation
    expect(res.reason).toMatch(/already holds/i);
    // UIL-069 is scoped to an OPEN slot — she cannot join a slot someone else already filled, so
    // there is nothing to ask about here regardless of the band mismatch.
    expect(res.bandMismatch).toBeFalsy();
  });

  it("STEP 1: a collection claim still sees a cross-band line's unmet need and ranks alternates in the LINE's band", () => {
    const claim: Collection = {
      id: "coll-1",
      name: "Dragon Types",
      targetCatalogCardIds: ["dratini-147"],
      currentBinderIds: ["SPEC1"],
    };
    const res = placeCard(
      incomingDratini(),
      ctx({ lines: [redDratiniLine], collections: [claim] }),
    );

    expect(res.step).toBe("collection-claim");
    expect(res.proposals?.[0]).toMatchObject({
      kind: "collection-vs-line",
      lineId: "line-dratini-red",
      stageIndex: 0,
    });
    expect(res.proposals?.[0].reason).toMatch(/red/i);
    expect(res.proposals?.[0].reason).not.toMatch(/olive/i);
    expect(res.wishlist).toHaveLength(1);
    // UIL-069 is scoped to STEP 4's placement choice — collection membership always wins here
    // regardless of band, so there is no destination to ask her about.
    expect(res.bandMismatch).toBeFalsy();
  });
});
