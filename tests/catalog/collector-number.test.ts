/**
 * Searching by a printed collector number (UIL-010).
 *
 * She typed `099/182` for a Minior and got **nothing at all**. The search built `ilike %099/182%` per
 * column and no column holds a slash, so every predicate failed. A finite collection is built from a
 * set checklist, and a checklist is a list of collector numbers — the number IS the natural key for
 * that workflow, so a total silent miss reads as "the card isn't in the app".
 *
 * Two halves are pinned here: the parse (drop the denominator, keep the numerator) and the padding
 * candidates, because `local_id` keeps TCGdex's padding verbatim and it varies by set.
 */
import { describe, expect, it } from "vitest";
import { parseCardQuery } from "@/lib/catalog/collector-number";

describe("parseCardQuery — the reported case", () => {
  it("reads 099/182 as collector number 099, denominator discarded", () => {
    const p = parseCardQuery("099/182");
    expect(p.localIds).toEqual(["099", "99"]);
    expect(p.numberOnly).toBe(true);
    expect(p.text).toBe("099");
    // The slash must not survive into a free-text predicate — that is what matched nothing.
    expect(p.text).not.toContain("/");
  });

  it("finds the same card typed without the padding the set happens to use", () => {
    expect(parseCardQuery("99/182").localIds).toEqual(["99", "099"]);
  });

  it("tolerates spaces around the slash", () => {
    expect(parseCardQuery("099 / 182").localIds).toEqual(["099", "99"]);
  });
});

describe("parseCardQuery — bare numbers", () => {
  it("treats a bare number as a collector number and normalizes padding", () => {
    expect(parseCardQuery("99").localIds).toEqual(["99", "099"]);
    expect(parseCardQuery("027").localIds).toEqual(["027", "27"]);
  });

  it("keeps a three-digit number that needs no variant to a single candidate", () => {
    expect(parseCardQuery("103").localIds).toEqual(["103"]);
  });
});

describe("parseCardQuery — promo and subset numbering", () => {
  it("handles a letter-prefixed number like TG05/TG30", () => {
    const p = parseCardQuery("TG05/TG30");
    expect(p.localIds).toContain("TG05");
    expect(p.numberOnly).toBe(true);
  });

  it("handles a trailing-letter number like 099a", () => {
    expect(parseCardQuery("099a/182").localIds).toContain("099a");
  });
});

describe("parseCardQuery — free text is left alone", () => {
  it("does not mistake a set code for a collector number", () => {
    const p = parseCardQuery("sv03");
    expect(p.localIds).toEqual([]);
    expect(p.text).toBe("sv03");
  });

  it("passes a name straight through", () => {
    const p = parseCardQuery("Minior");
    expect(p).toMatchObject({ text: "Minior", localIds: [], numberOnly: false });
  });

  it("passes a full tcgdex id through as text, not as a number", () => {
    const p = parseCardQuery("sv03-026");
    expect(p.localIds).toEqual([]);
    expect(p.text).toBe("sv03-026");
  });

  it("returns nothing for an empty or blank query", () => {
    for (const raw of ["", "   "]) {
      expect(parseCardQuery(raw)).toMatchObject({ text: "", localIds: [], numberOnly: false });
    }
  });
});

describe("parseCardQuery — a number inside a longer query", () => {
  it("searches the name AND the number for 'minior 099'", () => {
    const p = parseCardQuery("minior 099");
    expect(p.localIds).toEqual(["099", "99"]);
    expect(p.text).toBe("minior");
    expect(p.numberOnly).toBe(false);
  });

  it("handles a set code plus a printed number", () => {
    const p = parseCardQuery("sv03 099/182");
    expect(p.localIds).toEqual(["099", "99"]);
    expect(p.text).toBe("sv03");
  });

  it("does not strip digits that are part of a word", () => {
    // "Charizard ex" style names and set codes must survive intact.
    const p = parseCardQuery("sv03-125 charizard");
    expect(p.text).toContain("charizard");
  });
});
