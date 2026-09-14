/**
 * Foldable colour bands on the Haul Plan (UIL-018).
 *
 * The requirement has two halves and they need different assertions:
 *
 *   1. she can get past a band she has finished, and
 *   2. a folded band costs nothing to have.
 *
 * (2) is the one that is easy to fake. `display: none` satisfies every visual and scroll-position
 * check while leaving all 702 rows mounted, re-rendering on every check-off, and holding a `CardFace`
 * (and, since UIL-016, an `<img>`) each. So these tests assert ABSENCE FROM THE TREE — no row markup
 * at all — rather than a class name or a style. A test that only looked for `.folded` would have
 * passed against a CSS-only fix.
 *
 * Rendered with `react-dom/server`, which needs no DOM, so this runs in the suite's node environment.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlanBandGroup, PlanItem } from "@/lib/plan";
import { BandSection } from "@/app/(ui)/plan/PlanScreen";

function item(n: number, isBasic = false): PlanItem {
  return {
    incomingId: `c${n}`,
    tcgdexId: `sv03-${n}`,
    name: `Testcard ${n}`,
    setId: "sv03",
    localId: String(n),
    imageUrl: `https://assets.tcgdex.net/en/sv/sv03/${n}`,
    variant: "normal",
    stage: isBasic ? "Basic" : "Stage1",
    isBasic,
    bandKey: "red",
    action: "FRONT",
    destination: "Binder 1 · Front · Red",
    reason: "Front half.",
    needsDecision: false,
  };
}

/** A band with `basics` basic rows and `nonbasics` non-basic ones, mirroring `groupPlan`'s shape. */
function band(basics: number, nonbasics: number, bandKey = "red"): PlanBandGroup {
  let n = 0;
  const rows = (count: number, isBasic: boolean) =>
    Array.from({ length: count }, () => ({ ...item(++n, isBasic), bandKey }));
  const subgroups = [];
  if (basics > 0)
    subgroups.push({ kind: "basic" as const, label: "BASICS", rows: rows(basics, true) });
  if (nonbasics > 0) {
    subgroups.push({
      kind: "nonbasic" as const,
      label: "NON-BASICS",
      rows: rows(nonbasics, false),
    });
  }
  return { bandKey, count: basics + nonbasics, subgroups };
}

function render(
  group: PlanBandGroup,
  collapsed: boolean,
  over: Record<string, unknown> = {},
): string {
  return renderToStaticMarkup(
    createElement(BandSection, {
      group,
      collapsed,
      onToggleCollapse: () => {},
      doneCount: 0,
      holdsCurrent: false,
      cur: 0,
      flatIndex: new Map(group.subgroups.flatMap((s) => s.rows).map((r, i) => [r.incomingId, i])),
      done: new Set<string>(),
      onSelect: () => {},
      onShelve: () => {},
      shelving: null,
      ...over,
    }),
  );
}

const rowCount = (html: string) => html.split('class="row').length - 1;

describe("UIL-018 · a folded band does not render its rows", () => {
  it("renders every row when expanded", () => {
    const html = render(band(3, 4), false);
    expect(rowCount(html)).toBe(7);
    expect(html).toContain("Testcard 1");
    expect(html).toContain("Testcard 7");
    expect(html).toContain("BASICS");
  });

  it("renders NO rows when folded — absent from the tree, not hidden by a style", () => {
    const html = render(band(3, 4), true);
    expect(rowCount(html)).toBe(0);
    expect(html).not.toContain("Testcard");
    // The sub-group headers go with them, and so do the images UIL-016 just added.
    expect(html).not.toContain("BASICS");
    expect(html).not.toContain("<img");
    // The tell-tales of a CSS-only fix. If any of these appear, the rows are still mounted.
    expect(html).not.toContain("display:none");
    expect(html).not.toContain("display: none");
    // The `hidden` ATTRIBUTE, not `aria-hidden` (the caret legitimately carries that).
    expect(html).not.toMatch(/\shidden[=\s>]/);
  });

  it("keeps the header, because finding the band she is on is the point", () => {
    const html = render(band(3, 4), true);
    // bandMeta resolves the display label off the band key.
    expect(html).toContain('class="bandhead folded"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("chip");
  });

  it("reports aria-expanded honestly in both states", () => {
    expect(render(band(1, 1), false)).toContain('aria-expanded="true"');
    expect(render(band(1, 1), true)).toContain('aria-expanded="false"');
  });

  it("folds an empty reserved band too, so ten bands of nothing are not ten paragraphs", () => {
    const empty: PlanBandGroup = { bandKey: "pink", count: 0, subgroups: [] };
    expect(render(empty, false)).toContain("Reserved. The slot holds even at zero.");
    expect(render(empty, true)).not.toContain("Reserved. The slot holds even at zero.");
    expect(render(empty, true)).toContain("RESERVED · 0");
  });
});

describe("UIL-018 · at Karvi's actual scale", () => {
  // 702 cards was the real haul. The band sizes she reported (43, 71, …) are the per-band slice.
  const big = band(0, 702);

  it("mounts 702 rows expanded and zero folded", () => {
    expect(rowCount(render(big, false))).toBe(702);
    expect(rowCount(render(big, true))).toBe(0);
  });

  it("costs a header's worth of markup once folded, not a page's worth", () => {
    const open = render(big, false).length;
    const shut = render(big, true).length;
    // Not a perf benchmark — a floor check that the saving is structural (orders of magnitude) and
    // not the few bytes a `style="display:none"` wrapper would save.
    expect(shut).toBeLessThan(open / 100);
  });
});

describe("UIL-018 · folding interacts with check-off rather than ignoring it", () => {
  it("carries the band's check-off count on the header, since folded rows show nothing", () => {
    const html = render(band(0, 43), true, { doneCount: 12 });
    expect(html).toContain("12 / 43 CARDS");
  });

  it("flags the folded band that holds the spotlight card so her place is not lost", () => {
    expect(render(band(0, 43), true, { holdsCurrent: true })).toContain("HOLDING NOW");
    // Only while folded — expanded, the `.cur` row is visible and says it itself.
    expect(render(band(0, 43), false, { holdsCurrent: true })).not.toContain("HOLDING NOW");
  });

  it("does not auto-fold a finished band — check-off informs the choice, it does not make it", () => {
    const g = band(0, 3);
    const allDone = new Set(g.subgroups.flatMap((s) => s.rows).map((r) => r.incomingId));
    const html = render(g, false, { done: allDone, doneCount: 3 });
    expect(rowCount(html)).toBe(3);
    expect(html).toContain("3 / 3 CARDS");
  });
});
