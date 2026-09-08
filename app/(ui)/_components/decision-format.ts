/**
 * Tiny client-safe formatters for the decision / line / move components. Kept out of `lib/line`
 * (whose barrel re-exports the server-only load/write orchestration) so client components never pull
 * repo code into the browser bundle.
 */

/** "$24.10", or null when there is no price. */
export function fmtPrice(p: number | null | undefined): string | null {
  if (p === null || p === undefined || Number.isNaN(p)) return null;
  return `$${p.toFixed(2)}`;
}
