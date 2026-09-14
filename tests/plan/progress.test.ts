/**
 * The haul-bar progress strip must stay bounded (UIL-007).
 *
 * One pip per card blew the page open once the plan started arriving pre-populated: `.xp i` carries a
 * 2px border per side that flex cannot shrink, plus a 3px gap, so 685 cards forced the strip to
 * ~4,800px. Measured in a browser at a 375px viewport before the fix: strip 4792px, haul bar
 * overflowing its own panel, page scrolling sideways by ~4,400px. After: 243px, no overflow anywhere.
 *
 * These tests pin the invariant that keeps it that way — the pip count is capped no matter the haul —
 * and that a normal typed haul is completely unchanged.
 */
import { describe, expect, it } from "vitest";
import { MAX_PROGRESS_PIPS, progressPips } from "@/lib/plan";

const flags = (n: number, doneCount = 0) => Array.from({ length: n }, (_, i) => i < doneCount);

describe("progressPips is bounded", () => {
  it("never renders more pips than the cap, at any haul size", () => {
    for (const n of [0, 1, 39, 40, 41, 100, 685, 5000]) {
      expect(progressPips(flags(n)).length).toBeLessThanOrEqual(MAX_PROGRESS_PIPS);
    }
  });

  it("caps a real Dex-sized haul", () => {
    // The size that actually broke: ~685 owned rows in her export.
    expect(progressPips(flags(685)).length).toBe(MAX_PROGRESS_PIPS);
  });

  it("stays within the width the narrowest layout allows", () => {
    // Each pip costs 4px of non-shrinkable border + a 3px gap; the haul bar's content box is ~341px
    // at a 375px viewport. This is the arithmetic that made the cap 40 rather than a round number.
    const perPip = 4 + 3;
    expect(MAX_PROGRESS_PIPS * perPip).toBeLessThan(341);
  });
});

describe("progressPips leaves a normal haul exactly as it was", () => {
  it("is per-card and order-exact below the cap", () => {
    const doneFlags = [true, false, true, false, false];
    expect(progressPips(doneFlags)).toEqual(doneFlags);
  });

  it("preserves out-of-order ticks below the cap, which the strip used to show", () => {
    const doneFlags = flags(10).map((_, i) => i === 7);
    const pips = progressPips(doneFlags);
    expect(pips[7]).toBe(true);
    expect(pips.filter(Boolean)).toHaveLength(1);
  });

  it("passes through at exactly the cap", () => {
    const doneFlags = flags(MAX_PROGRESS_PIPS, 5);
    expect(progressPips(doneFlags)).toEqual(doneFlags);
  });

  it("renders nothing for an empty haul", () => {
    expect(progressPips([])).toEqual([]);
  });
});

describe("progressPips buckets proportionally above the cap", () => {
  it("shows nothing filled at zero progress and everything at completion", () => {
    expect(progressPips(flags(685, 0), 40).filter(Boolean)).toHaveLength(0);
    expect(progressPips(flags(685, 685), 40).filter(Boolean)).toHaveLength(40);
  });

  it("fills about half the strip at half done", () => {
    const half = progressPips(flags(400, 200), 40).filter(Boolean).length;
    expect(half).toBe(20);
  });

  it("is monotonic — working through the stack never un-fills a pip", () => {
    let prev = -1;
    for (let doneCount = 0; doneCount <= 685; doneCount += 17) {
      const filled = progressPips(flags(685, doneCount), 40).filter(Boolean).length;
      expect(filled).toBeGreaterThanOrEqual(prev);
      prev = filled;
    }
  });

  it("does not claim a pip for partial progress it has not reached", () => {
    // 1 of 685 done is far below the first bucket's 1/40 share, so nothing lights up yet.
    expect(progressPips(flags(685, 1), 40).filter(Boolean)).toHaveLength(0);
  });

  it("counts completion regardless of WHICH cards were ticked", () => {
    const firstTen = flags(100).map((_, i) => i < 10);
    const lastTen = flags(100).map((_, i) => i >= 90);
    expect(progressPips(firstTen, 10)).toEqual(progressPips(lastTen, 10));
  });

  it("survives a nonsense cap without dividing by zero or looping", () => {
    expect(progressPips(flags(100), 0)).toHaveLength(1);
    expect(progressPips(flags(100), -5)).toHaveLength(1);
  });
});
