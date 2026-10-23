/**
 * UIL-138 — her 30th Celebration Vivillon (30th-008) came from TCGdex with no Pokédex number and no "evolves from",
 * so the Haul Plan could not see her full Green Vivillon line and said "Not enough same-colour cards yet (0 same-colour
 * cards) to start a line". A printing of the same name in the same language gives it the species.
 */
import { describe, expect, it } from "vitest";
import { fillMissingSpecies } from "@/lib/catalog/species-fill";
import { placeCard, type EngineContext } from "@/lib/engine/cascade";
import { describeReason } from "@/lib/plan/assemble";
import type { CatalogCard, EvolutionLine, OwnedCopy } from "@/lib/engine/types";

const base: CatalogCard = {
  tcgdexId: "x",
  name: "x",
  dexId: [],
  setId: "s",
  setName: "S",
  localId: "1",
  rarity: "Common",
  types: ["Grass"],
  stage: "Basic",
  evolveFrom: null,
  illustrator: null,
  hp: null,
  variants: { normal: true, holo: false, reverse: false, firstEdition: false, wPromo: false },
  artworkGroupId: null,
  cardClass: "standard",
  isDigitalOnly: false,
  priceLow: null,
  priceMarket: 1,
  category: "Pokemon",
  trainerType: null,
};
const card = (over: Partial<CatalogCard> & { tcgdexId: string }): CatalogCard => ({
  ...base,
  artworkGroupId: `art-${over.tcgdexId}`,
  ...over,
});

const SCATTERBUG = card({ tcgdexId: "sv08-005", name: "Scatterbug", dexId: [664], setId: "sv08" });
const SPEWPA = card({
  tcgdexId: "me03-008",
  name: "Spewpa",
  dexId: [665],
  setId: "me03",
  stage: "Stage1",
  evolveFrom: "Scatterbug",
});
const VIVILLON = card({
  tcgdexId: "me03-009",
  name: "Vivillon",
  dexId: [666],
  setId: "me03",
  stage: "Stage2",
  evolveFrom: "Spewpa",
});
/** As TCGdex has it today: no species, no "evolves from". */
const VIVILLON_30TH = card({
  tcgdexId: "30th-008",
  name: "Vivillon",
  setId: "30th",
  localId: "008",
  stage: "Stage2",
  rarity: "Holo Rare",
});

describe("fillMissingSpecies", () => {
  it("gives an unfinished printing the species and 'evolves from' of a same-name printing", () => {
    const out = fillMissingSpecies([SCATTERBUG, SPEWPA, VIVILLON, VIVILLON_30TH]);
    expect(out[3]).toMatchObject({ dexId: [666], evolveFrom: "Spewpa" });
    // Only the unfinished card is a new object.
    expect(out.slice(0, 3)).toEqual([SCATTERBUG, SPEWPA, VIVILLON]);
    expect(out[0]).toBe(SCATTERBUG);
  });

  it("returns the same array when nothing is missing", () => {
    const cards = [SCATTERBUG, SPEWPA, VIVILLON];
    expect(fillMissingSpecies(cards)).toBe(cards);
  });

  it("reads past the mechanic in a name ('Vivillon ex' is a Vivillon)", () => {
    const ex = card({ tcgdexId: "30th-200", name: "Vivillon ex", stage: "Stage2" });
    expect(fillMissingSpecies([VIVILLON, ex])[1].dexId).toEqual([666]);
  });

  it("never borrows across languages, and leaves a name whose printings disagree alone", () => {
    const ja = card({ tcgdexId: "ja:SV1-001", name: "Vivillon", stage: "Stage2" });
    expect(fillMissingSpecies([VIVILLON, ja])[1].dexId).toEqual([]);
    const clash = card({ tcgdexId: "zz-1", name: "Vivillon", dexId: [999], stage: "Stage2" });
    expect(fillMissingSpecies([VIVILLON, clash, VIVILLON_30TH])[2].dexId).toEqual([]);
  });

  it("leaves a Trainer (no stage) alone", () => {
    const trainer = card({ tcgdexId: "30th-150", name: "Vivillon", stage: null, types: [] });
    expect(fillMissingSpecies([VIVILLON, trainer])[1].dexId).toEqual([]);
  });
});

describe("UIL-138 — the Haul Plan sees her full Vivillon line", () => {
  const owned = (id: string, c: CatalogCard, slot: string): OwnedCopy => ({
    id,
    card: c,
    variant: "normal",
    role: "shelved",
    binderId: "B1",
    binderHalf: "back",
    colorBand: "green",
    lineSlotId: slot,
  });
  const line: EvolutionLine = {
    id: "line-vivillon",
    rootDexId: 664,
    colorBand: "green",
    binderId: "B1",
    status: "closed",
    form: null,
    slots: [
      {
        id: "s0",
        stageIndex: 0,
        stage: "Basic",
        state: "filled",
        copyId: "c0",
        dexId: 664,
        targetCatalogCardId: null,
      },
      {
        id: "s1",
        stageIndex: 1,
        stage: "Stage1",
        state: "filled",
        copyId: "c1",
        dexId: 665,
        targetCatalogCardId: null,
      },
      {
        id: "s2",
        stageIndex: 2,
        stage: "Stage2",
        state: "filled",
        copyId: "c2",
        dexId: 666,
        targetCatalogCardId: VIVILLON.tcgdexId,
      },
    ],
  };
  const ctx = (catalog: CatalogCard[]): EngineContext => ({
    typeColorMap: { Grass: "green" },
    catalog,
    owned: [owned("c0", SCATTERBUG, "s0"), owned("c1", SPEWPA, "s1"), owned("c2", VIVILLON, "s2")],
    binders: [{ id: "B1", name: "Binder 1", type: "general", isActive: true }],
    lines: [line],
    collections: [],
    now: "2026-10-23T00:00:00.000Z",
  });

  it("says the line already has this stage, not 'not enough same-colour cards'", () => {
    const catalog = fillMissingSpecies([SCATTERBUG, SPEWPA, VIVILLON, VIVILLON_30TH]);
    const incoming = { id: "inc", card: catalog[3], variant: "normal" as const };
    const res = placeCard(incoming, ctx(catalog));
    expect(res.step).toBe("line-existing");
    expect(res.target).toMatchObject({ kind: "front-half", band: "green" });
    const reason = describeReason(incoming, res, {
      binderNameById: new Map([["B1", "Binder 1"]]),
      bandDisplayByKey: new Map([["green", "Green"]]),
      collectionNameById: new Map(),
      imageUrlByTcgdexId: new Map(),
    });
    expect(reason).toMatch(/line already has this stage/);
    expect(reason).not.toMatch(/Not enough same-colour/);
  });
});
