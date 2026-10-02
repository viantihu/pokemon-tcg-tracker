/**
 * Her overrides (0037), written the same way by every writer. Karvi, 2026-10-01/02: "The rules should exist only for
 * the recommendation engine. Users should always be able to override all rules." The app recommends, warns in her
 * words, and lets her do it anyway; a write that does names the rule in `WritePayload.overrides` AND records it on an
 * `insert_decision` of its own, or the database refuses the whole write ("An override has to be recorded with the
 * move."). So every writer that sends a card somewhere she picked:
 *
 *   - DECLARES on its payload `overridesFor` every place the write sends a card: her destination, and the places
 *     inside her line choice (`lineChoiceDestinations`), from what she asked for;
 *   - RECORDS on its OWN decision `overridesFor` the place that decision is about (`recordOverrides`), from what it
 *     did. A writer that sends a card to a full box and wrote no decision writes one (`fillerReturnedDecision`).
 *
 * Two sources, held to each other by the database: an override that no writer recorded is refused, never silent.
 *
 * One rule reaches here through a destination: bulk_box_full, a full box she picked knowingly (`overFull`). Her
 * "Shelve without a collection" (collection_pick) is the Haul Plan's own (lib/plan/commit.ts). Pure.
 */
import type { OverrideRule, WriteOp } from "@/lib/repo";
import type { LineChoice } from "./popup";
import type { MoveDestination } from "./types";

type BulkDestination = Extract<MoveDestination, { kind: "bulk" }>;
type DecisionOp = Extract<WriteOp, { op: "insert_decision" }>;

/** The rules a write overrides, from the places it sends cards: a full box she picked knowingly is bulk_box_full. */
export function overridesFor(dests: Iterable<MoveDestination | null | undefined>): OverrideRule[] {
  for (const d of dests) if (d?.kind === "bulk" && d.overFull) return ["bulk_box_full"];
  return [];
}

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

/** The sentence a decision's reason ends with when she put the card in a full box knowingly. */
export function overLimitNote(dests: Iterable<MoveDestination | null | undefined>): string {
  return overridesFor(dests).includes("bulk_box_full") ? " Over its card limit (your call)." : "";
}

/** Where a spare card coming out of its pocket goes: the box she picked (absent: its home box), knowingly full or not. */
export function returnDestination(
  copyId: string,
  choice: { returnBoxes?: Record<string, string>; returnOverFull?: readonly string[] },
): BulkDestination {
  const unitId = choice.returnBoxes?.[copyId];
  return {
    kind: "bulk",
    ...(unitId ? { unitId } : {}),
    ...(choice.returnOverFull?.includes(copyId) ? { overFull: true as const } : {}),
  };
}

/** The spare cards she sends into a full box knowingly, as the places they go. */
export function returnDestinations(choice: {
  returnBoxes?: Record<string, string>;
  returnOverFull?: readonly string[];
}): BulkDestination[] {
  return (choice.returnOverFull ?? []).map((copyId) => returnDestination(copyId, choice));
}

/**
 * Every place her line choice sends a card besides the line: a replace's card coming out (and, when it goes into
 * another line, that line's spare cards), a kept card's own place, and a join's spare cards going back.
 */
export function lineChoiceDestinations(choice: LineChoice | null | undefined): MoveDestination[] {
  if (!choice) return [];
  switch (choice.mode) {
    case "start":
      return [];
    case "join":
      return returnDestinations(choice);
    case "replace":
      if (choice.keep) return choice.incoming ? [choice.incoming] : [];
      return [choice.outgoing, ...lineChoiceDestinations(choice.outgoingLine)];
  }
}

/**
 * The decision for a spare card she sent back into a full box knowingly (UIL-130's returns wrote none before 0037: a
 * return to a box with room is no decision of hers). Her words name the box and that it is over its limit.
 */
export function fillerReturnedDecision(
  copyId: string,
  boxName: string,
  dest: BulkDestination,
): DecisionOp {
  return recordOverrides(
    {
      op: "insert_decision",
      haul_id: null,
      copy_id: copyId,
      decision: "filler-returned",
      reason: `Back to bulk from its pocket, into ${boxName}, over its card limit (your call).`,
      resolved_by: "user",
    },
    overridesFor([dest]),
  );
}
