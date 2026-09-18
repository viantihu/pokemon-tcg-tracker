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
 * THE DENOMINATOR RANKS, IT DOES NOT FILTER (UIL-026). It was discarded entirely until `catalog_card`
 * gained `set_card_count_official` (migration 0009). It still must never FILTER: printed totals exclude
 * secret rares, so a card like `Shuckle 136/132` legitimately exceeds its own denominator, and counting
 * rows per `set_id` is not a substitute either. But as a RANKING signal it is safe and decisive — an
 * exact `local_id` match whose set's official count equals the typed denominator is almost certainly
 * the card, so it sorts first while the others still appear below it. `setTotal` carries it out for the
 * search to use; a set that happens to lack the count just doesn't get the boost.
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
  /**
   * The printed denominator (`182` in `099/182`), when it was a plain number. Used ONLY to RANK exact
   * `local_id` matches — a set whose official card count equals this sorts first (UIL-026) — never to
   * filter, because printed totals exclude secret rares, so `Shuckle 136/132` legitimately exceeds its
   * own denominator. Absent for a bare number, an already-lettered denominator (`TG05/TG30`), or a
   * non-numeric one.
   */
  setTotal?: number;
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
    // Denominator kept for RANKING only (see header) — and only when it is a plain number. A lettered
    // denominator like `TG30` is not a set's official count, so it stays absent.
    const denom = /^[0-9]+$/.test(printed[2]) ? Number(printed[2]) : undefined;
    return {
      text: printed[1],
      localIds: localIdCandidates(printed[1]),
      numberOnly: true,
      setTotal: denom,
    };
  }

  const bare = BARE_NUMBER.exec(q);
  if (bare) {
    return { text: q, localIds: localIdCandidates(bare[1]), numberOnly: true };
  }

  // A number embedded in a longer query ("minior 099", "sv03 099/182"): search both halves. The
  // denominator group is captured (not just skipped) so "minior 099/182" gets the same ranking boost
  // as the bare printed form.
  const embedded = /(?:^|\s)([0-9]{1,4})\s*(?:\/\s*([0-9a-z]{1,5}))?(?=\s|$)/i.exec(q);
  if (embedded) {
    const rest = (q.slice(0, embedded.index) + " " + q.slice(embedded.index + embedded[0].length))
      .replace(/\s+/g, " ")
      .trim();
    const denom = embedded[2] && /^[0-9]+$/.test(embedded[2]) ? Number(embedded[2]) : undefined;
    return {
      text: rest === "" ? embedded[1] : rest,
      localIds: localIdCandidates(embedded[1]),
      numberOnly: rest === "",
      setTotal: denom,
    };
  }

  return { text: q, localIds: [], numberOnly: false };
}

/**
 * The collector number as she reads it off the card: `"099/182"`, or `"099"` when the set total is not
 * known (UIL-077).
 *
 * WHY THIS EXISTS AS ONE FUNCTION. She identifies a printing by the whole number, not the numerator —
 * "099/182", never "099". The denominator has been in the database on all 23,548 rows since migration
 * 0009 and the search ranking already uses it, but `toCatalogCard` never mapped it through, so every
 * screen rendered the bare numerator. Choosing between compatible printings for a line slot without it
 * is choosing blind, which is the same information gap behind UIL-010, UIL-015, UIL-026 and UIL-044 —
 * all four fixed in SEARCH, none of them in DISPLAY until now.
 *
 * THE FALLBACK IS DELIBERATE, NOT INCIDENTAL. `set_card_count_official` is nullable and the mirror
 * writes `set.cardCount?.official ?? null`, so TCGdex genuinely does not report a printed total for
 * every set — promos and some subsets have none. When it is missing the BARE number is correct, and
 * `"099/"` must never appear. Keeping that judgement in one function is the point: a dozen call sites
 * each doing `${localId}/${count}` would each have to remember the null case, and one forgetting is a
 * defect she would have to report.
 *
 * Returns null only when there is no number at all, so callers keep their existing
 * `localId ? … : null` shape unchanged.
 */
export function formatCollectorNumber(
  localId: string | null | undefined,
  setCardCountOfficial: number | null | undefined,
): string | null {
  if (!localId) return null;
  // `> 0` rather than just non-null: a zero total is meaningless as a denominator and would render
  // "099/0", which is worse than the bare number it replaced.
  if (typeof setCardCountOfficial === "number" && setCardCountOfficial > 0) {
    return `${localId}/${setCardCountOfficial}`;
  }
  return localId;
}
