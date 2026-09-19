/**
 * UIL-071 — the standalone Lookup tab's type-ahead is the image-first grid, not the text list.
 *
 * Karvi: "the search throughout the app should be uniform", and it leads with the image because she
 * recognises artwork before she reads a name. `CardResultsGrid` (UIL-071 step 1) is that presentation
 * — the app's one inline type-ahead, which replaced the text list one call site per PR. This is the Lookup site — the
 * "Where is my…" box she types into to find a card on the shelf.
 *
 * Why the type-ahead is stubbed: it renders an input and nothing else until she has typed two characters,
 * and `renderToStaticMarkup` cannot type, so what the screen hands it is invisible to a plain render. The
 * stub returns a marker and RECORDS the props it was given, which makes the composition visible and pins
 * the wiring: same `search`
 * (Lookup's own server action), same `onPick`, the same "Where is my…" placeholder. What the grid itself
 * renders is pinned in tests/coll/card-results-grid.test.ts.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LookupScreen } from "@/app/(ui)/look/LookupScreen";
import { searchCatalog } from "@/app/(ui)/look/actions";

const seen = vi.hoisted(() => ({ grid: [] as Record<string, unknown>[] }));

vi.mock("@/app/(ui)/_components/CardResultsGrid", () => ({
  CardResultsGrid: (props: Record<string, unknown>) => {
    seen.grid.push(props);
    return "[typeahead:grid]";
  },
}));

/** A fresh screen: nothing looked up yet, so the type-ahead and the footer are all there is. */
const screen = () => renderToStaticMarkup(createElement(LookupScreen, {}));

beforeEach(() => {
  seen.grid.length = 0;
});

describe("UIL-071 · Lookup composes CardResultsGrid, with the wiring unchanged", () => {
  it("renders the grid type-ahead, once", () => {
    const html = screen();
    expect(html).toContain("[typeahead:grid]");
    expect(seen.grid).toHaveLength(1);
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
