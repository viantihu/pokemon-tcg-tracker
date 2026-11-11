/**
 * Her overrides (0037), written the same way by every writer. A write that overrides a rule names it in
 * `WritePayload.overrides` AND records it on an `insert_decision` of its own, or the database refuses the whole write
 * ("An override has to be recorded with the move."). So a writer DECLARES the rules its line choice put a card past,
 * and RECORDS each on its OWN decision (`recordOverrides`).
 *
 * Only the line rules reach here (`line_fit`, `line_min_stages`, UIL-135). A full bulk box and a full binder section are
 * NOT overridable: a card never goes into one at its limit. Nothing here declares `bulk_box_full`, so the database's
 * trigger (0035) refuses a write that tries. Pure.
 */
import type { OverrideRule, WriteOp } from "@/lib/repo";

type DecisionOp = Extract<WriteOp, { op: "insert_decision" }>;

/** Her overrides on a writer's own decision. Any other op, or no rule, comes back as it was. */
export function recordOverrides<T extends WriteOp>(op: T, rules: readonly OverrideRule[]): T {
  if (op.op !== "insert_decision" || rules.length === 0) return op;
  const decision = op as DecisionOp;
  return { ...decision, overrides: [...new Set([...(decision.overrides ?? []), ...rules])] } as T;
}

/**
 * The sentence a decision's reason ends with when she put the card in its line past a line rule (UIL-135): a card
 * that is not the stage's own, or a line of one card.
 */
export function lineRuleNote(rules: readonly OverrideRule[]): string {
  if (rules.includes("line_min_stages")) return " A line of one card (your call).";
  if (rules.includes("line_fit")) return " Put in this line anyway (your call).";
  return "";
}
