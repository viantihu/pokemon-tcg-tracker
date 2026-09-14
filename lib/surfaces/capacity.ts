/**
 * Capacity review — pure helpers over the `binder_section` view (dev-spec §5 M8; system-design §7E).
 *
 * The view already derives capacity / shelved / block / placeholder / free per (binder, half). This
 * module only classifies those numbers for display: how full a section is, and which back halves
 * have room for a new line ("which binder has room for a new Fire line"). No I/O.
 */

/** One row of the `binder_section` view, with nullable columns coalesced by the caller. */
export interface SectionView {
  binderId: string;
  half: string;
  capacity: number;
  shelvedCount: number;
  blockPockets: number;
  openPlaceholders: number;
  freePockets: number;
}

export type Fullness = "full" | "near" | "ok" | "empty";

/** Pockets consumed = shelved + blocks + open placeholders (placeholders reserve space). */
export function usedPockets(s: SectionView): number {
  return s.shelvedCount + s.blockPockets + s.openPlaceholders;
}

/** Fraction of capacity consumed (0 when a section has no capacity yet). */
export function usedFraction(s: SectionView): number {
  return s.capacity > 0 ? usedPockets(s) / s.capacity : 0;
}

/** Near-full at ≥85% by default; a section reads "full" only when no free pockets remain. */
export const NEAR_FULL_FRACTION = 0.85;

export function fullness(s: SectionView, nearFraction = NEAR_FULL_FRACTION): Fullness {
  if (s.capacity <= 0) return "empty";
  if (s.freePockets <= 0) return "full";
  if (usedFraction(s) >= nearFraction) return "near";
  return "ok";
}

/** True when a general binder's BACK half can seat a new evolution line (needs a few free pockets). */
export function hasRoomForLine(s: SectionView, minPockets = 3): boolean {
  return s.half === "back" && s.freePockets >= minPockets;
}

/**
 * Back-half sections with room, most-free first — the ranked answer to "which binder has room for a
 * new Fire line". Ties broken by binderId for determinism.
 */
export function backHalvesWithRoom(
  sections: readonly SectionView[],
  minPockets = 3,
): SectionView[] {
  return sections
    .filter((s) => hasRoomForLine(s, minPockets))
    .sort((a, b) => b.freePockets - a.freePockets || a.binderId.localeCompare(b.binderId));
}

/* ------------------------- the split, before anything is saved ------------------------- */

/** What a binder's page/pocket/divider numbers imply. Pockets, because pages are capacity-only. */
export interface BinderSplit {
  /**
   * The page/pocket counts actually used, after clamping. A number input yields NaN mid-typing (and
   * can be handed a negative), so a caller that displayed its own raw values next to these numbers
   * would show "NaN pages × 9 = 0 pockets". Render these instead.
   */
  pages: number;
  pocketsPerPage: number;
  /** Pages 1 .. backHalfStartPage-1 (all pages when no divider is set). */
  frontPages: number;
  /** Pages backHalfStartPage .. end. ZERO when no divider is set — see `noBackHalf`. */
  backPages: number;
  frontPockets: number;
  backPockets: number;
  totalPockets: number;
  /**
   * True when a GENERAL binder ends up with no back half at all. That is the trap in UIL-001: a blank
   * divider reads as "the whole binder is front half", so the binder silently cannot hold a single
   * evolution line, and nothing said so.
   */
  noBackHalf: boolean;
}

/**
 * Derive the front/back split from the raw form values, BEFORE a binder is saved (UIL-001, UIL-002).
 *
 * This deliberately mirrors the `binder_section` view in 0002_domain.sql line-for-line, including its
 * `coalesce(back_half_start_page, pages + 1)` and both `greatest(..., 0)` clamps:
 *
 *   front = greatest(coalesce(bhsp, pages + 1) - 1, 0) * pockets_per_page
 *   back  = greatest(pages - (coalesce(bhsp, pages + 1) - 1), 0) * pockets_per_page
 *
 * A preview that disagreed with the view would be worse than no preview at all, so the equivalence is
 * pinned by a test that runs both against a real Postgres rather than asserted in a comment.
 *
 * Specialty binders are a single section (`pages * pockets_per_page`) with no halves.
 */
export function binderSplit(input: {
  type: "general" | "specialty";
  pages: number;
  pocketsPerPage: number;
  backHalfStartPage?: number | null;
}): BinderSplit {
  // Guard the arithmetic against the transient junk a number input produces mid-typing (empty → NaN).
  const pages = Number.isFinite(input.pages) ? Math.max(0, Math.trunc(input.pages)) : 0;
  const ppp = Number.isFinite(input.pocketsPerPage)
    ? Math.max(0, Math.trunc(input.pocketsPerPage))
    : 0;

  if (input.type === "specialty") {
    const total = pages * ppp;
    return {
      pages,
      pocketsPerPage: ppp,
      frontPages: pages,
      backPages: 0,
      frontPockets: total,
      backPockets: 0,
      totalPockets: total,
      noBackHalf: false, // not a defect for a specialty binder: it has no halves by design
    };
  }

  const raw = input.backHalfStartPage;
  const bhsp = raw != null && Number.isFinite(raw) ? Math.trunc(raw) : null;
  const divider = bhsp ?? pages + 1; // the coalesce
  const frontPages = Math.max(divider - 1, 0);
  const backPages = Math.max(pages - frontPages, 0);

  return {
    pages,
    pocketsPerPage: ppp,
    frontPages,
    backPages,
    frontPockets: frontPages * ppp,
    backPockets: backPages * ppp,
    totalPockets: frontPages * ppp + backPages * ppp,
    noBackHalf: backPages === 0,
  };
}
