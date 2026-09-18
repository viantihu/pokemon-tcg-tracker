/**
 * What the Lookup screen shows after a pick, derived from the action's result in ONE place (UIL-035,
 * third site). Pure, so the rule can be pinned: only a successful lookup that came back empty may say
 * NO MATCH; a failed lookup says it failed and never claims the card is missing.
 */
import type { LookupAnswer } from "@/lib/surfaces";
import type { LookupResult } from "./actions";
import type { LookupMovableCopy } from "./lookup-copies";

export interface LookupView {
  answer: LookupAnswer | null;
  copies: LookupMovableCopy[];
  /** The mirror was asked and does not have this card. Never true on a failure. */
  notFound: boolean;
  /** The lookup itself did not complete; the message to show. Never set on a real miss. */
  failed: string | null;
}

export function lookupViewFrom(res: LookupResult): LookupView {
  if (!res.ok) return { answer: null, copies: [], notFound: false, failed: res.error };
  return { answer: res.answer, copies: res.copies, notFound: res.answer === null, failed: null };
}
