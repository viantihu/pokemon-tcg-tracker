/**
 * The haul-bar progress strip, sized so it cannot outgrow its container (UIL-007).
 *
 * WHY. The strip rendered one pip per card, and `.xp i` carries a 2px border on each side that flex
 * cannot shrink away, plus a 3px gap between pips. That is a hard ~7px floor per card, so a haul of
 * 685 — which is what a real Dex sync now seeds into the plan, since UIL-003 — forces the strip to
 * about 4,800px. Measured in a browser at a 375px viewport: the strip is 4792px, the haul bar
 * overflows its own panel, and the PAGE scrolls sideways by ~4,400px. That is the "scroll bar
 * spanned across the page outside of its borders" from UAT.
 *
 * It only became reachable when the plan started arriving pre-populated: a typed haul is a handful of
 * cards, and 20 pips fit fine.
 *
 * THE RULE. Below the cap, nothing changes — one pip per card, filled per card, so a normal haul keeps
 * the exact strip it has today INCLUDING which specific cards are ticked out of order. Above the cap,
 * pips become buckets filled by proportion, because at several hundred cards per-card resolution is
 * illegible anyway and the exact figures are already displayed as `N / total` beside the strip.
 */

/**
 * Most pips ever rendered. Sized for the narrowest case rather than the roomiest: at a 375px viewport
 * the haul bar's content box is ~341px, and each pip needs ~7px (4px of border + 3px gap), so ~48 is
 * the ceiling before the strip pushes the bar wide. 40 leaves margin for the label and counter that
 * share the row.
 */
export const MAX_PROGRESS_PIPS = 40;

/**
 * One boolean per pip to render, in order.
 *
 * @param doneFlags per-item completion in plan order — the exact state below the cap
 * @param maxPips   rendering ceiling; pass a smaller value only in tests
 */
export function progressPips(
  doneFlags: readonly boolean[],
  maxPips: number = MAX_PROGRESS_PIPS,
): boolean[] {
  const total = doneFlags.length;
  const cap = Math.max(1, Math.trunc(maxPips));
  if (total === 0) return [];

  // Small haul: exact, per-card, out-of-order ticks and all.
  if (total <= cap) return [...doneFlags];

  // Large haul: proportional buckets. Pip k fills once the completed COUNT reaches its share, which
  // keeps the strip monotonic as she works — the thing a progress bar is for.
  const doneCount = doneFlags.reduce((n, d) => (d ? n + 1 : n), 0);
  const fraction = doneCount / total;
  return Array.from({ length: cap }, (_, k) => fraction >= (k + 1) / cap);
}
