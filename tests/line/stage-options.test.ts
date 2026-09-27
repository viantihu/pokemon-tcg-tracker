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
