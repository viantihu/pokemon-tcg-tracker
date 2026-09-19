/**
 * UIL-071 step 1 — one uniform, image-first search results component. `CardResultsGrid` keeps
 * `CardLookup`'s contract and behaviour and changes only what the results look like: a grid of card
 * tiles with name / set / full collector number, not a text list.
 *
 * Static render, so the type-ahead's effect (debounce, the fetch) does not run; that logic is a verbatim
 * copy of `CardLookup`'s and is stated as such in the source. What IS pinned here is everything she sees:
 * the initial input, each tile's contents, and the three non-result states in `CardLookup`'s exact words
 * — including that a failure is shown alongside the last good results, never as "no match" (UIL-035).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CardResultTiles, CardResultsGrid } from "@/app/(ui)/_components/CardResultsGrid";
import type { LookupCard } from "@/app/(ui)/plan/plan-types";

const card = (over: Partial<LookupCard>): LookupCard => ({
  tcgdexId: "sv04-099",
  name: "Minior",
  setId: "sv04",
  setName: "Paradox Rift",
  localId: "099",
  setCardCountOfficial: 182,
  stage: "Basic",
  types: ["Fighting"],
  cardClass: "standard",
  imageUrl: null,
  variants: [],
  ...over,
});

const tiles = (over: Partial<Parameters<typeof CardResultTiles>[0]>) =>
  renderToStaticMarkup(
    createElement(CardResultTiles, {
      results: [],
      loading: false,
      failed: null,
      onPick: () => {},
      ...over,
    }),
  );

describe("UIL-071 · CardResultsGrid keeps CardLookup's contract", () => {
  it("renders the same input, with the caller's placeholder, and no results before a query", () => {
    const html = renderToStaticMarkup(
      createElement(CardResultsGrid, {
        search: async () => [],
        onPick: () => {},
        placeholder: "Search the catalog…",
      }),
    );
    expect(html).toContain('placeholder="Search the catalog…"');
    expect(html).toContain('aria-label="Card lookup"');
    expect(html).not.toContain("listbox");
  });
});

describe("UIL-071 · results are tiles: image first, then name, set, full collector number", () => {
  it("one tile per result, each a CardFace with name / set / 099-of-182 underneath", () => {
    const html = tiles({
      results: [
        card({}),
        card({
          tcgdexId: "sv03-026",
          name: "Charmander",
          setName: "Obsidian Flames",
          localId: "026",
          setCardCountOfficial: 197,
        }),
      ],
    });
    expect(html.match(/role="option"/g)?.length).toBe(2);
    expect(html).toContain('class="face m"');
    expect(html).toContain("Minior");
    expect(html).toContain("Paradox Rift");
    expect(html).toContain("099/182");
    expect(html).toContain("026/197");
    // Tiles, not the old text list.
    expect(html).toContain('class="cgrid"');
    expect(html).not.toContain('class="sugg"');
  });

  it("a set with no printed total shows the bare number, never 099/", () => {
    const html = tiles({ results: [card({ setCardCountOfficial: null })] });
    expect(html).toContain(">099<");
    expect(html).not.toContain("099/");
  });

  it("a specialty printing is flagged on its tile", () => {
    const html = tiles({ results: [card({ cardClass: "specialty" })] });
    expect(html).toContain("Specialty");
  });
});

describe("UIL-071 · the three non-result states, in CardLookup's words", () => {
  it("searching", () => {
    const html = tiles({ loading: true });
    expect(html).toContain("Searching the mirror…");
    expect(html).toContain('role="status"');
  });

  it("no match — only ever said when the search answered with nothing", () => {
    const html = tiles({});
    expect(html).toContain("No match in the local mirror.");
    expect(html).not.toContain("did not answer");
  });

  it("a failure says so, never 'no match', and keeps the last good results on screen (UIL-035)", () => {
    const html = tiles({ failed: "Could not search the catalog: timeout", results: [card({})] });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Could not search the catalog: timeout");
    expect(html).toContain("the card may well exist; the catalog just did not answer");
    expect(html).not.toContain("No match");
    // The tile she could already see is still there under the alert.
    expect(html).toContain("Minior");
    expect(html).toContain('role="option"');
  });
});
