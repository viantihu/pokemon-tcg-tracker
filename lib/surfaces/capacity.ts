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
