/**
 * UIL-121 — the printings she can chase for a stage, and the one suggested. Karvi: suggest "the cheapest same-colour,
 * same-language printing, else the special one", never selected; she can pick any printing of the species in the
 * LINE's language (Q2), same colour first.
 */
import { describe, expect, it } from "vitest";
import { stageOptionsFrom, stageSuggestion, type StagePrinting } from "@/lib/line/stage-options";

const p = (over: Partial<StagePrinting> & { tcgdexId: string }): StagePrinting => ({
  name: "Charmeleon",
  setId: "s",
  setName: "S",
  localId: "1",
  setCardCountOfficial: null,
  imageUrl: null,
  cardClass: "standard",
  isDigitalOnly: false,
  priceMarket: 1,
  bandKey: "red",
  ...over,
});
const LINE = { locale: "en" as const, bandKey: "red" };
const ids = (xs: { card: { tcgdexId: string } }[]) => xs.map((x) => x.card.tcgdexId);

describe("stageOptionsFrom", () => {
  it("only the line's language, only physical printings", () => {
    const out = stageOptionsFrom(
      [
        p({ tcgdexId: "en-1" }),
        p({ tcgdexId: "ja:ja-1" }),
        p({ tcgdexId: "en-digital", isDigitalOnly: true }),
        p({ tcgdexId: "user:en:mine" }),
        p({ tcgdexId: "user:fr:other" }),
      ],
      LINE,
    );
    expect(ids(out).sort()).toEqual(["en-1", "user:en:mine"]);
  });

  it("same colour first, then standard before special, then cheapest (unpriced last)", () => {
    const out = stageOptionsFrom(
      [
        p({ tcgdexId: "other-colour-cheap", bandKey: "dark_blue", priceMarket: 0.01 }),
        p({ tcgdexId: "special", cardClass: "specialty", priceMarket: 0.05 }),
        p({ tcgdexId: "unpriced", priceMarket: null }),
        p({ tcgdexId: "pricey", priceMarket: 5 }),
        p({ tcgdexId: "cheap", priceMarket: 0.1 }),
      ],
      LINE,
    );
    expect(ids(out)).toEqual(["cheap", "pricey", "unpriced", "special", "other-colour-cheap"]);
    expect(out.find((o) => o.card.tcgdexId === "other-colour-cheap")?.sameColour).toBe(false);
    expect(out.find((o) => o.card.tcgdexId === "special")?.special).toBe(true);
  });

  it("a Japanese line offers the Japanese printings", () => {
    expect(
      ids(
        stageOptionsFrom([p({ tcgdexId: "en-1" }), p({ tcgdexId: "ja:ja-1" })], {
          ...LINE,
          locale: "ja",
        }),
      ),
    ).toEqual(["ja:ja-1"]);
  });
});

describe("stageSuggestion", () => {
  it("the cheapest same-colour standard printing", () => {
    const out = stageOptionsFrom(
      [p({ tcgdexId: "a", priceMarket: 2 }), p({ tcgdexId: "b", priceMarket: 0.5 })],
      LINE,
    );
    expect(stageSuggestion(out)).toEqual({
      card: expect.objectContaining({ tcgdexId: "b" }),
      special: false,
    });
  });

  it("else the special one, flagged", () => {
    const out = stageOptionsFrom(
      [
        p({ tcgdexId: "sp", cardClass: "specialty" }),
        p({ tcgdexId: "other", bandKey: "dark_blue" }),
      ],
      LINE,
    );
    expect(stageSuggestion(out)).toEqual({
      card: expect.objectContaining({ tcgdexId: "sp" }),
      special: true,
    });
  });

  it("none when no printing is in the line's colour", () => {
    expect(
      stageSuggestion(stageOptionsFrom([p({ tcgdexId: "x", bandKey: "blue" })], LINE)),
    ).toBeNull();
  });
});

describe("UIL-133 · the line's form first", () => {
  // Real printings (TCGdex, 2026-10-01): both Fighting, so both in an orange line's colour.
  const plain = p({
    tcgdexId: "sv09-089",
    name: "Toedscruel",
    bandKey: "orange",
    priceMarket: 0.2,
  });
  const arvens = p({
    tcgdexId: "sv10-110",
    name: "Arven's Toedscruel",
    bandKey: "orange",
    priceMarket: 0.9,
  });
  const ARVEN_LINE = { locale: "en" as const, bandKey: "orange", form: "trainer:arven" };

  it("an Arven's line lists Arven's printings first, however cheap the plain one is; a plain line the reverse", () => {
    expect(ids(stageOptionsFrom([plain, arvens], ARVEN_LINE))).toEqual(["sv10-110", "sv09-089"]);
    expect(ids(stageOptionsFrom([arvens, plain], { ...ARVEN_LINE, form: null }))).toEqual([
      "sv09-089",
      "sv10-110",
    ]);
    expect(stageOptionsFrom([plain, arvens], ARVEN_LINE).map((o) => o.sameForm)).toEqual([
      true,
      false,
    ]);
  });

  it("suggests the line's own form even when it is only a special printing and a plain one is standard", () => {
    const special = { ...arvens, cardClass: "specialty" };
    expect(stageSuggestion(stageOptionsFrom([plain, special], ARVEN_LINE))).toEqual({
      card: expect.objectContaining({ tcgdexId: "sv10-110" }),
      special: true,
    });
  });

  it("a stage with no printing of the form is the form's own (the plain Pikachu under an Alolan Raichu)", () => {
    const pikachu = p({ tcgdexId: "base1-58", name: "Pikachu", bandKey: "yellow" });
    const out = stageOptionsFrom([pikachu], {
      locale: "en",
      bandKey: "yellow",
      form: "region:alolan",
    });
    expect(out.map((o) => o.sameForm)).toEqual([true]);
    expect(stageSuggestion(out)?.card.tcgdexId).toBe("base1-58");
  });

  it("no form given: nothing is preferred, as before", () => {
    expect(
      stageOptionsFrom([plain, arvens], { locale: "en", bandKey: "orange" })[0],
    ).not.toHaveProperty("sameForm");
  });
});
