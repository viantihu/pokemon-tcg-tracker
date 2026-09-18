/**
 * Folded bands ride in the parked plan without touching what invalidates it (UIL-018 × UIL-006).
 *
 * UIL-006 was fixed twice because a cached plan was served against state that had moved, so adding a
 * field to that payload is the risky part of UIL-018, not the folding itself. Two invariants:
 *
 *   - folding a band must NOT drop the plan (it changes nothing the cascade read), and
 *   - a moved stamp must STILL drop it, exactly as before.
 *
 * Exercised through the real `PlanScreen`, whose `readResume` runs in a `useState` initializer during
 * the first render, against a `sessionStorage` stub. `useEffect` does not run under
 * `renderToStaticMarkup`, so this only reads the parked blob — it never writes one.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlanBandGroup } from "@/lib/plan";
import { PlanScreen } from "@/app/(ui)/plan/PlanScreen";
import type { RunPlanResult } from "@/app/(ui)/plan/plan-types";

const RESUME_KEY = "binderops.plan.v1";
const STAMP = '{"v":2,"copies":[]}';

function bandOf(bandKey: string, names: string[]): PlanBandGroup {
  return {
    bandKey,
    count: names.length,
    subgroups: [
      {
        kind: "nonbasic",
        label: "NON-BASICS",
        rows: names.map((name, i) => ({
          incomingId: `${bandKey}-${i}`,
          tcgdexId: `sv03-${bandKey}-${i}`,
          name,
          setId: "sv03",
          localId: String(i),
          imageUrl: null,
          variant: "normal" as const,
          stage: "Stage1",
          isBasic: false,
          bandKey,
          action: "FRONT" as const,
          destination: "Binder 1 · Front",
          reason: "Front half.",
          needsDecision: false,
        })),
      },
    ],
  };
}

const PLAN: RunPlanResult = {
  groups: [bandOf("red", ["Redcard"]), bandOf("green", ["Greencard"])],
  bands: [
    { key: "red", count: 1 },
    { key: "green", count: 1 },
  ],
  summary: { total: 2, decisions: 0, byAction: { FRONT: 2 } },
};

const store = new Map<string, string>();

function park(blob: Record<string, unknown>): void {
  store.set(RESUME_KEY, JSON.stringify(blob));
}

function screen(stamp = STAMP): string {
  return renderToStaticMarkup(createElement(PlanScreen, { stateStamp: stamp }));
}

/**
 * Just the worklist, cut before the spotlight `<aside>`.
 *
 * Folding is a worklist affordance, NOT a filter on the plan: the spotlight renders `flatItems[cur]`
 * and keeps showing the card she is holding even when its band is folded. Asserting on the whole
 * document would have confused "the band's rows are gone" with "the card is gone from the plan".
 */
function worklist(html: string): string {
  const start = html.indexOf('class="worklist panel"');
  const end = html.indexOf("<aside", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

beforeEach(() => {
  store.clear();
  (globalThis as unknown as { window: unknown }).window = {
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

const base = {
  stamp: STAMP,
  source: "bulk-bin",
  notes: "",
  draft: [],
  plan: PLAN,
  done: [],
  cur: 0,
  overrides: {},
};

describe("UIL-018 × UIL-006 · folded bands in the resume payload", () => {
  it("restores the plan with the folded band's rows unmounted and the others intact", () => {
    park({ ...base, collapsed: ["red"] });
    const html = screen();
    expect(html).toContain("RESUMED"); // the plan survived; it was not recomputed
    expect(worklist(html)).not.toContain("Redcard"); // folded → absent from the tree
    expect(worklist(html)).toContain("Greencard"); // untouched band still renders
  });

  it("does NOT drop the plan just because a band is folded", () => {
    // The whole point: folding is view state, so the stamp is unchanged and the run is still served.
    park({ ...base, collapsed: ["red", "green"] });
    const html = screen();
    expect(html).toContain("RESUMED");
    expect(worklist(html)).not.toContain("Redcard");
    expect(worklist(html)).not.toContain("Greencard");
    // Still HER plan: the totals come from the restored run, not from a re-run.
    expect(html).toContain("2 cards");
  });

  it("keeps the spotlight on the card she is holding even when its band is folded", () => {
    park({ ...base, collapsed: ["red"] });
    const html = screen();
    // Folding hides rows she has finished with; it must never hide the card in her hand. The folded
    // header says so, so the worklist does not look like it lost her place.
    expect(html).toContain("NOW HANDLING");
    expect(html.slice(html.indexOf("<aside"))).toContain("Redcard");
    expect(worklist(html)).toContain("HOLDING NOW");
  });

  it("still drops the plan when the stamp moved, folded or not (UIL-006 unchanged)", () => {
    park({ ...base, collapsed: ["red"] });
    const html = screen('{"v":2,"copies":[["shelved",null,null,"red",null,1]]}');
    expect(html).not.toContain("RESUMED");
    expect(html).not.toContain("Greencard");
    // Back to the intake form.
    expect(html).toContain("New haul");
  });

  it("treats a plan parked before this feature as fully expanded", () => {
    // `collapsed` absent entirely — the shape a blob written by the previous deploy has. It must not
    // fold anything, and it must not throw; her check-off progress is in the same blob.
    park({ ...base, done: ["red-0"] });
    const html = screen();
    expect(html).toContain("RESUMED");
    expect(worklist(html)).toContain("Redcard");
    expect(worklist(html)).toContain("Greencard");
    expect(html).toContain("1 / 2"); // the parked check-off came back too
  });
});

/**
 * UIL-075's own resume symmetry: a folded SUB-GROUP restores unmounted (its rows absent from the
 * tree, not CSS-hidden), the untouched sub-group renders in full, and folding a sub-group must
 * NOT drop the plan (same rule as UIL-018 one level up).
 */
describe("UIL-075 × UIL-006 · folded sub-groups in the resume payload", () => {
  it("restores the plan with the folded sub-group's rows unmounted and the other intact", () => {
    // Both bands' non-basic sub-groups folded; the whole test plan is non-basics, so every row goes.
    park({ ...base, collapsedSubgroups: ["red:nonbasic", "green:nonbasic"] });
    const html = screen();
    expect(html).toContain("RESUMED");
    expect(worklist(html)).not.toContain("Redcard");
    expect(worklist(html)).not.toContain("Greencard");
    // Totals still come from the restored run, not a re-run — she is looking at HER plan.
    expect(html).toContain("2 cards");
  });

  it("a plan parked before UIL-075 is treated as no sub-groups folded (no throw, no drop)", () => {
    // `collapsedSubgroups` absent entirely — the shape a blob written by the previous deploy has.
    park({ ...base });
    const html = screen();
    expect(html).toContain("RESUMED");
    expect(worklist(html)).toContain("Redcard");
    expect(worklist(html)).toContain("Greencard");
  });

  it("still drops the plan when the stamp moved (UIL-006 unchanged)", () => {
    park({ ...base, collapsedSubgroups: ["red:nonbasic"] });
    const html = screen('{"v":2,"copies":[["shelved",null,null,"red",null,1]]}');
    expect(html).not.toContain("RESUMED");
    expect(html).toContain("New haul");
  });
});
