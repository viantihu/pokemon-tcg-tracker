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
import { CollectionCard, LogCardModal } from "@/app/(ui)/coll/CollHub";
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
      onRemoveCopy: () => {},
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

describe('UIL-089 · "Not mine" sits beside Collections\' own Remove, and only where it is unambiguous', () => {
  /**
   * TWO DIFFERENT REMOVALS on one row, and the difference is the whole point. "Remove ▸" takes the card off
   * this collection's list and RE-HOMES the copies (UIL-014) — a move, not a delete. "Not mine" deletes the
   * copy (UIL-089).
   *
   * Offered only when she holds exactly ONE copy here: with two or more, "remove this card" has no single
   * answer, and Lookup shows each copy as its own row with its own button. Guessing here would be this
   * action deciding for her which cards she no longer owns.
   */
  const withCopies = (ids: string[]): CollectionView => ({
    ...collection(1, 0),
    cards: [{ ...card(1, true), copyIds: ids }],
  });

  it("offered on a row with exactly one copy", () => {
    const html = render(withCopies(["copy-1"]), false);
    expect(html).toContain("Remove ▸"); // the collection-level move is still there
    expect(html).toContain("Not mine");
  });

  it("NOT offered on a row with two copies — the ambiguous case belongs on Lookup", () => {
    const html = render(withCopies(["copy-1", "copy-2"]), false);
    expect(html).toContain("Remove 2 ▸");
    expect(html).not.toContain("Not mine");
  });

  it("NOT offered on a gap she does not hold at all — there is no copy to remove", () => {
    const html = render(withCopies([]), false);
    expect(html).toContain("Remove ▸");
    expect(html).not.toContain("Not mine");
  });
});

describe("UIL-098 · the control says what it does — it never adds a card to her inventory", () => {
  /**
   * It read "Log a card" / "Log it ▶" with "logging it is a placement into <binder>", and for a card she did
   * not own it created inventory. Karvi: "Adding cards that I don't own to a collection should add them to
   * the wishlist, not into inventory itself." Now the only two outcomes are joining the list (a card she
   * already has in the binder) or her wishlist, and the words say both.
   */
  const modal = () =>
    renderToStaticMarkup(
      createElement(LogCardModal, {
        collection: collection(1, 1),
        busy: false,
        onClose: () => {},
        onLog: () => {},
      }),
    );

  it("names both outcomes and rules out inventory", () => {
    const html = modal();
    expect(html).toContain("Add a card");
    expect(html).toContain("goes on your wishlist");
    expect(html).toContain("never");
    expect(html).toContain("added to your inventory");
    expect(html).toContain("Add it ▶");
  });

  it("the old wording, which described a placement, is gone", () => {
    const html = modal();
    expect(html).not.toContain("Log a card");
    expect(html).not.toContain("Log it ▶");
    expect(html).not.toMatch(/logging it is a placement/i);
  });

  it("an open collection's own button says Add, not Log", () => {
    // The button lives on an OPEN collection (a finite one has its gaps' own Wishlist buttons instead).
    const open: CollectionView = { ...collection(1, 0), mode: "open" };
    expect(render(open, false)).toContain("Add a card");
    expect(render(open, false)).not.toContain("Log a card");
  });
});
