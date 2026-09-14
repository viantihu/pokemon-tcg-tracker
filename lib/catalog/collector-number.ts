/**
 * Reading a printed collector number out of a search box (UIL-010).
 *
 * WHY. She searched `099/182` for a Minior and got nothing at all. The search built one `ilike
 * %099/182%` per column, and no column ever contains a slash, so every predicate failed — a total,
 * silent miss that reads as "the card isn't in the app". Two separate defects sat behind it:
 *
 *   1. The printed form was never parsed. `099/182` is `number/setTotal`; `local_id` holds only the
 *      numerator, so the denominator poisoned every match.
 *   2. Padding was never normalized. `local_id` keeps TCGdex's padding verbatim and it VARIES BY SET
 *      (0002_domain.sql: "EXACT padding ('027','82')"), so even a bare `099` misses a set storing `99`.
 *
 * WHY THE DENOMINATOR IS DISCARDED, not matched. There is no set-total column on `catalog_card`, and
 * counting rows per `set_id` is not a substitute: printed totals exclude secret rares, so a card like
 * `Shuckle 136/132` legitimately exceeds its own denominator. Discarding it is correct rather than a
 * shortcut — it carries no information the catalog can check.
 *
 * Pure. Imports `localIdCandidates` from the sync resolver rather than reimplementing it, because that
 * padding logic is already the verified answer to the same question (sync-architecture §1.3) and a
 * second copy would be a second thing to keep right.
 */

import { localIdCandidates } from "@/lib/sync/resolve";

export interface ParsedCardQuery {
  /** The query with any collector number removed — what should still be matched as free text. */
  text: string;
  /**
   * `local_id` values to try as an EXACT match, most-likely first. Empty when the query holds no
   * collector number. Exact rather than substring: `99` as a substring also matches `199` and `990`.
   */
  localIds: string[];
  /** True when the query was ONLY a collector number, so there is no useful free text left. */
  numberOnly: boolean;
}

/**
 * A collector number as printed: `099/182`, `99/182`, `TG05/TG30`, or a bare `099`. Anchored so it is
 * only recognized as a whole token — `sv03` must stay a set-code search, not a number.
 */
const PRINTED = /^([0-9]{1,4}[a-z]?|[a-z]{1,3}[0-9]{1,3})\s*\/\s*([0-9a-z]{1,5})$/i;
const BARE_NUMBER = /^([0-9]{1,4})$/;

/** Split a raw search box string into an exact-number part and a free-text part. */
export function parseCardQuery(raw: string): ParsedCardQuery {
  const q = raw.trim();
  if (q === "") return { text: "", localIds: [], numberOnly: false };

  const printed = PRINTED.exec(q);
  if (printed) {
    // The denominator is deliberately dropped — see the header.
    return { text: printed[1], localIds: localIdCandidates(printed[1]), numberOnly: true };
  }

  const bare = BARE_NUMBER.exec(q);
  if (bare) {
    return { text: q, localIds: localIdCandidates(bare[1]), numberOnly: true };
  }

  // A number embedded in a longer query ("minior 099", "sv03 099/182"): search both halves.
  const embedded = /(?:^|\s)([0-9]{1,4})\s*(?:\/\s*[0-9a-z]{1,5})?(?=\s|$)/i.exec(q);
  if (embedded) {
    const rest = (q.slice(0, embedded.index) + " " + q.slice(embedded.index + embedded[0].length))
      .replace(/\s+/g, " ")
      .trim();
    return {
      text: rest === "" ? embedded[1] : rest,
      localIds: localIdCandidates(embedded[1]),
      numberOnly: rest === "",
    };
  }

  return { text: q, localIds: [], numberOnly: false };
}
