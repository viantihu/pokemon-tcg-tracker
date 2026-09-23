/**
 * UIL-098 part 2 — the Haul Plan has no way to add a card by hand.
 *
 * Karvi: "Adding cards that I don't own to a collection should add them to the wishlist, not into
 * inventory itself. This is a major data integrity issue." The Plan's add-by-set-number-or-name form was
 * the same defect on a second screen: a card typed here became a copy that belonged to no presence group,
 * so the next Dex import could not see it and created a SECOND one when Dex listed the card. Dex is the
 * source of truth for what she owns, so the Plan now only PLACES copies her import made.
 *
 * This replaces UIL-071's tests/plan/plan-intake-results-grid.test.ts, which pinned the grid type-ahead in
 * that form — the form is what is gone. The grid itself is still pinned in
 * tests/coll/card-results-grid.test.ts for the screens that keep it.
 *
 * `CardResultsGrid` is stubbed the way the old test stubbed it, so its ABSENCE is observable in a static
 * render rather than inferred from missing text.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlanScreen } from "@/app/(ui)/plan/PlanScreen";
import type { DraftCard, LookupCard } from "@/app/(ui)/plan/plan-types";

const seen = vi.hoisted(() => ({ grid: 0 }));

vi.mock("@/app/(ui)/_components/CardResultsGrid", () => ({
  CardResultsGrid: () => {
    seen.grid += 1;
    return "[typeahead:grid]";
  },
}));

const card: LookupCard = {
  tcgdexId: "sv09-017",
  name: "Meditite",
  setId: "sv09",
  setName: "Journey Together",
  localId: "017",
  setCardCountOfficial: 159,
  stage: "Basic",
  types: ["Fighting"],
  category: "Pokemon",
  trainerType: null,
  cardClass: "standard",
  imageUrl: null,
  variants: ["normal", "reverse"],
};
const QUEUED: DraftCard = {
  id: "33333333-3333-4333-8333-333333333333",
  card,
  variant: "normal",
  existingCopyId: "33333333-3333-4333-8333-333333333333",
  dexVariantRaw: "Normal",
};

/** A fresh screen: no parked plan (`readResume` sees no `window`). */
const intake = (initialPending: DraftCard[] = []) =>
  renderToStaticMarkup(createElement(PlanScreen, { initialPending }));

beforeEach(() => {
  seen.grid = 0;
});

describe("UIL-098 part 2 · the Haul Plan places cards from the import, and adds none by hand", () => {
  it("renders no add-card search at all", () => {
    // PRE-FIX: the intake panel rendered the grid type-ahead once, under the haul header.
    const html = intake();
    expect(seen.grid).toBe(0);
    expect(html).not.toContain("[typeahead:grid]");
  });

  it("renders no haul source picker and no notes field — both only described a typed haul", () => {
    const html = intake([QUEUED]);
    expect(html).not.toContain('aria-label="Haul source"');
    expect(html).not.toContain("Notes (optional)");
    expect(html).not.toContain("<select");
  });

  it("offers no variant picker on a row: the variant is the one her Dex import says", () => {
    // A typed row used to carry a VariantSelector; a queued copy's variant is Dex-owned (and this card
    // HAS a second variant, so a selector would have rendered if one were offered).
    const html = intake([QUEUED]);
    expect(html).toContain("Waiting from sync · Normal");
    expect(html).not.toContain("Reverse");
  });

  it("the empty state says where cards come from, instead of pointing at a search box that is gone", () => {
    const html = intake();
    expect(html).toContain("Nothing is waiting to be placed.");
    expect(html).toContain("add them in Dex, then import on the Sync page");
    expect(html).not.toContain("Add cards by set + number or name");
  });
});
