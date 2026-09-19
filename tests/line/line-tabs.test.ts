/**
 * UIL-074 — the strip renders what the loader ordered. `LineTabs` is exported from LineScreen so this
 * can be pinned without the click-driven load the screen itself needs: in "binder" view a heading opens
 * each run and the run's last tab closes its border; in "color" view the tabs run flat.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LineView } from "@/lib/line/types";
import { LineTabs } from "@/app/(ui)/line/LineScreen";

function line(id: string, species: string, bandKey: string, binderId: string | null): LineView {
  return {
    lineId: id,
    rootDexId: 1,
    speciesLabel: species,
    bandKey,
    binderId,
    binderLabel: binderId ? `${binderId.toUpperCase()} · BACK` : "Binder · BACK",
    status: "open",
    counts: { filled: 0, placeholder: 0, block: 0 },
    slots: [],
    cap: null,
    info: [],
  };
}
// Already in "binder" order, as the loader hands it over.
const LINES = [
  line("l2", "CHARMANDER LINE", "red", "b1"),
  line("l5", "SNIVY LINE", "green", "b1"),
  line("l3", "ABRA LINE", "red", "b2"),
  line("l4", "MANKEY LINE", "orange", null),
];
const render = (view: "color" | "binder") =>
  renderToStaticMarkup(
    createElement(LineTabs, { lines: LINES, view, currentId: "l3", onSelect: () => {} }),
  );
const tabs = (html: string) => [...html.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map((m) => m[0]);

describe("UIL-074 · LineTabs", () => {
  it('"binder" view: a heading opens each binder run and the run\'s last tab closes the border', () => {
    const html = render("binder");
    const heads = [...html.matchAll(/<span class="lgh u">([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(heads).toEqual(["B1 · BACK", "B2 · BACK", "NO BINDER"]);
    // Order preserved, headings interleaved where the binder changes.
    expect(html.indexOf("B1 · BACK")).toBeLessThan(html.indexOf("CHARMANDER"));
    expect(html.indexOf("SNIVY")).toBeLessThan(html.indexOf("B2 · BACK"));
    expect(html.indexOf("B2 · BACK")).toBeLessThan(html.indexOf("ABRA"));
    expect(html.indexOf("NO BINDER")).toBeLessThan(html.indexOf("MANKEY"));
    // The last tab of each run carries `gend`; the others do not.
    const gend = tabs(html).map((t) => /\bgend\b/.test(t));
    expect(gend).toEqual([false, true, true, true]);
    // The selected tab is still marked.
    expect(tabs(html)[2]).toMatch(/aria-selected="true"/);
  });

  it('"color" view: no headings, no group borders, the same four tabs', () => {
    const html = render("color");
    expect(html).not.toContain('class="lgh');
    expect(tabs(html)).toHaveLength(4);
    expect(tabs(html).some((t) => /\bgend\b/.test(t))).toBe(false);
  });
});
