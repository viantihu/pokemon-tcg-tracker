/**
 * UIL-060 Half 2 — which real card a stand-in is, once TCGdex carries it, and whether that is certain enough to
 * swap without asking her (Karvi 2026-10-22: certain swaps on its own; anything less is hers to pick).
 *
 * The case that started it: her "30th Celebration" stand-ins were made before the set was mirrored, so they carry
 * no set id, and the number she typed is the printed "15/128" where TCGdex stores "015".
 */
import { describe, expect, it } from "vitest";
import {
  collectorNumberCandidates,
  setNameKey,
  standInMatch,
  type MatchableCard,
  type StandInForMatch,
} from "@/lib/catalog/stand-in";

const UUID = "5be24283-2dae-4074-af2c-ba3114778d55";

function card(over: Partial<MatchableCard> & { tcgdexId: string }): MatchableCard {
  return {
    name: "Fuecoco ex",
    setId: "30th",
    setName: "30th Celebration",
    localId: "015",
    locale: "en",
    isDigitalOnly: false,
    setCardCount: 128,
    ...over,
  };
}

const FUECOCO = card({ tcgdexId: "30th-015" });
const FUECOCO_ALT = card({ tcgdexId: "30th-147", localId: "147" });
const ESPEON_EX = card({ tcgdexId: "30th-070", name: "Espeon ex", localId: "070" });
const CATALOG = [FUECOCO, FUECOCO_ALT, ESPEON_EX];

function standIn(over: Partial<StandInForMatch> = {}): StandInForMatch {
  return {
    tcgdexId: `user:en:${UUID}`,
    name: "Fuecoco ex",
    setId: null,
    setName: "30th Celebration",
    localId: "15/128",
    ...over,
  };
}

describe("collector numbers and set names as she types them", () => {
  it("drops the set's size from a printed number, then pads like the importer", () => {
    expect(collectorNumberCandidates("15/128")).toEqual(expect.arrayContaining(["15", "015"]));
    expect(collectorNumberCandidates(" 070 / 128 ")).toEqual(expect.arrayContaining(["070", "70"]));
    expect(collectorNumberCandidates("TG01")).toContain("TG01");
    expect(collectorNumberCandidates("/128")).toEqual([]);
  });

  it("ignores case, accents, punctuation and spacing, and reads & as and", () => {
    expect(setNameKey("  30th  Celebration ")).toBe(setNameKey("30TH CELEBRATION"));
    expect(setNameKey("Sun & Moon")).toBe("sun and moon");
    expect(setNameKey("Pokémon GO")).toBe("pokemon go");
    expect(setNameKey("Scarlet & Violet—151")).toBe("scarlet and violet 151");
    // Japanese is kept as written: a voiced mark is part of the name.
    expect(setNameKey("MEGAドリームex")).not.toBe(setNameKey("MEGAトリームex"));
  });
});

describe("standInMatch", () => {
  it("is CERTAIN for her 30th Celebration stand-ins: set name and printed number, no set id", () => {
    expect(standInMatch(standIn(), CATALOG)).toEqual({ kind: "certain", realId: "30th-015" });
    expect(standInMatch(standIn({ name: "Espeon ex", localId: "70/128" }), CATALOG)).toEqual({
      kind: "certain",
      realId: "30th-070",
    });
  });

  it("is CERTAIN by set id when the stand-in has one, whatever set name she typed", () => {
    expect(standInMatch(standIn({ setId: "30th", setName: "Thirtieth" }), CATALOG)).toEqual({
      kind: "certain",
      realId: "30th-015",
    });
  });

  it("forgives case and punctuation in the set name", () => {
    expect(standInMatch(standIn({ setName: "30TH CELEBRATION!" }), CATALOG).kind).toBe("certain");
  });

  it("is UNSURE when the set name is only close to hers, best evidence first", () => {
    expect(standInMatch(standIn({ setName: "30th Celebrations" }), CATALOG)).toEqual({
      kind: "unsure",
      // Same number first; the same card's other printing in that set after it.
      candidateIds: ["30th-015", "30th-147"],
    });
  });

  it("offers the card at her set and number when only the NAME was the typo", () => {
    const zoroark = card({ tcgdexId: "30th-123", name: "Hisuian Zoroark", localId: "123" });
    const zorua = card({ tcgdexId: "30th-122", name: "Hisuian Zorua", localId: "122" });
    const zoruaAlt = card({ tcgdexId: "30th-145", name: "Hisuian Zorua", localId: "145" });
    expect(
      standInMatch(standIn({ name: "Hisuian Zorua", localId: "123/128" }), [
        zorua,
        zoruaAlt,
        zoroark,
      ]),
    ).toEqual({ kind: "unsure", candidateIds: ["30th-122", "30th-145", "30th-123"] });
  });

  it("offers her card in the set whose printed size is after her '/' when the SET NAME was the typo", () => {
    const mewVmax = card({
      tcgdexId: "swsh8-114",
      name: "Mew VMAX",
      setId: "swsh8",
      setName: "Fusion Strike",
      localId: "114",
      setCardCount: 264,
    });
    const kangaskhan = card({ tcgdexId: "30th-114", name: "Kangaskhan", localId: "114" });
    // 30th Celebration's 128 cards contradict her "/264": Kangaskhan is never offered.
    expect(
      standInMatch(standIn({ name: "Mew VMAX", localId: "114/264" }), [kangaskhan, mewVmax]),
    ).toEqual({ kind: "unsure", candidateIds: ["swsh8-114"] });
  });

  it("is never CERTAIN when the printed size contradicts the set", () => {
    expect(standInMatch(standIn({ localId: "15/264" }), CATALOG)).toEqual({ kind: "none" });
  });

  it("is UNSURE when two printings fit (two sets of one name, both with the number)", () => {
    const twin = card({ tcgdexId: "30th-b-015", setId: "30th-b" });
    expect(standInMatch(standIn(), [...CATALOG, twin])).toEqual({
      kind: "unsure",
      candidateIds: ["30th-015", "30th-b-015", "30th-147"],
    });
  });

  it("finds NONE when only one thing she typed agrees", () => {
    // The set agrees, but neither the name nor the number.
    expect(standInMatch(standIn({ name: "Sprigatito", localId: "999/128" }), CATALOG)).toEqual({
      kind: "none",
    });
    // Name and number agree, but nothing says it is this set (no close name, no printed size).
    expect(standInMatch(standIn({ setName: "Obsidian Flames", localId: "15" }), CATALOG)).toEqual({
      kind: "none",
    });
  });

  it("never crosses languages, and never picks a digital-only or another stand-in", () => {
    const ja = standIn({ tcgdexId: `user:ja:${UUID}` });
    expect(standInMatch(ja, CATALOG)).toEqual({ kind: "none" });
    expect(standInMatch(standIn(), [card({ tcgdexId: "30th-015", isDigitalOnly: true })])).toEqual({
      kind: "none",
    });
    expect(
      standInMatch(standIn(), [card({ tcgdexId: `user:en:11111111-1111-4111-8111-111111111111` })]),
    ).toEqual({ kind: "none" });
  });

  it("finds NONE for a stand-in with no language recorded, no number, or no set at all", () => {
    expect(standInMatch(standIn({ tcgdexId: `user:${UUID}` }), CATALOG)).toEqual({ kind: "none" });
    expect(standInMatch(standIn({ localId: null }), CATALOG)).toEqual({ kind: "none" });
    expect(standInMatch(standIn({ setName: null, localId: "15" }), CATALOG)).toEqual({
      kind: "none",
    });
  });
});
