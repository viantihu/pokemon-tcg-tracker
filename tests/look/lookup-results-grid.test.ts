/**
 * UIL-071 — the standalone Lookup tab's type-ahead is the image-first grid, not the text list.
 *
 * Karvi: "the search throughout the app should be uniform", and it leads with the image because she
 * recognises artwork before she reads a name. `CardResultsGrid` (UIL-071 step 1) is that presentation
 * behind `CardLookup`'s exact contract, migrated one call site per PR. This is the Lookup site — the
 * "Where is my…" box she types into to find a card on the shelf.
 *
 * Why the two type-aheads are stubbed: they render IDENTICAL markup until she has typed two characters
 * (an input, nothing else), and `renderToStaticMarkup` cannot type. So which one the screen composes is
 * invisible to a plain render. Each stub returns a marker and RECORDS the props it was given, which makes
 * the composition visible and pins that the swap changed the tag and nothing beside it: same `search`
 * (Lookup's own server action), same `onPick`, the same "Where is my…" placeholder. What the grid itself
 * renders is pinned in tests/coll/card-results-grid.test.ts.
 *
 * Revert-checked by swapping the tag back to `CardLookup`: the first test then fails on the marker
 * and on the recorded props.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LookupScreen } from "@/app/(ui)/look/LookupScreen";
import { searchCatalog } from "@/app/(ui)/look/actions";

const seen = vi.hoisted(() => ({
  grid: [] as Record<string, unknown>[],
  list: [] as Record<string, unknown>[],
}));

vi.mock("@/app/(ui)/_components/CardResultsGrid", () => ({
  CardResultsGrid: (props: Record<string, unknown>) => {
    seen.grid.push(props);
    return "[typeahead:grid]";
  },
}));
vi.mock("@/app/(ui)/_components/CardLookup", () => ({
  CardLookup: (props: Record<string, unknown>) => {
    seen.list.push(props);
    return "[typeahead:list]";
  },
}));

/** A fresh screen: nothing looked up yet, so the type-ahead and the footer are all there is. */
const screen = () => renderToStaticMarkup(createElement(LookupScreen, {}));

beforeEach(() => {
  seen.grid.length = 0;
  seen.list.length = 0;
});

describe("UIL-071 · Lookup composes CardResultsGrid, with CardLookup's props unchanged", () => {
  it("renders the grid type-ahead and not the text list", () => {
    const html = screen();
    expect(html).toContain("[typeahead:grid]");
    expect(html).not.toContain("[typeahead:list]");
    expect(seen.grid).toHaveLength(1);
    expect(seen.list).toHaveLength(0);
  });

  it("hands the grid Lookup's own search action, an onPick, and her 'Where is my…' prompt", () => {
    screen();
    const props = seen.grid[0];
    // The same server action the text list was given — the swap moved no wiring.
    expect(props.search).toBe(searchCatalog);
    expect(typeof props.onPick).toBe("function");
    // The one per-site override this screen always had, kept word for word.
    expect(props.placeholder).toBe("Where is my…");
  });

  it("sits where the text list sat: first thing in the screen, above the footer", () => {
    const html = screen();
    const wrap = html.indexOf('class="lookwrap"');
    const grid = html.indexOf("[typeahead:grid]");
    const foot = html.indexOf("BINDER → HALF → BAND");
    expect(wrap).toBeGreaterThan(-1);
    expect(foot).toBeGreaterThan(-1);
    expect(grid).toBeGreaterThan(wrap);
    expect(grid).toBeLessThan(foot);
  });
});
