/**
 * Foldable sub-groups on the Haul Plan (UIL-075) — the finer level under UIL-018's band fold.
 *
 * The pre-fix render is `group.subgroups.map((sub) => <>{sub.label}{sub.rows.map(...)}</>)`, always,
 * once the band was expanded. So the two halves of the requirement are the same as UIL-018's, one
 * level down:
 *
 *   1. she can hide a stage she has finished with, and
 *   2. a folded stage costs nothing to have.
 *
 * (2) is the easy one to fake. `display: none` satisfies every visual and scroll-position check while
 * leaving every row mounted, re-rendering on every check-off, and holding a `CardFace` (with an
 * `<img>`) each. So these tests assert ABSENCE FROM THE TREE — no row markup at all, no `<img>`, no
 * `display:none` — rather than a class name or a style. A test that only looked for `.folded` on the
 * sub-head would have passed against a CSS-only fix.
 *
 * Pre-fix failure was verified by mutation, not asserted: forcing `subFolded = false` in BandSection
 * (the pre-UIL-075 behaviour, every sub-group always rendered) fails 6 of these 10; restored, 10/10.
 * The parity case at the bottom pins the OTHER half — with nothing folded, the render is unchanged
 * from what UIL-018 shipped, so this feature adds a control without altering the default page.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlanBandGroup, PlanItem } from "@/lib/plan";
import { BandSection, subgroupKey } from "@/app/(ui)/plan/PlanScreen";

function item(n: number, isBasic: boolean, bandKey = "red"): PlanItem {
  return {
    incomingId: `c${n}`,
    tcgdexId: `sv03-${n}`,
    name: `${isBasic ? "Basic" : "Stage"} ${n}`,
    setId: "sv03",
    localId: String(n),
    imageUrl: `https://assets.tcgdex.net/en/sv/sv03/${n}`,
    variant: "normal",
    stage: isBasic ? "Basic" : "Stage1",
    isBasic,
    bandKey,
    action: "FRONT",
    destination: "Binder 1 · Front · Red",
    reason: "Front half.",
    needsDecision: false,
  };
}

function band(basics: number, nonbasics: number, bandKey = "red"): PlanBandGroup {
  let n = 0;
  const rows = (count: number, isBasic: boolean) =>
    Array.from({ length: count }, () => item(++n, isBasic, bandKey));
  const subgroups = [];
  if (basics > 0)
    subgroups.push({ kind: "basic" as const, label: "BASICS", rows: rows(basics, true) });
  if (nonbasics > 0) {
    subgroups.push({
      kind: "nonbasic" as const,
      label: "STAGE 1 · 2",
      rows: rows(nonbasics, false),
    });
  }
  return { bandKey, count: basics + nonbasics, subgroups };
}

function render(
  group: PlanBandGroup,
  bandCollapsed: boolean,
  collapsedSubgroups: Set<string>,
  over: Record<string, unknown> = {},
): string {
  return renderToStaticMarkup(
    createElement(BandSection, {
      group,
      collapsed: bandCollapsed,
      onToggleCollapse: () => {},
      doneCount: 0,
      holdsCurrent: false,
      cur: 0,
      flatIndex: new Map(group.subgroups.flatMap((s) => s.rows).map((r, i) => [r.incomingId, i])),
      done: new Set<string>(),
      onSelect: () => {},
      onShelve: () => {},
      shelving: null,
      overrides: {},
      overrideNames: null,
      collapsedSubgroups,
      onToggleSubgroupCollapse: () => {},
      ...over,
    }),
  );
}

const rowCount = (html: string) => html.split('class="row').length - 1;

describe("UIL-075 · a folded sub-group does not render its rows", () => {
  const G = band(3, 4);

  it("renders every row when both sub-groups are expanded (pre-fix parity, band expanded)", () => {
    const html = render(G, false, new Set());
    expect(rowCount(html)).toBe(7);
    expect(html).toContain("BASICS");
    expect(html).toContain("STAGE 1 · 2");
    expect(html).toContain("Basic 1");
    // `band()`'s `n` continues across sub-groups: 3 basics get 1..3, then 4 non-basics get 4..7.
    expect(html).toContain("Stage 4");
    expect(html).toContain("Stage 7");
  });

  it("folding BASICS unmounts its rows and leaves STAGE 1 · 2 alone", () => {
    const html = render(G, false, new Set([subgroupKey("red", "basic")]));
    // The three basics are gone; the four non-basics (Stage 4..7) stay.
    expect(rowCount(html)).toBe(4);
    expect(html).not.toContain("Basic 1");
    expect(html).not.toContain("Basic 2");
    expect(html).not.toContain("Basic 3");
    expect(html).toContain("Stage 4");
    expect(html).toContain("Stage 7");
    // The BASICS header stays — same rule as UIL-018 at the band level; finding the sub-group she is
    // on is the point of leaving the header behind.
    expect(html).toContain("BASICS");
    expect(html).toContain("STAGE 1 · 2");
  });

  it("renders NO rows when both sub-groups are folded — absent from the tree, not hidden by style", () => {
    const html = render(
      G,
      false,
      new Set([subgroupKey("red", "basic"), subgroupKey("red", "nonbasic")]),
    );
    expect(rowCount(html)).toBe(0);
    expect(html).not.toContain("Basic 1");
    expect(html).not.toContain("Stage 4");
    // The images from UIL-016 must not be sitting mounted-but-invisible either.
    expect(html).not.toContain("<img");
    // The tell-tales of a CSS-only fix. If any of these appears, the rows are still mounted.
    expect(html).not.toContain("display:none");
    expect(html).not.toContain("display: none");
    expect(html).not.toMatch(/\shidden[=\s>]/);
    // Both headers stay.
    expect(html).toContain("BASICS");
    expect(html).toContain("STAGE 1 · 2");
  });

  it("keeps the sub-group header and reports aria-expanded honestly in both states", () => {
    const openHtml = render(G, false, new Set());
    // Two sub-group headers, both open.
    expect(openHtml.match(/aria-expanded="true"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    const foldedHtml = render(G, false, new Set([subgroupKey("red", "basic")]));
    expect(foldedHtml).toContain('class="subhead u folded"');
    // A single sub-head is closed and the other is open, so both attribute values appear.
    expect(foldedHtml).toContain('aria-expanded="false"');
    expect(foldedHtml).toContain('aria-expanded="true"');
  });

  it("carries the sub-group's check-off count on the header when folded", () => {
    const doneIds = new Set(["c1", "c2"]); // c1 and c2 are basics 1 and 2 in `band()`'s numbering
    const html = render(G, false, new Set([subgroupKey("red", "basic")]), { done: doneIds });
    expect(html).toContain("2 / 3 CARDS");
  });

  it("flags the folded sub-group that holds the spotlight card so her place is not lost", () => {
    // Cursor on the FIRST basic (index 0 in flatIndex), sub-group "basic" folded.
    const html = render(G, false, new Set([subgroupKey("red", "basic")]), { cur: 0 });
    expect(html).toContain("HOLDING NOW");
    // Same UX rule as UIL-018: only while folded — expanded, the `.cur` row is visible and says so.
    const openHtml = render(G, false, new Set(), { cur: 0 });
    expect(openHtml).not.toContain("HOLDING NOW");
  });

  it("does nothing when the outer band itself is folded (UIL-018 wins the outer fight)", () => {
    // Everything below the band header must already be gone regardless of the sub-group state.
    const html = render(G, true, new Set([subgroupKey("red", "basic")]));
    expect(rowCount(html)).toBe(0);
    expect(html).not.toContain("BASICS");
    expect(html).not.toContain("STAGE 1 · 2");
  });
});

describe("UIL-075 · at Karvi's actual scale", () => {
  // 702 cards was the real haul. In a band whose 702 rows are all non-basics, folding the sub-group
  // is what actually saves the mount — the outer band header is not enough on its own.
  const big = band(0, 702);

  it("mounts 702 rows expanded and zero once the non-basic sub-group is folded", () => {
    expect(rowCount(render(big, false, new Set()))).toBe(702);
    expect(rowCount(render(big, false, new Set([subgroupKey("red", "nonbasic")])))).toBe(0);
  });

  it("saves markup by orders of magnitude, not the few bytes a display:none wrapper would save", () => {
    const open = render(big, false, new Set()).length;
    const shut = render(big, false, new Set([subgroupKey("red", "nonbasic")])).length;
    // Not a perf benchmark — a floor check that the saving is structural, i.e. the rows really are
    // absent from the tree.
    expect(shut).toBeLessThan(open / 100);
  });
});

describe("UIL-075 · default state is unchanged from UIL-018", () => {
  it("with NO sub-group folded, every sub-group renders every row (the shape develop had before)", () => {
    // Everything expanded is still the default (a fresh plan should look like the plan), so the
    // pre-UIL-075 render and this one must agree row-for-row when nothing is folded.
    const html = render(band(3, 4), false, new Set());
    expect(rowCount(html)).toBe(7);
    expect(html).toContain("BASICS");
    expect(html).toContain("STAGE 1 · 2");
  });
});
