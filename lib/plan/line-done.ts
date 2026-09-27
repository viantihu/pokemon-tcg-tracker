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
 * ONE RULE, here and nowhere else. The server answers it over the line's slots once the write has landed
 * (`lineDoneAfterWrite` in ./commit), and the popup forecasts it for its "· next" label from the same function. When
 * UIL-121 lands (a line reads open or closed, each stage her decision) this body becomes "the line reads closed",
 * and neither caller changes.
 *
 * Pure, and free of I/O imports, so the client popup can use it.
 */

/** The one rule: a line with slots, none of them a placeholder still waiting for a card. */
export function lineDoneFor(slotStates: readonly string[]): boolean {
  return slotStates.length > 0 && slotStates.every((s) => s !== "placeholder");
}
