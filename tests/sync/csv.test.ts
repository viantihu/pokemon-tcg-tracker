import { describe, it, expect } from "vitest";
import { decodeDexCsv, parseDexCsv, filterOwned, OWNED_TYPE } from "@/lib/sync/csv";

const HEADER =
  "Type;Category;Locale;Series;Set;Id;Number;Name;Variant;Rarity;Illustrator;Quantity;Price;Notes";

/** Encode a string as UTF-16LE with a BOM, mimicking the real Dex export. */
function toUtf16leWithBom(text: string): Uint8Array {
  const body = Buffer.from(text, "utf16le");
  return Uint8Array.from([0xff, 0xfe, ...body]);
}

describe("decodeDexCsv", () => {
  it("decodes UTF-16LE bytes and strips the BOM", () => {
    const bytes = toUtf16leWithBom("Type;Category");
    expect(decodeDexCsv(bytes)).toBe("Type;Category");
  });
});

describe("parseDexCsv", () => {
  it("parses semicolon-delimited rows keyed by column", () => {
    const csv = [
      HEADER,
      "collection;My Collection;English;SV;Destined Rivals;sv10-103;103/182;Cynthia's Gabite;Normal;Rare;;1;0.50;",
    ].join("\n");
    const rows = parseDexCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].Id).toBe("sv10-103");
    expect(rows[0].Name).toBe("Cynthia's Gabite");
    expect(rows[0].Variant).toBe("Normal");
    expect(rows[0].Quantity).toBe("1");
  });

  it("folds semicolons inside the Notes column back together", () => {
    const csv = [
      HEADER,
      "collection;My Collection;English;SV;Set;sv10-1;1/1;Card;Normal;Common;;1;0.10;note; with; semicolons",
    ].join("\n");
    const rows = parseDexCsv(csv);
    expect(rows[0].Notes).toBe("note; with; semicolons");
  });

  it("throws on an unexpected header so a format change can't silently corrupt a sync", () => {
    expect(() => parseDexCsv("Wrong;Header\nfoo;bar")).toThrow(/Type/);
  });
});

describe("filterOwned (scope filter §1.2)", () => {
  it("keeps only collection rows, dropping wishlist (standard_v2) rows", () => {
    const csv = [
      HEADER,
      "collection;My Collection;English;SV;Set;sv10-1;1;Owned;Normal;Common;;1;0.10;",
      "standard_v2;Okubo Wishlist;English;SV;Set;sv10-2;2;Wanted;Normal;Common;;1;0.10;",
    ].join("\n");
    const owned = filterOwned(parseDexCsv(csv));
    expect(owned).toHaveLength(1);
    expect(owned[0].Type).toBe(OWNED_TYPE);
    expect(owned[0].Name).toBe("Owned");
  });
});
