/**
 * UIL-071, the Backfill sites. Karvi: "the search throughout the app should be uniform" — image-first,
 * because she recognises artwork before she reads a name. #212 built `CardResultsGrid` behind the text
 * list's exact `{ search, onPick, placeholder }` contract so a site migrates by changing one tag; this pins that
 * every type-ahead on the Backfill screen has.
 *
 * Why the assertion is on the SOURCE and not a render: at rest the grid and the text list it replaced
 * produced byte-identical markup (one input, `aria-label="Card lookup"`); the difference only appears
 * once a query of two-plus characters has been typed and the debounced fetch has answered, which a
 * static render in a node environment cannot drive. So the tag is what is pinned. (The text list is now
 * deleted, so the remaining risk this guards is a site quietly dropping the grid.)
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CardResultsGrid } from "@/app/(ui)/_components/CardResultsGrid";

const src = readFileSync(
  new URL("../../app/(ui)/backfill/BackfillScreen.tsx", import.meta.url),
  "utf8",
);

/** Every `<CardResultsGrid …/>` tag in the file, with its props text. */
const sites = [...src.matchAll(/<CardResultsGrid\b([\s\S]*?)\/>/g)].map((m) => m[1]);
const placeholderOf = (props: string) => /placeholder="([^"]+)"/.exec(props)?.[1] ?? null;

describe("UIL-071 · every Backfill type-ahead is the image-first grid", () => {
  it("the grid is imported on the screen", () => {
    expect(src).toContain('import { CardResultsGrid } from "../_components/CardResultsGrid";');
  });

  it("all five sites, by placeholder — none silently dropped, none left on the old tag", () => {
    expect(sites.map(placeholderOf)).toEqual([
      "Set + number or name…", // front half · in order
      "Pick a species in this line (any stage)…", // back half · start a line
      "Which printing?", // stage row · the owned printing
      "Which duplicate was repurposed?", // stage row · a repurposed-dup block
      "Set + number or name…", // specialty · flat list
    ]);
  });

  it("each site passes exactly the contract: search, onPick, placeholder", () => {
    for (const props of sites) {
      expect(props).toMatch(/\bsearch=\{lookupCatalog\}/);
      expect(props).toMatch(/\bonPick=\{\w+\}/);
      expect(placeholderOf(props)).not.toBeNull();
      // Nothing beyond the contract crept in with the swap.
      const names = [...props.matchAll(/(\w+)=/g)].map((m) => m[1]).sort();
      expect(names).toEqual(["onPick", "placeholder", "search"]);
    }
  });
});

describe("UIL-071 · the grid accepts what each Backfill site hands it", () => {
  it("renders the input with each site's placeholder, results gated until a query", () => {
    for (const placeholder of new Set(sites.map(placeholderOf))) {
      const html = renderToStaticMarkup(
        createElement(CardResultsGrid, {
          search: async () => [],
          onPick: () => {},
          placeholder: placeholder!,
        }),
      );
      expect(html).toContain(`placeholder="${placeholder}"`);
      expect(html).toContain('aria-label="Card lookup"');
      expect(html).not.toContain("listbox");
    }
  });
});
