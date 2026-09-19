/**
 * How the Lines screen orders its strips (UIL-074). PURE — no I/O — so the two view modes she named
 * are one tested function, called by `buildScreenModel` after the line-building loop rather than
 * sorted in the component.
 *
 * Before this, `evolutionLineRepo.listAll` was unordered and the strips rendered in whatever order
 * Postgres returned — in practice creation order, which is no order at all once you have thirty.
 *
 *   "color"  — colour band in rainbow order (the `color_band.position` the caller supplies), then the
 *              line's species A to Z. The default: it mirrors the physical sort of the back half.
 *   "binder" — the same order INSIDE each binder, binders in their own display order (the order the
 *              Move panel and Settings already list them: creation order); lines with no binder last.
 *
 * Every comparison ends on `lineId`, so two lines that tie on every visible key still come back in
 * one deterministic order rather than whichever the sort happened to visit first.
 */

import type { LineView, LineViewMode } from "./types";

export interface LineOrderContext {
  /** Rainbow order — `color_band` keys by ascending `position`. */
  bandOrder: readonly string[];
  /** Binder ids in display order. A line whose binder is missing from it sorts after all of them. */
  binderOrder: readonly string[];
}

/** Case- and accent-insensitive, digit-aware — the same collation the Haul Plan sorts by (UIL-076). */
const byLabel = new Intl.Collator("en", { sensitivity: "base", numeric: true });

export function orderLineViews(
  lines: readonly LineView[],
  view: LineViewMode,
  ctx: LineOrderContext,
): LineView[] {
  const bandRank = new Map(ctx.bandOrder.map((k, i) => [k, i] as const));
  const binderRank = new Map(ctx.binderOrder.map((id, i) => [id, i] as const));
  // Unknown band or binder: last, never dropped — the same defensive rule `groupPlan` follows.
  const band = (l: LineView) => bandRank.get(l.bandKey) ?? ctx.bandOrder.length;
  const binder = (l: LineView) =>
    l.binderId === null
      ? ctx.binderOrder.length
      : (binderRank.get(l.binderId) ?? ctx.binderOrder.length);
  return [...lines].sort(
    (a, b) =>
      (view === "binder" ? binder(a) - binder(b) : 0) ||
      band(a) - band(b) ||
      byLabel.compare(a.speciesLabel, b.speciesLabel) ||
      a.lineId.localeCompare(b.lineId),
  );
}

export interface LineBinderGroup {
  /** The binder id, or "none" for lines with no binder. */
  key: string;
  /** The heading the strip shows over the group, e.g. "BINDER 1 · BACK". */
  label: string;
  lines: LineView[];
}

/**
 * Consecutive runs of the same binder, for the "by binder" strip's group headings. Expects lines
 * already in `"binder"` order — it groups what it is given and does not re-sort.
 */
export function binderGroups(lines: readonly LineView[]): LineBinderGroup[] {
  const groups: LineBinderGroup[] = [];
  for (const line of lines) {
    const key = line.binderId ?? "none";
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.lines.push(line);
    else groups.push({ key, label: line.binderId ? line.binderLabel : "NO BINDER", lines: [line] });
  }
  return groups;
}
