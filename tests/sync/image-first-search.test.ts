/**
 * UIL-071, the Sync site: pinning an unresolved entry to a catalog card. Karvi: "the search throughout
 * the app should be uniform" — image-first, because she recognises artwork before she reads a name. #212
 * built `CardResultsGrid` with `CardLookup`'s exact `{ search, onPick, placeholder }` contract so a site
 * migrates by changing one tag; this pins that the Sync screen's one type-ahead has.
 *
 * Why the assertion is on the SOURCE and not a render: at rest the two components produce byte-identical
 * markup (one input, `aria-label="Card lookup"`); the list-versus-grid difference only appears once a
 * query of two-plus characters has been typed and the debounced fetch has answered, which a static
 * render in a node environment cannot drive. So the tag is what is pinned — the same way #212 pins the
 * grid's effect against `CardLookup`'s by diffing source. Revert the swap and the first case fails.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CardResultsGrid } from "@/app/(ui)/_components/CardResultsGrid";

const src = readFileSync(new URL("../../app/(ui)/sync/SyncScreen.tsx", import.meta.url), "utf8");
const sites = [...src.matchAll(/<CardResultsGrid\b([\s\S]*?)\/>/g)].map((m) => m[1]);
const placeholderOf = (props: string) => /placeholder="([^"]+)"/.exec(props)?.[1] ?? null;

describe("UIL-071 · the Sync screen's type-ahead is the image-first grid", () => {
  it("the text-list component is neither imported nor rendered on the screen", () => {
    expect(src).not.toMatch(/\bCardLookup\b/);
    expect(src).toContain('import { CardResultsGrid } from "../_components/CardResultsGrid";');
  });

  it("exactly one site — pinning an unresolved entry — on the new tag, with CardLookup's contract", () => {
    expect(sites).toHaveLength(1);
    const props = sites[0];
    expect(props).toMatch(/\bsearch=\{\w+\}/);
    expect(props).toMatch(/\bonPick=\{[^}]+\}/);
    expect(placeholderOf(props)).not.toBeNull();
    const names = [...props.matchAll(/(\w+)=/g)].map((m) => m[1]).sort();
    expect(names).toEqual(["onPick", "placeholder", "search"]);
  });

  it("the grid renders the input with that site's placeholder, results gated until a query", () => {
    const placeholder = placeholderOf(sites[0])!;
    const html = renderToStaticMarkup(
      createElement(CardResultsGrid, { search: async () => [], onPick: () => {}, placeholder }),
    );
    expect(html).toContain(`placeholder="${placeholder}"`);
    expect(html).toContain('aria-label="Card lookup"');
    expect(html).not.toContain("listbox");
  });
});
