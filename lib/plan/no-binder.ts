/**
 * The words for an account with no binder to put a card in (UIL-127a). A brand-new account starts with none, and
 * nothing can be placed until one exists: Backfill used to show "Loading binders…" forever, and Haul Plan wrote a
 * shelved card with no binder at all. The screens' notice and the server's refusal say the same thing, from here.
 */

export const NO_BINDER = {
  /** Backfill and Haul Plan, when the account has no binder. */
  notice: "Add a binder in Settings first. Cards can't be placed until a binder exists.",
  link: "Go to Settings",
  /** The server's refusal for one card, when a write would shelve it in no binder (or one that isn't hers). */
  refusal: (subject: string): string =>
    `${subject} has no binder to go to. Add a binder in Settings, or move the card somewhere else.`,
} as const;
