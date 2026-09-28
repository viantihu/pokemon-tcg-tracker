/**
 * Cascade step → worklist action mapping + decision flag (dev-spec §5 M6). Smoke coverage for the
 * derivation that drives every plan row's action chip and "Decide" badge.
 */

import { describe, expect, it } from "vitest";
import type { CascadeResult } from "@/lib/engine";
import { actionForResult, resultNeedsDecision } from "@/lib/plan";

function base(over: Partial<CascadeResult> & Pick<CascadeResult, "step">): CascadeResult {
  return {
    incomingId: "x",
    resolvedBy: "auto",
    reason: "",
    target: { kind: "bulk" },
    ...over,
  } as CascadeResult;
}

describe("actionForResult", () => {
  it("routes collection-claim and card-class to SPEC", () => {
    expect(actionForResult(base({ step: "collection-claim" }))).toBe("SPEC");
    expect(actionForResult(base({ step: "card-class" }))).toBe("SPEC");
  });

  it("distinguishes a holo-swap from a plain bulk duplicate", () => {
    const swap = base({
      step: "duplicate",
      swap: {
        incomingInherits: {
          binderId: "b",
          binderHalf: "front",
          colorBand: "red",
          lineSlotId: null,
        },
        displacedCopyId: "c1",
      },
    });
    expect(actionForResult(swap)).toBe("SWAP");
    expect(actionForResult(base({ step: "duplicate" }))).toBe("BULK");
  });

  it("maps line steps: new line → NEWLINE, filled slot → FILL, extra copy → FRONT", () => {
    expect(actionForResult(base({ step: "line-new" }))).toBe("NEWLINE");
    expect(
      actionForResult(
        base({ step: "line-existing", filledExistingSlot: { lineId: "L", stageIndex: 1 } }),
      ),
    ).toBe("FILL");
    expect(actionForResult(base({ step: "line-existing" }))).toBe("FRONT");
  });

  it("routes basics, non-viable lines, and trainers to FRONT", () => {
    expect(actionForResult(base({ step: "basic-no-line" }))).toBe("FRONT");
    expect(actionForResult(base({ step: "line-nonviable" }))).toBe("FRONT");
    expect(actionForResult(base({ step: "trainer" }))).toBe("FRONT");
  });

  it("flags a decision only for the one the Lines screen still shows: a collection claims what a line needs (UIL-122)", () => {
    expect(resultNeedsDecision(base({ step: "basic-no-line" }))).toBe(false);
    // PRE-FIX: true for every proposal, so the banner sent her to a Lines screen with nothing for the card.
    for (const p of [
      { kind: "termination" as const, reason: "…" },
      { kind: "block" as const, reason: "…", stageIndex: 1, dexId: 5 },
      { kind: "root-block" as const, reason: "…", stageIndex: 0, dexId: 4 },
      { kind: "ex-only-cap" as const, reason: "…", stageIndex: 2, dexId: 6 },
      { kind: "holo-swap" as const, reason: "…", displacedCopyId: "c" },
    ]) {
      expect(resultNeedsDecision(base({ step: "line-nonviable", proposals: [p] }))).toBe(false);
    }
    expect(
      resultNeedsDecision(
        base({
          step: "collection-claim",
          proposals: [{ kind: "collection-vs-line", reason: "…", lineId: "L1", stageIndex: 1 }],
        }),
      ),
    ).toBe(true);
  });
});
