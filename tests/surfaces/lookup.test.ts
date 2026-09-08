/**
 * Card lookup answer assembly (dev-spec §5 M8; system-design §7C — the show-floor decision set).
 * Pure test over `buildLookupAnswer`: owned? · line? · wishlisted? · in a collection?
 */

import { describe, expect, it } from "vitest";
import { buildLookupAnswer, type LookupInput } from "@/lib/surfaces";

const BANDS = [
  "red",
  "orange",
  "yellow",
  "olive",
  "green",
  "dark_blue",
  "light_blue",
  "purple",
  "pink",
  "white",
];

function base(): LookupInput {
  return {
    card: {
      tcgdexId: "sv03-027",
      name: "Charmeleon",
      setName: "Obsidian Flames",
      localId: "027",
      rarity: "Uncommon",
      types: ["Fire"],
      stage: "Stage1",
      cardClass: "standard",
      imageUrl: null,
    },
    bandKey: "red",
    bandDisplay: "Red",
    orderedBandKeys: BANDS,
    copies: [],
    ownedInLine: null,
    completesLine: null,
    wishlist: { wished: false, willLiveInSpecialty: false, detail: null },
    collections: [],
  };
}

describe("buildLookupAnswer", () => {
  it("answers WHERE for an owned, shelved, in-a-line card", () => {
    const input = base();
    input.copies = [
      {
        role: "shelved",
        binderId: "b1",
        binderName: "Binder 1",
        binderHalf: "back",
        bandDisplay: "Red",
        lineSlotId: "slot-1",
      },
    ];
    input.ownedInLine = {
      lineId: "L1",
      lineLabel: "Charmander line",
      stage: "Stage1",
      status: "capped",
    };

    const ans = buildLookupAnswer(input);
    expect(ans.owned).toBe(true);
    expect(ans.location).toEqual({ binderName: "Binder 1", half: "BACK HALF", bandDisplay: "Red" });
    const line = ans.facts.find((f) => f.label === "IN A LINE");
    expect(line?.tone).toBe("y");
    expect(line?.detail).toContain("CAPPED");
    expect(line?.lineId).toBe("L1");
  });

  it("flags an unowned printing that would complete a line and is wishlisted to specialty", () => {
    const input = base();
    input.card = {
      ...input.card,
      tcgdexId: "sv03.5-006",
      name: "Charizard ex",
      cardClass: "specialty",
      stage: "Stage2",
    };
    input.completesLine = {
      lineId: "L1",
      lineLabel: "Charmander line",
      stage: "Stage2",
      status: "capped",
    };
    input.wishlist = { wished: true, willLiveInSpecialty: true, detail: "$24.10 · top target" };

    const ans = buildLookupAnswer(input);
    expect(ans.owned).toBe(false);
    expect(ans.location).toBeNull();
    expect(ans.facts.find((f) => f.label === "WOULD COMPLETE A LINE")?.tone).toBe("hot");
    const wish = ans.facts.find((f) => f.label === "WISHLISTED");
    expect(wish?.tone).toBe("hot");
    expect(wish?.detail).toContain("$24.10");
  });

  it("names the collections that claim the printing", () => {
    const input = base();
    input.collections = [{ id: "a1", name: "Matsuno illustrations" }];
    const ans = buildLookupAnswer(input);
    const fact = ans.facts.find((f) => f.label === "IN A COLLECTION");
    expect(fact?.detail).toBe("Matsuno illustrations");
  });

  it("highlights the active band in the rainbow stack and always shows four facts", () => {
    const input = base();
    input.copies = [
      {
        role: "shelved",
        binderId: "b1",
        binderName: "Binder 1",
        binderHalf: "front",
        bandDisplay: "Red",
        lineSlotId: null,
      },
    ];
    const ans = buildLookupAnswer(input);
    expect(ans.bandStack).toHaveLength(10);
    expect(ans.bandStack.filter((s) => s.active).map((s) => s.key)).toEqual(["red"]);
    // line · wishlist · collection · duplicate (owned) = 4 facts.
    expect(ans.facts.map((f) => f.label)).toEqual([
      "NO LINE",
      "NOT WISHLISTED",
      "NO COLLECTION",
      "DUPLICATES",
    ]);
  });

  it("prefers a shelved copy's location over a bulk copy", () => {
    const input = base();
    input.copies = [
      {
        role: "bulk",
        binderId: null,
        binderName: null,
        binderHalf: null,
        bandDisplay: null,
        lineSlotId: null,
      },
      {
        role: "shelved",
        binderId: "b1",
        binderName: "Binder 1",
        binderHalf: "front",
        bandDisplay: "Red",
        lineSlotId: null,
      },
    ];
    const ans = buildLookupAnswer(input);
    expect(ans.location?.half).toBe("FRONT HALF");
    expect(ans.facts.find((f) => f.label === "DUPLICATES")?.detail).toContain("bulk box");
  });
});
