/**
 * The Haul Plan's line picker (UIL-070 part 1) — the same derivation the Line screen uses, run against
 * the plan context the spotlight already loads. `loadPlanContext` holds every input `buildLineJoinIndex`
 * needs (lines, slot rows, catalog, type→band map, ordered bands), so offering a draft card the lines
 * it could join costs no new query shape and cannot disagree with what the Line screen would offer
 * the same printing.
 */

import { buildLineJoinIndex, joinOptionsFor, type LineJoinOptions } from "@/lib/line/join-options";
import type { PlanContext } from "./context";

/** Null when the printing is unknown to the mirror or has no species (Trainer/Energy). */
export function lineJoinOptionsFromContext(
  pc: PlanContext,
  tcgdexId: string,
): LineJoinOptions | null {
  const card = pc.catalogById.get(tcgdexId);
  if (!card) return null;
  const index = buildLineJoinIndex(
    pc.ctx.lines,
    pc.slotRowsByLine,
    pc.ctx.catalog,
    (id) => pc.copyRowById.get(id)?.catalog_card_id ?? null,
  );
  return joinOptionsFor(card, index, pc.ctx.typeColorMap, pc.ctx.catalog);
}
