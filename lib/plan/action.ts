/**
 * Cascade result → worklist action (dev-spec §5 M6; system-design §5, §7B).
 *
 * The action a row shows is derived purely from the cascade's `step` and `target`; the plan never
 * invents an action the engine didn't produce. `ACTION_ORDER` is the within-band-subgroup sort,
 * matching the prototype's `actOrder` (design/prototype.html).
 */

import type { CascadeResult } from "@/lib/engine";
import type { PlanActionKind } from "./types";

/** The physical work order inside a band sub-group. First is done first. */
export const ACTION_ORDER: readonly PlanActionKind[] = [
  "PULL",
  "FILL",
  "NEWLINE",
  "SWAP",
  "SPEC",
  "FRONT",
  "BULK",
];

/** Sort index of an action; unknown actions sort last (defensive, should not happen). */
export function actionOrder(a: PlanActionKind): number {
  const i = ACTION_ORDER.indexOf(a);
  return i === -1 ? ACTION_ORDER.length : i;
}

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
