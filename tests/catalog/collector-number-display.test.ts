/**
 * UIL-077 — the collector number renders as she reads it off the card: "099/182", not "099".
 *
 * She identifies a printing by the whole number. Choosing between compatible printings for a line slot
 * without the denominator is choosing blind — and this is the same information gap behind UIL-010,
 * UIL-015, UIL-026 and UIL-044, all four of which were fixed in SEARCH while DISPLAY still showed the
 * bare numerator.
 *
 * The root cause was one missing line: `set_card_count_official` is populated on all 23,548 rows and the
 * search ranking already reads it, but `toCatalogCard` never mapped it into `CatalogCard`, so it could
 * not reach anything that renders.
 *
 * THE FALLBACK IS THE PART WORTH TESTING HARDEST. The column is nullable and the mirror writes
 * `set.cardCount?.official ?? null`, so a missing total is legitimate rather than a defect — promos and
 * some subsets have none. `"099/"` must never appear. Most of these tests are about that.
 */
import { describe, expect, it } from "vitest";
import { formatCollectorNumber } from "@/lib/catalog/collector-number";
import { toCatalogCard } from "@/lib/plan/adapt";
import type { Row } from "@/lib/repo";

describe("UIL-077 · the full form when both parts exist", () => {
  it("renders numerator/denominator", () => {
    expect(formatCollectorNumber("099", 182)).toBe("099/182");
  });

  it("preserves the printed padding exactly, rather than normalising it", () => {
    // "099" and "99" are different strings on the card; search normalises, display must not.
    expect(formatCollectorNumber("099", 182)).toBe("099/182");
    expect(formatCollectorNumber("99", 182)).toBe("99/182");
    expect(formatCollectorNumber("011", 25)).toBe("011/25");
  });

  it("handles a non-numeric collector number, which some promos use", () => {
    expect(formatCollectorNumber("SWSH284", 307)).toBe("SWSH284/307");
    expect(formatCollectorNumber("TG12", 30)).toBe("TG12/30");
  });
});

describe("UIL-077 · the fallback, which must never produce a dangling slash", () => {
  it("returns the bare number when the set total is null", () => {
    expect(formatCollectorNumber("099", null)).toBe("099");
  });

  it("returns the bare number when the set total is undefined", () => {
    expect(formatCollectorNumber("099", undefined)).toBe("099");
  });

  it("returns the bare number for a ZERO total rather than '099/0'", () => {
    // A zero denominator is meaningless and would be worse than the bare number it replaced.
    expect(formatCollectorNumber("099", 0)).toBe("099");
  });

  it("never emits a trailing slash in any no-denominator case", () => {
    for (const total of [null, undefined, 0]) {
      const out = formatCollectorNumber("099", total);
      expect(out).not.toContain("/");
      expect(out).toBe("099");
    }
  });

  it("returns null when there is no number at all, so callers keep their existing guard", () => {
    // Every call site is `formatCollectorNumber(...) ? … : null`, which only works if this is falsy.
    expect(formatCollectorNumber(null, 182)).toBeNull();
    expect(formatCollectorNumber(undefined, 182)).toBeNull();
    expect(formatCollectorNumber("", 182)).toBeNull();
  });
});

describe("UIL-077 · the adapter maps the field through — the actual defect", () => {
  function row(over: Partial<Row<"catalog_card">> = {}): Row<"catalog_card"> {
    return {
      tcgdex_id: "sv04-099",
      name: "Minior",
      dex_id: [774],
      set_id: "sv04",
      set_name: "Paradox Rift",
      local_id: "099",
      set_card_count_official: 182,
      rarity: "Rare",
      types: ["Rock"],
      stage: "Basic",
      evolve_from: null,
      illustrator: null,
      hp: 70,
      variants: {},
      artwork_group_id: null,
      card_class: "standard",
      is_digital_only: false,
      price_low: null,
      price_market: null,
      ...over,
    } as unknown as Row<"catalog_card">;
  }

  it("carries set_card_count_official onto CatalogCard", () => {
    // Before the fix this was simply absent, so nothing downstream could render the denominator.
    expect(toCatalogCard(row()).setCardCountOfficial).toBe(182);
  });

  it("carries null through rather than dropping to undefined", () => {
    expect(toCatalogCard(row({ set_card_count_official: null })).setCardCountOfficial).toBeNull();
  });

  it("composes with the formatter end to end", () => {
    const card = toCatalogCard(row());
    expect(formatCollectorNumber(card.localId, card.setCardCountOfficial)).toBe("099/182");
    const noTotal = toCatalogCard(row({ set_card_count_official: null }));
    expect(formatCollectorNumber(noTotal.localId, noTotal.setCardCountOfficial)).toBe("099");
  });

  it("is exactly her 099/182 case, the one she named", () => {
    const card = toCatalogCard(row());
    expect(formatCollectorNumber(card.localId, card.setCardCountOfficial)).toBe("099/182");
  });
});
