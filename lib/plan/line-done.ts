/**
 * When a line is DONE, for the Haul Plan's step-through (UIL-120). Karvi: "Once the line is complete, it should not
 * open the popup again for the next card automatically."
 *
 * DONE means nothing in the line is left to chase: every slot holds a card or is a block, and no placeholder is
 * waiting for one. That is her sense of "complete", which the `complete` status is not: a block slot is never
 * filled, so a line with one never reads `complete` however full it is (the Flygon line), and a Keep or a Swap on a
 * line that was already complete changes no status at all. #402 stopped only when a confirm turned the status to
 * `complete`, and she tested past it.
 *
 * ONE RULE, here and nowhere else. The server answers it over the line as it is once the write has landed
 * (`lineDoneAfterWrite` in ./commit), and the popup forecasts it for its "· next" label from the same function.
 *
 * SINCE UIL-121 (0030) a line reads OPEN or CLOSED, and CLOSED is done: every stage is filled, left empty or a
 * filler, including a line she declined to finish. The #410 slot rule stays beside it, not replaced (the Senior BA's
 * ruling): until every writer has moved, one can fill a line's last slot and leave a stale status behind, and that
 * line must still stop the popup. So DONE is: the status reads closed, OR no slot is a placeholder still waiting.
 *
 * Pure, and free of I/O imports, so the client popup can use it.
 */

import { lineReadsClosed, type LineProposal } from "@/lib/line/popup";

/**
 * The line a card's proposal routes it into, as one key (UIL-120, the Senior BA's ruling on #430): an existing line by
 * its id, or the new line a start would write by the identity the commit gives it (binder, root species, band,
 * language: `newLineKey`), so two cards that would start the SAME line match before it has an id. Null for a card
 * headed into no line: a front half, a collection, the bulk box.
 */
export function lineKeyOf(
  proposal: LineProposal | null | undefined,
  startsLine?: string | null,
): string | null {
  if (!proposal) return null;
  if (proposal.kind === "start") return startsLine ? `new:${startsLine}` : null;
  return lineKeyFor(proposal.lineId);
}

/** An existing line's key. */
export function lineKeyFor(lineId: string): string {
  return `line:${lineId}`;
}

/** The identity of a line not written yet: the one the commit keys a line started earlier in the same pass on. */
export function newLineKey(
  binderId: string | null,
  rootDexId: number,
  colorBand: string,
  locale: string,
  /** The line's form (UIL-133): an Arven's line and a plain one of one species are two lines. Null is plain. */
  form: string | null,
): string {
  return `${binderId ?? ""}:${rootDexId}:${colorBand}:${locale}:${form ?? ""}`;
}

/** A card still waiting in this haul, as the step-through reads it: its species, and the line it is proposed into. */
export interface WaitingHaulCard extends LineOrdered {
  id: string;
  /** Its haul copy, for the line popup's "In this haul" stages (UIL-121: `comingCopyIds`). */
  copyId?: string;
  dexIds: readonly number[];
  /** `lineKeyOf` its current proposal. */
  lineKey: string | null;
}

/**
 * The haul cards still waiting that go into THIS line (UIL-120, Karvi 2026-09-27: "Confirm & next" never opens another
 * line's card by itself). A POSITIVE match (the Senior BA's ruling on #430): the card's current proposal names this
 * line, and its species is one of the stages the line still wants. Not species and language alone: a card of the right
 * species proposed into ANOTHER line, a new line of its own, a front half or a collection is not this line's card.
 *
 * ONE predicate for the step-through's `next` (fed the line as the server reads it after the write, and the waiting
 * cards as they are routed again after it, so a card that would have started this line now names it) and for the
 * popup's "· next" label (fed the line as the popup lays it out, and the plan as it stands), so the label never
 * promises a jump that will not happen.
 */
export function sameLineWaiting(
  lineKey: string | null,
  openDexIds: readonly number[],
  waiting: readonly WaitingHaulCard[],
): string[] {
  const open = new Set(openDexIds);
  return routedToLine(lineKey, waiting)
    .filter((c) => c.dexIds.some((d) => open.has(d)))
    .map((c) => c.id);
}

/**
 * The waiting cards whose proposal names this line, whatever stage they fill: the positive half of `sameLineWaiting`,
 * on its own for the line popup's "In this haul" stages (UIL-121), where the server matches each to its stage.
 */
export function routedToLine(
  lineKey: string | null,
  waiting: readonly WaitingHaulCard[],
): WaitingHaulCard[] {
  return lineKey ? waiting.filter((c) => c.lineKey === lineKey) : [];
}

/** The one rule: the line reads closed, or it has slots and none is a placeholder still waiting for a card. */
export function lineDoneFor(slotStates: readonly string[], status?: string | null): boolean {
  return (
    lineReadsClosed(status) ||
    (slotStates.length > 0 && slotStates.every((s) => s !== "placeholder"))
  );
}

/** A haul card's place in its line's row: the stage it goes into, and its name. */
export interface LineOrdered {
  name: string;
  /** The line stage it goes into (0 = the Basic); absent, its printed stage stands in. */
  lineStage?: number | null;
  stage?: string | null;
}

const PRINTED_STAGES = ["Basic", "Stage1", "Stage2"];
const stageRank = (c: LineOrdered): number => {
  if (c.lineStage != null) return c.lineStage;
  const i = PRINTED_STAGES.indexOf(c.stage ?? "");
  return i >= 0 ? i : PRINTED_STAGES.length;
};

/**
 * The order the step-through takes one line's cards in (Karvi, 2026-09-27): EVOLUTION order, Basic then Stage 1 then
 * Stage 2, "the way the row reads in your binder"; two cards for one stage by name. "Line card k of N" counts in it too.
 */
export function inLineOrder(a: LineOrdered, b: LineOrdered): number {
  return stageRank(a) - stageRank(b) || a.name.localeCompare(b.name);
}
