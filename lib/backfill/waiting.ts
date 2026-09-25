/**
 * What Backfill may place: the copies waiting in her haul (UIL-098, Backfill half).
 *
 * Backfill used to create a copy for every card she transcribed. Dex is the source of truth for what she
 * owns, and a copy made anywhere but the import belongs to no presence group, so the next import could not
 * see it and created a SECOND one when Dex listed the card. Backfill now places copies her import already
 * made, as the Haul Plan does, and never creates one.
 *
 * "WAITING" HAS ONE DEFINITION, and it is the Haul Plan's queue: `loadPendingPlacements` (role `haul`, no
 * binder, no line slot, no placement decision). This module groups that queue; it does not re-ask the
 * question, so the two screens cannot disagree about which cards are waiting.
 *
 * The key is `(printing, Dex variant)`, the presence key. She picks a printing and its Dex variant; the
 * server picks WHICH copy, oldest first, so no copy id travels through the browser and a stale tab cannot
 * name a copy that has since been placed.
 */

import { parseCardQuery } from "@/lib/catalog/collector-number";
import { loadPendingPlacements, type PendingPlacement } from "@/lib/plan/pending";
import type { DbClient, Row } from "@/lib/repo";

/** One printing + Dex variant waiting in her haul, with the copies behind it, oldest first. */
export interface WaitingKey {
  tcgdexId: string;
  /** Dex's own variant string ("Normal", "Reverse Holo"). Dex owns it; Backfill shows it, never sets it. */
  dexVariantRaw: string;
  copyIds: string[];
  card: Row<"catalog_card">;
}

export type WaitingPool = Map<string, WaitingKey>;

export function waitingKey(tcgdexId: string, dexVariantRaw: string): string {
  return `${tcgdexId}\u0000${dexVariantRaw}`;
}

/**
 * The Dex variant a waiting copy is keyed by. Sync always stores one; a copy without it (never made by an
 * import) falls back to its app variant rather than vanishing from the pool.
 */
function rawOf(p: PendingPlacement): string {
  return p.dexVariantRaw ?? p.variant;
}

/** Group the Haul Plan's queue by key, keeping its oldest-first order within each key. */
export function groupWaiting(pending: readonly PendingPlacement[]): WaitingPool {
  const pool: WaitingPool = new Map();
  for (const p of pending) {
    const raw = rawOf(p);
    const k = waitingKey(p.tcgdexId, raw);
    const hit = pool.get(k);
    if (hit) hit.copyIds.push(p.copyId);
    else
      pool.set(k, { tcgdexId: p.tcgdexId, dexVariantRaw: raw, copyIds: [p.copyId], card: p.card });
  }
  return pool;
}

/** Everything waiting in her haul, grouped by key. */
export async function loadWaiting(db: DbClient): Promise<WaitingPool> {
  return groupWaiting(await loadPendingPlacements(db));
}

/**
 * The type-ahead over what is waiting — the same query grammar as the catalog search ("set + number or
 * name", `parseCardQuery`), run over her haul instead of the mirror. A printed number that matches exactly
 * ranks first, in the candidate order she typed; then name, set name, number or id containing the text.
 */
export function matchWaiting(query: string, pool: WaitingPool, limit = 24): WaitingKey[] {
  const parsed = parseCardQuery(query);
  const text = parsed.text.trim().toLowerCase();
  if (text.length === 0 && parsed.localIds.length === 0) return [];
  const all = [...pool.values()].sort(
    (a, b) =>
      a.card.name.localeCompare(b.card.name) ||
      a.tcgdexId.localeCompare(b.tcgdexId) ||
      a.dexVariantRaw.localeCompare(b.dexVariantRaw),
  );
  const out: WaitingKey[] = [];
  const seen = new Set<WaitingKey>();
  const take = (w: WaitingKey) => {
    if (seen.has(w)) return;
    seen.add(w);
    out.push(w);
  };
  for (const localId of parsed.localIds) {
    for (const w of all) if (w.card.local_id === localId) take(w);
  }
  if (text.length > 0) {
    for (const w of all) {
      const c = w.card;
      const hay = [c.name, c.set_name, c.local_id, c.tcgdex_id].map((v) => (v ?? "").toLowerCase());
      if (hay.some((h) => h.includes(text))) take(w);
    }
  }
  return out.slice(0, limit);
}

/** How many copies of one key a commit asks for. */
export interface WaitingDemand {
  tcgdexId: string;
  dexVariantRaw: string;
  count: number;
}

/** Sum the pockets a commit fills per key (one pocket, one copy). */
export function demandsOf(
  picks: readonly { tcgdexId: string; dexVariantRaw: string }[],
): WaitingDemand[] {
  const byKey = new Map<string, WaitingDemand>();
  for (const p of picks) {
    const k = waitingKey(p.tcgdexId, p.dexVariantRaw);
    const hit = byKey.get(k);
    if (hit) hit.count += 1;
    else byKey.set(k, { tcgdexId: p.tcgdexId, dexVariantRaw: p.dexVariantRaw, count: 1 });
  }
  return [...byKey.values()];
}

/** A key the commit asks for more of than is waiting. */
export interface WaitingShortage {
  tcgdexId: string;
  dexVariantRaw: string;
  asked: number;
  waiting: number;
}

export function shortagesOf(
  demands: readonly WaitingDemand[],
  pool: WaitingPool,
): WaitingShortage[] {
  const out: WaitingShortage[] = [];
  for (const d of demands) {
    const have = pool.get(waitingKey(d.tcgdexId, d.dexVariantRaw))?.copyIds.length ?? 0;
    if (d.count > have) {
      out.push({
        tcgdexId: d.tcgdexId,
        dexVariantRaw: d.dexVariantRaw,
        asked: d.count,
        waiting: have,
      });
    }
  }
  return out;
}

/**
 * A Backfill save that names a card not waiting in her haul, refused before anything is written (Karvi's
 * refusal rule: name the condition, show the remedy). The remedy is always the same one: the card comes
 * from Dex. For a LINE the save refuses only that line; the screen keeps what she entered so she can import
 * the card and save it again (the Senior BA's ruling, 2026-09-25).
 */
export class NotWaitingError extends Error {
  constructor(
    public readonly shortages: readonly WaitingShortage[],
    nameOf: (tcgdexId: string) => string,
    scope: "line" | "list",
  ) {
    super(notWaitingMessage(shortages, nameOf, scope));
    this.name = "NotWaitingError";
  }
}

/** The refusal's wording. Exported so the tests and the screen read the same sentence. */
export function notWaitingMessage(
  shortages: readonly WaitingShortage[],
  nameOf: (tcgdexId: string) => string,
  scope: "line" | "list",
): string {
  const parts = shortages.map((s) => {
    const card = `${nameOf(s.tcgdexId)} (${s.dexVariantRaw})`;
    if (s.waiting === 0) return `${card} is not waiting in your haul.`;
    const verb = s.waiting === 1 ? "is" : "are";
    return `You placed ${s.asked} ${card}, but only ${s.waiting} ${verb} waiting in your haul.`;
  });
  const it =
    shortages.length === 1 && shortages[0].asked - shortages[0].waiting === 1 ? "it" : "them";
  const tail =
    scope === "line"
      ? `Add ${it} in Dex, import ${it} on the Sync page, then save this line.`
      : `Add ${it} in Dex, import ${it} on the Sync page, then save again.`;
  return `${parts.join(" ")} ${tail}`;
}

/**
 * The planner's copy source for one commit: hands out the waiting copies of each key, oldest first. The
 * executor checks `shortagesOf` before planning, so running dry here is a bug, and says so.
 */
export function takerFor(pool: WaitingPool): (tcgdexId: string, dexVariantRaw: string) => string {
  const next = new Map<string, number>();
  return (tcgdexId, dexVariantRaw) => {
    const k = waitingKey(tcgdexId, dexVariantRaw);
    const ids = pool.get(k)?.copyIds ?? [];
    const i = next.get(k) ?? 0;
    if (i >= ids.length) {
      throw new Error(`Backfill ran out of waiting copies of ${tcgdexId} (${dexVariantRaw}).`);
    }
    next.set(k, i + 1);
    return ids[i];
  };
}
