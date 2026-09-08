/**
 * Placement-plan grouping (dev-spec §5 M6; system-design §5 step 3-4, §7B step 3).
 *
 * This is the heart of M6's own logic and it is FUNCTIONAL, not cosmetic: the plan is worked
 * top-to-bottom in exactly this order, mirroring the physical sort the collector already does —
 *
 *   colour band, in rainbow order  →  basics vs non-basics inside the band  →  action.
 *
 * The rainbow order is supplied by the caller (the `color_band.position` column), so re-ordering
 * bands in Settings (M8) reshapes the plan without a code change. EVERY band appears in the output
 * even at zero cards, so its rainbow slot stays reserved (system-design §4 — the empty Pink band
 * must never be hidden). Pure: no I/O, deterministic for a given input.
 */

import { actionOrder } from "./action";
import type { PlanBandGroup, PlanItem, PlanSubgroup } from "./types";

/**
 * Sub-group label, matching the prototype (design/prototype.html): basics read "BASICS"; the
 * non-basic run reads "TRAINERS · ITEMS" in White (which absorbs Trainers/Items) and "STAGE 1 · 2"
 * in every colour band.
 */
function subgroupLabel(kind: "basic" | "nonbasic", bandKey: string): string {
  if (kind === "basic") return "BASICS";
  return bandKey === "white" ? "TRAINERS · ITEMS" : "STAGE 1 · 2";
}

/** Stable sort a band's rows into a basics / non-basics run, each ordered by action. */
function subgroupsFor(items: PlanItem[], bandKey: string): PlanSubgroup[] {
  const out: PlanSubgroup[] = [];
  for (const kind of ["basic", "nonbasic"] as const) {
    const rows = items
      .filter((it) => (kind === "basic" ? it.isBasic : !it.isBasic))
      // Stable ordering: action first, then the caller's input order (index) as the tiebreak.
      .map((it, i) => ({ it, i }))
      .sort((a, b) => actionOrder(a.it.action) - actionOrder(b.it.action) || a.i - b.i)
      .map(({ it }) => it);
    if (rows.length > 0) out.push({ kind, label: subgroupLabel(kind, bandKey), rows });
  }
  return out;
}

/**
 * Group a flat list of planned cards into the ordered plan.
 *
 * @param items            one entry per incoming card, already carrying `bandKey`, `isBasic`, `action`.
 * @param orderedBandKeys  the rainbow order (DB `color_band` keys by ascending `position`).
 * @returns one group per band in rainbow order (empty bands included), then any band key seen in the
 *          items but missing from `orderedBandKeys` appended in stable encounter order (defensive —
 *          keeps a mis-mapped card visible rather than silently dropping it).
 */
export function groupPlan(items: PlanItem[], orderedBandKeys: readonly string[]): PlanBandGroup[] {
  const byBand = new Map<string, PlanItem[]>();
  for (const it of items) {
    const list = byBand.get(it.bandKey) ?? [];
    list.push(it);
    byBand.set(it.bandKey, list);
  }

  const groups: PlanBandGroup[] = [];
  const emitted = new Set<string>();
  const emit = (bandKey: string) => {
    const rows = byBand.get(bandKey) ?? [];
    groups.push({ bandKey, count: rows.length, subgroups: subgroupsFor(rows, bandKey) });
    emitted.add(bandKey);
  };

  for (const bandKey of orderedBandKeys) if (!emitted.has(bandKey)) emit(bandKey);
  // Any band present in the data but absent from the rainbow order — never drop a card.
  for (const it of items) if (!emitted.has(it.bandKey)) emit(it.bandKey);

  return groups;
}
