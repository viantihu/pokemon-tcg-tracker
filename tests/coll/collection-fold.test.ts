/**
 * Foldable collection cards on the Collections page (UIL-034).
 *
 * Same shape as UIL-018's fix for the Haul Plan (`tests/plan/band-collapse.test.ts`), for the same
 * reason: a finite collection built from a set checklist is 200-300+ `CardFace` tiles, and hiding a
 * folded one with CSS would leave every tile mounted, re-rendering and holding an `<img>` each. So
 * these assert ABSENCE FROM THE TREE — no card markup at all — rather than a class name or a style. A
 * test that only looked for `.folded` would pass against a CSS-only fix.
 *
 * The progress summary is required to survive folding (per the issue log: "that's the reason to look
 * at the page at all even when collapsed"), so it is asserted from the HEADER, not the folded-away body.
 *
 * Rendered with `react-dom/server`, which needs no DOM, so this runs in the suite's node environment.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CollectionCard } from "@/app/(ui)/coll/CollHub";
import type { CollectionCardView, CollectionView } from "@/app/(ui)/coll/coll-types";

function card(n: number, owned: boolean): CollectionCardView {
  return {
    tcgdexId: `card-${n}`,
    name: `Testcard ${n}`,
    setName: "sv03",
    localId: String(n),
    setCardCountOfficial: null,
    bandKey: "red",
    imageUrl: `https://assets.tcgdex.net/en/sv/sv03/${n}`,
    owned,
    wished: false,
    copyIds: owned ? [`copy-${n}`] : [],
  };
}

/** A finite collection with `owned` owned cards followed by `gap` un-owned ones. */
function collection(owned: number, gap: number): CollectionView {
  const cards = [
    ...Array.from({ length: owned }, (_, i) => card(i + 1, true)),
    ...Array.from({ length: gap }, (_, i) => card(owned + i + 1, false)),
  ];
  return {
    id: "col-1",
    name: "Matsuno",
    mode: "finite",
    incomplete: false,
    binderIds: ["b1"],
    binderNames: ["Specialty A"],
    cards,
    ownedCount: owned,
    totalCount: owned + gap,
  };
}

function render(c: CollectionView, collapsed: boolean, over: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(CollectionCard, {
      collection: c,
      busy: false,
      collapsed,
      onToggleCollapse: () => {},
      onEdit: () => {},
      onMode: () => {},
      onDelete: () => {},
      onLog: () => {},
      onWishlist: () => {},
      onRemove: () => {},
      ...over,
    }),
  );
}

const cardCount = (html: string) => html.split('class="ccard').length - 1;

describe("UIL-034 · a folded collection does not render its cards", () => {
  it("renders every card when expanded", () => {
    const html = render(collection(2, 3), false);
    expect(cardCount(html)).toBe(5);
    expect(html).toContain("Testcard 1");
    expect(html).toContain("Testcard 5");
  });

  it("renders NO cards when folded — absent from the tree, not hidden by a style", () => {
    const html = render(collection(2, 3), true);
    expect(cardCount(html)).toBe(0);
    expect(html).not.toContain("Testcard");
    expect(html).not.toContain("<img");
    // The tell-tales of a CSS-only fix. If any of these appear, the cards are still mounted.
    expect(html).not.toContain("display:none");
    expect(html).not.toContain("display: none");
    expect(html).not.toMatch(/\shidden[=\s>]/);
  });

  it("keeps the header, because finding the collection she wants is the point", () => {
    const html = render(collection(2, 3), true);
    expect(html).toContain("Matsuno");
    expect(html).toContain('aria-expanded="false"');
  });

  it("reports aria-expanded honestly in both states", () => {
    expect(render(collection(1, 1), false)).toContain('aria-expanded="true"');
    expect(render(collection(1, 1), true)).toContain('aria-expanded="false"');
  });

  it("carries the progress summary in the header, since a folded body shows nothing", () => {
    const html = render(collection(2, 3), true);
    // finiteProgress(5, 2) => owned 2, total 5, pct 40.
    expect(html).toContain("2 / 5 owned");
    expect(html).toContain("40%");
  });

  it("costs a header's worth of markup once folded, not a page's worth", () => {
    const big = collection(0, 250);
    const open = render(big, false).length;
    const shut = render(big, true).length;
    expect(cardCount(render(big, false))).toBe(250);
    expect(cardCount(render(big, true))).toBe(0);
    // Not a perf benchmark — a floor check that the saving is structural, not a few bytes of
    // `style="display:none"`.
    expect(shut).toBeLessThan(open / 50);
  });
});

describe("UIL-038 · an incomplete draft is marked, not left to look broken", () => {
  it("shows a Draft badge when the collection is missing a name or a binder", () => {
    const html = render({ ...collection(0, 0), name: "", incomplete: true }, false);
    expect(html).toContain("Untitled collection");
    expect(html).toContain('class="cpill draft u"');
    expect(html).toContain("Draft");
  });

  it("shows no badge for a normally-named, homed collection", () => {
    const html = render(collection(1, 1), false);
    expect(html).not.toContain("cpill draft");
  });
});

describe("UIL-034 · open collections fold the same way", () => {
  function openCollection(n: number): CollectionView {
    return {
      id: "col-2",
      name: "Kagemaru",
      mode: "open",
      incomplete: false,
      binderIds: ["b2"],
      binderNames: ["Specialty B"],
      cards: Array.from({ length: n }, (_, i) => card(i + 1, true)),
      ownedCount: n,
      totalCount: n,
    };
  }

  it("renders every card when expanded, none when folded, and keeps the running count either way", () => {
    const c = openCollection(4);
    expect(cardCount(render(c, false))).toBe(4);
    expect(cardCount(render(c, true))).toBe(0);
    expect(render(c, false)).toContain("4 logged");
    expect(render(c, true)).toContain("4 logged");
  });
});
