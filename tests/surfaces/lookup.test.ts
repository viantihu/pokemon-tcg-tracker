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

/**
 * UIL-088 — an IN-HAUL copy is not a duplicate in the bulk box, and it is not a location.
 *
 * An import used to create copies as `role: 'bulk'`, so this screen — the one she uses to ask where a card
 * is — described a card she had imported and never placed as "N copies in the bulk box": a placement she
 * never made. With the third state separate, Lookup answers it as its own thing.
 */
describe("buildLookupAnswer · the in-haul state (UIL-088)", () => {
  const inHaul = () => ({
    role: "haul" as const,
    binderId: null,
    binderName: null,
    binderHalf: null,
    bandDisplay: null,
    lineSlotId: null,
  });

  it("does not read an in-haul copy as a LOCATION — it is placed nowhere", () => {
    const input = base();
    input.copies = [inHaul()];
    const out = buildLookupAnswer(input);
    // Owned, but there is no binder to name. Pre-fix an in-haul copy fell through the `role !== "bulk"`
    // filter and was treated as a placed copy that could supply a location.
    expect(out.owned).toBe(true);
    expect(out.location).toBeNull();
  });

  it("says IN HAUL, and does not call it a duplicate in the box", () => {
    const input = base();
    input.copies = [inHaul(), inHaul()];
    const facts = buildLookupAnswer(input).facts;
    const haul = facts.find((f) => f.label === "IN HAUL");
    expect(haul).toBeDefined();
    expect(haul!.detail).toContain("2 copies imported but not placed anywhere yet");
    // And it must not also say "No duplicate in bulk" beside it. That sentence is literally true of the
    // bulk box, but next to "2 copies imported" it reads as a contradiction about the same two cards, so
    // the in-haul answer stands alone.
    expect(facts.find((f) => f.label === "DUPLICATES")).toBeUndefined();
  });

  it("a REAL bulk copy is still reported as a duplicate in the box", () => {
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
    ];
    const facts = buildLookupAnswer(input).facts;
    expect(facts.find((f) => f.label === "DUPLICATES")?.detail).toContain("1 copy in the bulk box");
    expect(facts.find((f) => f.label === "IN HAUL")).toBeUndefined();
  });

  it("a shelved copy still names its binder, with an in-haul copy alongside it", () => {
    const input = base();
    input.copies = [
      inHaul(),
      {
        role: "shelved",
        binderId: "b1",
        binderName: "Binder 1",
        binderHalf: "front",
        bandDisplay: "Red",
        lineSlotId: null,
      },
    ];
    const out = buildLookupAnswer(input);
    expect(out.location?.binderName).toBe("Binder 1");
    expect(out.facts.find((f) => f.label === "IN HAUL")).toBeDefined();
  });
});
