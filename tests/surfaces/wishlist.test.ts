/**
 * Wishlist export (dev-spec §5 M8 acceptance: "wishlist CSV round-trips into Dex format") + grouping.
 *
 * The round-trip is the load-bearing test: bytes we emit for download decode + parse back through
 * the REAL Dex sync parser (`lib/sync`) unchanged, and — because wishlist rows are `standard_v2`,
 * not `collection` — the scope filter drops them, so a mirrored wishlist can never re-import as OWNED.
 */

import { describe, expect, it } from "vitest";
import { decodeDexCsv, filterOwned, parseDexCsv } from "@/lib/sync/csv";
import {
  buildWishlistCopyText,
  buildWishlistCsv,
  encodeDexCsvUtf16le,
  groupWishlist,
  serializeDexCsv,
  wishlistToDexRows,
  type WishlistEntry,
} from "@/lib/surfaces";

/** Two open gaps in the Fire Charmander line (Binder 1) + one loose gap with nothing to chase. */
const ENTRIES: WishlistEntry[] = [
  {
    id: "w1",
    requiredDexId: 6,
    requiredType: "Fire",
    requiredStage: "Stage2",
    bandKey: "red",
    bandDisplay: "Red",
    speciesName: "Charizard",
    lineId: "L1",
    lineLabel: "Charmander line",
    binderId: "b1",
    binderName: "Binder 1",
    willLiveInSpecialty: true,
    chosen: {
      tcgdexId: "sv03.5-006",
      name: "Charizard ex",
      setName: "151",
      setSeries: "Scarlet & Violet",
      localId: "006",
      rarity: "Double rare",
      illustrator: "PLANETA Mochizuki",
      priceMarket: 24.1,
    },
    alternates: [
      {
        tcgdexId: "sv03.5-183",
        name: "Charizard ex",
        setName: "151",
        setSeries: "Scarlet & Violet",
        localId: "183",
        rarity: "Ultra Rare",
        illustrator: "PLANETA Mochizuki",
        priceMarket: 61.4,
      },
    ],
  },
  {
    id: "w2",
    requiredDexId: 329,
    requiredType: "Dragon",
    requiredStage: "Stage1",
    bandKey: "olive",
    bandDisplay: "Olive",
    speciesName: "Vibrava",
    lineId: "L2",
    lineLabel: "Trapinch line",
    binderId: "b1",
    binderName: "Binder 1",
    willLiveInSpecialty: false,
    chosen: {
      tcgdexId: "xy5-109",
      name: "Vibrava",
      setName: "Primal Clash",
      setSeries: "XY",
      localId: "109",
      rarity: "Uncommon",
      illustrator: "Yukiko Baba",
      priceMarket: 0.4,
    },
    alternates: [],
  },
  {
    // A blocked/orphan gap: nothing in the catalog to chase → excluded from the CSV.
    id: "w3",
    requiredDexId: 999,
    requiredType: "Grass",
    requiredStage: "Stage1",
    bandKey: "green",
    bandDisplay: "Green",
    speciesName: "Somethingite",
    lineId: "L3",
    lineLabel: "Some line",
    binderId: "b2",
    binderName: "Binder 2",
    willLiveInSpecialty: false,
    chosen: null,
    alternates: [],
  },
];

describe("wishlist CSV export", () => {
  it("round-trips through the real Dex CSV encoder + parser unchanged", () => {
    const rows = wishlistToDexRows(ENTRIES);
    const text = serializeDexCsv(rows);
    const bytes = encodeDexCsvUtf16le(text);

    // Decode + parse with the SAME code the sync engine uses on a real Dex export.
    const decoded = decodeDexCsv(bytes);
    const parsed = parseDexCsv(decoded);

    expect(parsed).toEqual(rows);
  });

  it("emits a row only for gaps that have a card to chase", () => {
    const rows = wishlistToDexRows(ENTRIES);
    expect(rows).toHaveLength(2); // w3 (no chosen) is excluded
    expect(rows.map((r) => r.Id)).toEqual(["sv03.5-006", "xy5-109"]);
  });

  it("marks wishlist rows as standard_v2 so a re-import never adds them as OWNED", () => {
    const rows = parseDexCsv(decodeDexCsv(encodeDexCsvUtf16le(buildWishlistCsv(ENTRIES))));
    expect(rows.every((r) => r.Type === "standard_v2")).toBe(true);
    expect(filterOwned(rows)).toEqual([]); // scope filter drops them all
  });

  it("keeps every non-Notes field free of the semicolon delimiter", () => {
    const rows = wishlistToDexRows(ENTRIES);
    for (const r of rows) {
      for (const [col, val] of Object.entries(r)) {
        if (col === "Notes") continue;
        expect(val).not.toContain(";");
      }
    }
  });
});

describe("wishlist grouping", () => {
  it("groups by binder, then by line within each binder", () => {
    const groups = groupWishlist(ENTRIES);
    expect(groups.map((g) => g.binderName)).toEqual(["Binder 1", "Binder 2"]);

    const b1 = groups[0];
    expect(b1.count).toBe(2);
    expect(b1.lineGroups.map((l) => l.lineLabel)).toEqual(["Charmander line", "Trapinch line"]);
    expect(b1.lineGroups[0].entries.map((e) => e.id)).toEqual(["w1"]);
  });

  it("copy-paste text lists the chosen target, its price, and alternates", () => {
    const text = buildWishlistCopyText(groupWishlist(ENTRIES));
    expect(text).toContain("Charizard ex 006");
    expect(text).toContain("$24.10");
    expect(text).toContain("alts: Charizard ex 183");
    expect(text).toContain("nothing in catalog yet"); // the blocked gap still shows
  });
});
