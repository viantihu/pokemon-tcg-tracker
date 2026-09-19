/**
 * UIL-077, the Collections half. #187 shipped the full printed collector number ("099/182") on the Plan,
 * Backfill and shared type-ahead sites and left two bare: the collection tiles and the builder grid.
 * Karvi: "I need to see the FULL collectors number EVERYWHERE a specific card is referenced."
 *
 * Static renders of the two exported pieces that draw a number. `formatCollectorNumber` itself is pinned
 * by its own tests; what this proves is that these sites now CALL it — with the set total threaded
 * through `CollectionCardView` and `BrowseCard` — and fall back to the bare number when TCGdex has none.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrowseCardTile } from "@/app/(ui)/coll/CardSearchGrid";
import { CollectionCard } from "@/app/(ui)/coll/CollHub";
import type { BrowseCard, CollectionCardView, CollectionView } from "@/app/(ui)/coll/coll-types";

function view(over: Partial<CollectionCardView>): CollectionCardView {
  return {
    tcgdexId: "sv04-099",
    name: "Minior",
    setName: "Paradox Rift",
    localId: "099",
    setCardCountOfficial: 182,
    bandKey: "red",
    imageUrl: null,
    owned: true,
    wished: false,
    copyIds: ["copy-1"],
    ...over,
  };
}

function collection(cards: CollectionCardView[]): CollectionView {
  return {
    id: "col-1",
    name: "Paradox",
    mode: "finite",
    incomplete: false,
    binderIds: ["b1"],
    binderNames: ["Specialty A"],
    cards,
    ownedCount: cards.filter((c) => c.owned).length,
    totalCount: cards.length,
  };
}

const renderCollection = (cards: CollectionCardView[]) =>
  renderToStaticMarkup(
    createElement(CollectionCard, {
      collection: collection(cards),
      busy: false,
      collapsed: false,
      onToggleCollapse: () => {},
      onEdit: () => {},
      onLog: () => {},
      onWishlist: () => {},
      onRemove: () => {},
    } as unknown as Parameters<typeof CollectionCard>[0]),
  );

describe("UIL-077 · collection tiles show the full printed number", () => {
  it("099/182 on a tile whose set total is known", () => {
    const html = renderCollection([view({})]);
    expect(html).toContain('class="cno">099/182<');
  });

  it("the bare number when the set has no printed total — never 099/", () => {
    const html = renderCollection([view({ setCardCountOfficial: null })]);
    expect(html).toContain('class="cno">099<');
    expect(html).not.toContain("099/");
  });
});

describe("UIL-077 · the builder grid's tiles show the full printed number", () => {
  const browse = (over: Partial<BrowseCard>): BrowseCard => ({
    tcgdexId: "sv04-099",
    name: "Minior",
    setId: "sv04",
    setName: "Paradox Rift",
    localId: "099",
    setCardCountOfficial: 182,
    illustrator: null,
    types: ["Fighting"],
    imageUrl: null,
    owned: false,
    ...over,
  });

  it("099/182 on a browse tile", () => {
    const html = renderToStaticMarkup(
      createElement(BrowseCardTile, { card: browse({}), picked: false, onToggle: () => {} }),
    );
    expect(html).toContain('class="cno">099/182<');
  });

  it("bare when unknown, and the pick state still renders", () => {
    const html = renderToStaticMarkup(
      createElement(BrowseCardTile, {
        card: browse({ setCardCountOfficial: null, owned: true }),
        picked: true,
        onToggle: () => {},
      }),
    );
    expect(html).toContain('class="cno">099<');
    expect(html).toContain("Owned");
    expect(html).toContain("Selected");
  });
});
