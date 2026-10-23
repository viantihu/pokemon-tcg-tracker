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

  it("is UNSURE when the set name is only close to hers", () => {
    expect(standInMatch(standIn({ setName: "30th Celebrations" }), CATALOG)).toEqual({
      kind: "unsure",
      candidateIds: ["30th-015"],
    });
    expect(standInMatch(standIn({ setName: "Celebration" }), CATALOG)).toEqual({
      kind: "unsure",
      candidateIds: ["30th-015"],
    });
  });

  it("is UNSURE when the card in that set and number has another name", () => {
    expect(standInMatch(standIn({ name: "Fuecoco" }), CATALOG)).toEqual({
      kind: "unsure",
      candidateIds: ["30th-015"],
    });
  });

  it("is UNSURE when two printings fit (two sets of one name, both with the number)", () => {
    const twin = card({ tcgdexId: "30th-b-015", setId: "30th-b" });
    expect(standInMatch(standIn(), [...CATALOG, twin])).toEqual({
      kind: "unsure",
      candidateIds: ["30th-015", "30th-b-015"],
    });
  });

  it("finds NONE when TCGdex does not carry the number in any set like hers", () => {
    expect(standInMatch(standIn({ localId: "999/128" }), CATALOG)).toEqual({ kind: "none" });
    expect(standInMatch(standIn({ setName: "Obsidian Flames" }), CATALOG)).toEqual({
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
    expect(standInMatch(standIn({ setName: null }), CATALOG)).toEqual({ kind: "none" });
  });
});
