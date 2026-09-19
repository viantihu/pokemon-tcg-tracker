/**
 * UIL-063 — a Basic must check for an existing, viable line for its own species before falling to
 * the front half. Pre-fix, `placeCard`'s STEP 4 gated ALL line lookup behind
 * `stage === "Stage1" || stage === "Stage2"`, so a Basic never read `ctx.lines` at all — the
 * "Basic with no line yet" sentence was not a verdict, it was unconditional. Karvi hit this exactly:
 * her Dratini's spotlight said "no line yet" while the Lines page showed a DRATINI LINE with two of
 * three stages already filled.
 *
 * Reproduces her real species (Dratini → Dragonair, Dragon type) and her real band (Olive) — but in
 * DB-KEY space (`Dragon: "olive"`), the only vocabulary production feeds the cascade (UIL-013 moved
 * the rest of tests/engine onto the same key-form map; see fixtures.ts). Production feeds the cascade
 * key-form bands (UIL-012's lesson: "engine tests use display bands" hid a band bug behind 374 green
 * tests) — a band-space bug here would hide the same way if this test used display-space too.
 */
import { describe, expect, it } from "vitest";
import { placeCard, type EngineContext } from "@/lib/engine/cascade";
import type {
  Binder,
  CatalogCard,
  EvolutionLine,
  IncomingCard,
  OwnedCopy,
} from "@/lib/engine/types";

const DRATINI_DEX = 147;
const DRAGONAIR_DEX = 148;

const MAP = { Dragon: "olive" }; // key-form, not "Olive" — see file header.

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
  // A distinct artwork group — inheriting Dratini's via the spread would make resolveDuplicate see
  // the incoming Dratini as a duplicate of the owned Dragonair (shared artworkGroupId), never
  // reaching STEP 4 at all.
  artworkGroupId: "art-dragonair-148",
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
    now: "2026-09-16T00:00:00.000Z",
    ...over,
  };
}

const incomingDratini = (id = "inc"): IncomingCard => ({ id, card: dratini, variant: "normal" });

describe("UIL-063 — a Basic checks for an existing line before falling to the front half", () => {
  it("routes to the existing line's open Basic slot instead of the front half (the assignment's pinned case)", () => {
    const ownedDragonair: OwnedCopy = {
      id: "own-dragonair",
      card: dragonair,
      variant: "normal",
      role: "shelved",
      binderId: "B1",
      binderHalf: "back",
      colorBand: "olive",
      lineSlotId: "s1",
    };
    const dratiniLine: EvolutionLine = {
      id: "line-dratini",
      rootDexId: DRATINI_DEX,
      colorBand: "olive",
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
          state: "filled",
          copyId: "own-dragonair",
          dexId: DRAGONAIR_DEX,
          targetCatalogCardId: "dragonair-148",
        },
      ],
    };

    const res = placeCard(
      incomingDratini(),
      ctx({ lines: [dratiniLine], owned: [ownedDragonair] }),
    );

    expect(res.step).toBe("line-existing");
    expect(res.target).toMatchObject({
      kind: "back-half-line",
      band: "olive",
      lineId: "line-dratini",
      stageIndex: 0,
    });
    expect(res.filledExistingSlot).toEqual({ lineId: "line-dratini", stageIndex: 0 });
    // The reason must be true in both worlds — it names the line, not "no line yet" (UIL-063's
    // second half of the report).
    expect(res.reason).not.toMatch(/no line/i);
    expect(res.reason).toMatch(/existing/i);
    // UIL-069: the line's band (olive) and Dratini's own natural band (olive) agree here, so there
    // is nothing to ask her about — the common case must stay silent, not offer a pointless choice.
    expect(res.bandMismatch).toBeFalsy();
  });

  it("does NOT create a new line for a Basic with no existing one — manual creation stays her call (UIL-056)", () => {
    // No line at all for Dratini/olive. Pre- and post-fix this must be identical: front half, no
    // line, no viability test run — a Basic never triggers testViability/generateSlots.
    const res = placeCard(incomingDratini(), ctx());
    expect(res.step).toBe("basic-no-line");
    expect(res.target).toMatchObject({ kind: "front-half", band: "olive" });
    expect(res.newLine ?? null).toBeNull();
  });

  it("reproduces Karvi's exact report: a SECOND Dratini when the line's Basic slot is already filled", () => {
    // Her real screenshot: Basic (Dratini) OWNED/FILLED, Stage1 (Dragonair) OPEN/HUNTING. A second
    // Dratini copy must say "already holds this stage", go to the front half — and, critically,
    // never say "no line yet", which is the sentence she actually flagged as wrong.
    const dratiniLine: EvolutionLine = {
      id: "line-dratini",
      rootDexId: DRATINI_DEX,
      colorBand: "olive",
      binderId: "B1",
      status: "open",
      slots: [
        {
          id: "s0",
          stageIndex: 0,
          stage: "Basic",
          state: "filled",
          copyId: "own-dratini-1",
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

    const res = placeCard(incomingDratini("inc-2nd"), ctx({ lines: [dratiniLine] }));

    expect(res.step).toBe("line-existing");
    expect(res.target).toMatchObject({ kind: "front-half", band: "olive" });
    expect(res.reason).not.toMatch(/no line/i);
    expect(res.reason).toMatch(/already holds/i);
  });
});
