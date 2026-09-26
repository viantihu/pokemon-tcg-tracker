/**
 * UIL-115 — the "Search haul" matching rule (app/(ui)/plan/search.ts), pure: which cards a query finds, and
 * in what order. The screen half is tests/plan/haul-search.dom.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { PlanItem } from "@/lib/plan";
import { searchHaul, type HaulSearchEntry } from "@/app/(ui)/plan/search";

function entry(
  name: string,
  localId: string | null,
  extra: Partial<PlanItem> & { setName?: string | null; dexVariantRaw?: string | null } = {},
): HaulSearchEntry {
  const { setName = "Obsidian Flames", dexVariantRaw = "Normal", ...item } = extra;
  return {
    item: {
      incomingId: `id-${name}-${localId}`,
      tcgdexId: `sv03-${localId}`,
      name,
      setId: "sv03",
      localId,
      setCardCountOfficial: 197,
      imageUrl: null,
      variant: "normal",
      stage: "Basic",
      isBasic: true,
      bandKey: "red",
      action: "FRONT",
      destination: "KB-001 · Front · Red",
      reason: "",
      needsDecision: false,
      ...item,
    },
    setName,
    dexVariantRaw,
  };
}
const names = (xs: HaulSearchEntry[]) => xs.map((x) => x.item.name);

const HAUL = [
  entry("Charmander", "026"),
  entry("Charmeleon", "027"),
  entry("Charizard ex", "125", { dexVariantRaw: "Reverse Holo", variant: "reverse" }),
  entry("Flabébé", "088", { setName: "Paldea Evolved", setId: "sv02" }),
  entry("Pikachu", "049", { setName: "Pokémon Card 151", setId: "ja:SV2a" }),
  entry("Arven", "186", { setCardCountOfficial: null }),
];

describe("UIL-115 · what a query finds", () => {
  it("any part of the name, ignoring case", () => {
    expect(names(searchHaul(HAUL, "CHARM"))).toEqual(["Charmander", "Charmeleon"]);
    expect(names(searchHaul(HAUL, "zard"))).toEqual(["Charizard ex"]);
  });

  it("every word must match, so two words narrow rather than widen", () => {
    expect(names(searchHaul(HAUL, "charm 026"))).toEqual(["Charmander"]);
    expect(names(searchHaul(HAUL, "charm pikachu"))).toEqual([]);
  });

  it("the collector number however she types it, but only whole", () => {
    for (const q of ["026", "26", "026/197", "26/197", "#026"]) {
      expect(names(searchHaul(HAUL, q))).toEqual(["Charmander"]);
    }
    expect(searchHaul(HAUL, "2")).toEqual([]); // not every card with a 2 in its number
    expect(names(searchHaul(HAUL, "186"))).toEqual(["Arven"]); // a set with no printed total
  });

  it("the set's name or code; a Japanese set's code carries its ja: prefix, so 'ja' finds her Japanese cards", () => {
    expect(names(searchHaul(HAUL, "paldea"))).toEqual(["Flabébé"]);
    expect(names(searchHaul(HAUL, "sv2a"))).toEqual(["Pikachu"]);
    expect(names(searchHaul(HAUL, "151"))).toEqual(["Pikachu"]);
    expect(names(searchHaul(HAUL, "ja"))).toEqual(["Pikachu"]);
  });

  it("the variant, in her Dex's words or the app's", () => {
    expect(names(searchHaul(HAUL, "reverse holo"))).toEqual(["Charizard ex"]);
    expect(names(searchHaul(HAUL, "reverse"))).toEqual(["Charizard ex"]);
  });

  it("accents fold, both ways", () => {
    expect(names(searchHaul(HAUL, "flabebe"))).toEqual(["Flabébé"]);
    expect(names(searchHaul(HAUL, "pokemon"))).toEqual(["Pikachu"]);
  });

  it("keeps the plan's own order, and an empty query finds nothing", () => {
    const reversed = [...HAUL].reverse();
    expect(names(searchHaul(reversed, "char"))).toEqual([
      "Charizard ex",
      "Charmeleon",
      "Charmander",
    ]);
    expect(searchHaul(HAUL, "   ")).toEqual([]);
  });

  it("a card with no collector number is still found by name", () => {
    expect(names(searchHaul([entry("Energy", null)], "energy"))).toEqual(["Energy"]);
  });
});
