/**
 * UIL-071 — the Haul Plan's add-card type-ahead is the image-first grid, not the text list.
 *
 * Karvi: "the search throughout the app should be uniform", and it leads with the image because she
 * recognises artwork before she reads a name. `CardResultsGrid` (UIL-071 step 1) is that presentation
 * behind `CardLookup`'s exact contract, migrated one call site per PR. This is the Plan intake site.
 *
 * Why the two type-aheads are stubbed: they render IDENTICAL markup until she has typed two characters
 * (an input, nothing else), and `renderToStaticMarkup` cannot type. So which one the intake panel
 * composes is invisible to a plain render. Each stub returns a marker and RECORDS the props it was given,
 * which makes the composition visible and pins that the swap changed the tag and nothing beside it:
 * same `search` (the Plan's own server action), same `onPick`, no placeholder override. What the grid
 * itself renders is pinned in tests/coll/card-results-grid.test.ts.
 *
 * Revert-checked by swapping the tag back to `CardLookup`: the first test then fails on the marker
 * and on the recorded props.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlanScreen } from "@/app/(ui)/plan/PlanScreen";
import { lookupCatalog } from "@/app/(ui)/plan/actions";

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

/** A fresh screen: no parked plan (`readResume` sees no `window`), no seeded queue → the intake panel. */
const intake = () => renderToStaticMarkup(createElement(PlanScreen, {}));

beforeEach(() => {
  seen.grid.length = 0;
  seen.list.length = 0;
});

describe("UIL-071 · Plan intake composes CardResultsGrid, with CardLookup's props unchanged", () => {
  it("renders the grid type-ahead and not the text list", () => {
    const html = intake();
    expect(html).toContain("[typeahead:grid]");
    expect(html).not.toContain("[typeahead:list]");
    expect(seen.grid).toHaveLength(1);
    expect(seen.list).toHaveLength(0);
  });

  it("hands the grid the Plan's own search action and an onPick, and leaves the placeholder to the grid", () => {
    intake();
    const props = seen.grid[0];
    // The same server action the text list was given — the swap moved no wiring.
    expect(props.search).toBe(lookupCatalog);
    expect(typeof props.onPick).toBe("function");
    // No per-site override: the grid's own default ("Set + number or name…") is what she reads.
    expect(props.placeholder).toBeUndefined();
  });

  it("sits where the text list sat: under the haul header, above the empty-draft hint", () => {
    const html = intake();
    const header = html.indexOf("New haul");
    const grid = html.indexOf("[typeahead:grid]");
    const hint = html.indexOf("Add cards by set + number or name.");
    expect(header).toBeGreaterThan(-1);
    expect(hint).toBeGreaterThan(-1);
    expect(grid).toBeGreaterThan(header);
    expect(grid).toBeLessThan(hint);
  });
});
