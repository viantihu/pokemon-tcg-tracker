/**
 * A process-local cache of the catalog mirror, so committing one card does not re-read 23,548 rows.
 *
 * WHY THIS AND NOT A SCOPED QUERY. UIL-027 makes each "Done" click its own commit, and every commit
 * calls `loadPlanContext`, which pages the whole mirror — roughly 24 paged requests plus parsing 23.5k
 * rows, per click, on a button she presses hundreds of times in a sitting. The obvious fix is to fetch
 * only the cards the cascade will touch, and `loadPlanContext`'s own note has proposed exactly that for
 * a while ("scope the query to the haul's dexId neighbourhoods").
 *
 * I did not do that, and the reason is `buildChain` (lib/engine/line.ts). It resolves an evolution chain
 * by WALKING the catalog: backward through `evolveFrom` names, forward through cards that evolve *from*
 * the current frontier, iteratively, stopping at branches. To fetch "just the neighbourhood" the loader
 * would have to know the chain before it has the catalog — which means reimplementing that walk outside
 * the engine. Two implementations of one traversal, free to drift, deciding which cards the cascade can
 * see. A narrowing there does not throw; it silently changes a placement. That is the failure mode this
 * project has hit repeatedly (UIL-012, UIL-015), and it is not worth a round trip.
 *
 * Caching instead gives the same rows, so placement decisions are identical BY CONSTRUCTION rather than
 * by passing an equivalence test. The mirror is append-mostly reference data refreshed by a manual
 * Actions job, not a hot table, which is what makes it cacheable at all.
 *
 * STALENESS, bounded and stated. Entries expire after `CATALOG_CACHE_TTL_MS`. Within that window a
 * mirror run's changes are invisible. What that can actually affect is narrow: chain structure and
 * `local_id`s never change for a card that already exists, so placement is unaffected; the mutable
 * fields are prices and artwork grouping, which feed cheapest-first ALTERNATE RANKING on wishlist
 * targets. A newly mirrored set is invisible for at most the TTL. `clearCatalogCache` exists for tests
 * and for any caller that needs to force a re-read.
 *
 * Not owner-scoped, deliberately: `catalog_card` is global read-only reference data under RLS
 * (0002_domain.sql), not per-owner, so one cache serves every request on the instance without leaking
 * anything between owners.
 */

import { catalogCardRepo, type DbClient, type Row } from "@/lib/repo";

/** Five minutes: long enough to cover a sorting sitting, short enough that a mirror run lands. */
export const CATALOG_CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry {
  rows: Row<"catalog_card">[];
  loadedAt: number;
}

let entry: CacheEntry | null = null;
/** Concurrent callers share one in-flight load rather than each starting their own. */
let inFlight: Promise<Row<"catalog_card">[]> | null = null;

export interface CatalogCacheOptions {
  ttlMs?: number;
  /** Injected clock, so the TTL is testable without waiting. */
  now?: number;
}

/**
 * The whole catalog, from cache when fresh. Paged on a miss (`listAll`), because a truncated catalog
 * would quietly break chain-building, viability and alternate ranking.
 */
export async function loadCatalogCached(
  db: DbClient,
  options: CatalogCacheOptions = {},
): Promise<Row<"catalog_card">[]> {
  const ttl = options.ttlMs ?? CATALOG_CACHE_TTL_MS;
  const now = options.now ?? Date.now();

  if (entry && now - entry.loadedAt < ttl) return entry.rows;

  // A second caller arriving mid-load waits for the first rather than doubling the work — the case
  // that matters is several cards committed in quick succession on a cold instance.
  if (inFlight) return inFlight;

  inFlight = catalogCardRepo
    .listAll(db)
    .then((rows) => {
      entry = { rows, loadedAt: now };
      return rows;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Drop the cache. For tests, and for a caller that has just changed the mirror. */
export function clearCatalogCache(): void {
  entry = null;
  inFlight = null;
}

/** Whether a fresh entry is currently held — for assertions and diagnostics, not control flow. */
export function catalogCacheIsWarm(options: CatalogCacheOptions = {}): boolean {
  const ttl = options.ttlMs ?? CATALOG_CACHE_TTL_MS;
  const now = options.now ?? Date.now();
  return entry !== null && now - entry.loadedAt < ttl;
}
