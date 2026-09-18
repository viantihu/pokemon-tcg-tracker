/**
 * Cascade result → worklist action (dev-spec §5 M6; system-design §5, §7B).
 *
 * The action a row shows is derived purely from the cascade's `step` and `target`; the plan never
 * invents an action the engine didn't produce.
 */

import type { CascadeResult } from "@/lib/engine";
import type { PlanActionKind } from "./types";

/**
 * The seven worklist actions in physical work order (first is done first), matching the prototype's
 * `actOrder` (design/prototype.html). This was the within-sub-group sort key until UIL-076 made rows
 * sort by name instead; it remains the canonical ordered list of the action kinds.
 */
export const ACTION_ORDER: readonly PlanActionKind[] = [
  "PULL",
  "FILL",
  "NEWLINE",
  "SWAP",
  "SPEC",
  "FRONT",
  "BULK",
];

/** Map a cascade result to the single worklist action the row displays. Total: every step maps. */
export function actionForResult(result: CascadeResult): PlanActionKind {
  switch (result.step) {
    case "collection-claim":
    case "card-class":
      return "SPEC";
    case "duplicate":
      return result.swap ? "SWAP" : "BULK";
    case "line-new":
      return "NEWLINE";
    case "line-existing":
      // Filling an open placeholder/block is FILL; an extra copy of a filled stage falls to FRONT.
      return result.filledExistingSlot ? "FILL" : "FRONT";
    case "line-nonviable":
    case "basic-no-line":
    case "trainer":
      return "FRONT";
    default:
      return "FRONT";
  }
}

/** Whether the cascade attached any proposal (cap / block / termination / swap / collection-vs-line). */
export function resultNeedsDecision(result: CascadeResult): boolean {
  return (result.proposals?.length ?? 0) > 0;
}
