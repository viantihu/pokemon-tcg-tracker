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

import { lineReadsClosed } from "@/lib/line/popup";

/** A card still waiting in this haul, as the step-through reads it: its species, in its language. */
export interface WaitingHaulCard {
  id: string;
  dexIds: readonly number[];
  locale: string;
}

/**
 * The haul cards still waiting that go into THIS line (UIL-120, Karvi 2026-09-27: "Confirm & next" never opens another
 * line's card by itself): a card of a species one of the line's open stages wants, in the line's language. ONE
 * predicate for the step-through's `next` (fed the line as the server reads it after the write) and for the popup's
 * "· next" label (fed the line as the popup lays it out), so the label never promises a jump that will not happen.
 */
export function sameLineWaiting(
  openDexIds: readonly number[],
  lineLocale: string,
  waiting: readonly WaitingHaulCard[],
): string[] {
  const open = new Set(openDexIds);
  return waiting
    .filter((c) => c.locale === lineLocale && c.dexIds.some((d) => open.has(d)))
    .map((c) => c.id);
}

/** The one rule: the line reads closed, or it has slots and none is a placeholder still waiting for a card. */
export function lineDoneFor(slotStates: readonly string[], status?: string | null): boolean {
  return (
    lineReadsClosed(status) ||
    (slotStates.length > 0 && slotStates.every((s) => s !== "placeholder"))
  );
}
