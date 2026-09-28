/**
 * UIL-122, QA's X2: a card is a decision on the Lines screen when ANY of its proposals is the one decision Lines still
 * shows (collection-vs-line), whatever else the cascade proposed beside it. `.some`, never `.every`.
 */
import { describe, expect, it } from "vitest";
import type { CascadeResult } from "@/lib/engine";
import { resultNeedsDecision } from "@/lib/plan";

const claimedWhileALineNeedsIt = (
  other: NonNullable<CascadeResult["proposals"]>[number],
): CascadeResult =>
  ({
    incomingId: "x",
    resolvedBy: "auto",
    reason: "",
    step: "collection-claim",
    target: { kind: "specialty", binderId: "spec", collectionId: "c" },
    proposals: [{ kind: "collection-vs-line", reason: "…", lineId: "L1", stageIndex: 1 }, other],
  }) as CascadeResult;

describe("UIL-122 · a collection claim is a decision beside any other proposal (QA's X2)", () => {
  it("with a cap beside it", () => {
    expect(
      resultNeedsDecision(
        claimedWhileALineNeedsIt({ kind: "ex-only-cap", reason: "…", stageIndex: 2, dexId: 6 }),
      ),
    ).toBe(true);
  });

  it("with a swap beside it", () => {
    expect(
      resultNeedsDecision(
        claimedWhileALineNeedsIt({ kind: "holo-swap", reason: "…", displacedCopyId: "c1" }),
      ),
    ).toBe(true);
  });
});
