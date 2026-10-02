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
 * MIRROR ROWS ONLY, since 0033 (UIL-127b). The mirror (`source = 'tcgdex'`) is the one part of the catalog every
 * account shares, so one cache serves every request on the instance. A stand-in is its owner's alone, so the
 * caller's own are read fresh on every call, through the caller's RLS client, and merged in. Caching the whole
 * catalog would hand one account's stand-ins to the next caller on the instance, and would hide a stand-in she has
 * just created for up to the TTL.
 *
 * EVERY WHOLE-CATALOG READ ON A REQUEST COMES THROUGH HERE (the Tech Lead's measurement, 2026-10): nine loaders, and
 * the search grid's set filter, used to page the whole table themselves, 38 sequential requests and ~2.5 s each in
 * production, and a Haul Plan line confirm paid it twice. (The mirror job's own `regroupArtwork` still reads the
 * table directly: it runs in Actions, not on a request, and must see what it is about to rewrite.) The rows come back in the mirror's order (by id) with her stand-ins after it, where a full-table `listAll`
 * put a stand-in among them by id: the same rows, in the order the cascade has always read them in.
 *
 * SHARED, SO READ-ONLY. The rows in the cache are the same objects for every request on the instance, so a caller
 * that wrote to one would change what the next request reads, for every account, until the entry expires. Nothing
 * may: copy a row before changing it. Outside production every cached row, everything in it (`dex_id`, `types`,
 * `variants`) and the array are FROZEN, so a write throws in the test suite and in `next dev`. Production is left
 * unfrozen, so a write nothing caught cannot become a crash there.
 */

import { catalogCardRepo, type DbClient, type Row } from "@/lib/repo";

/** Five minutes: long enough to cover a sorting sitting, short enough that a mirror run lands. */
export const CATALOG_CACHE_TTL_MS = 5 * 60_000;

/** A catalog row as the cache hands it out: shared by every request on the instance, so never written to. */
export type CachedCatalogRow = Readonly<Row<"catalog_card">>;

interface CacheEntry {
  rows: readonly CachedCatalogRow[];
  loadedAt: number;
}

let entry: CacheEntry | null = null;
/** Concurrent callers share one in-flight load rather than each starting their own. */
let inFlight: Promise<readonly CachedCatalogRow[]> | null = null;

/** Outside production, a shared row is frozen through and through, so a caller that writes to one throws. */
function freezesShared(): boolean {
  return process.env.NODE_ENV !== "production";
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const inner of Object.values(value)) deepFreeze(inner);
}

export interface CatalogCacheOptions {
  ttlMs?: number;
  /** Injected clock, so the TTL is testable without waiting. */
  now?: number;
}

/**
 * The whole catalog as the caller sees it: the mirror, from cache when fresh, plus her own stand-ins, read fresh.
 * Paged on a miss (`listAllMirror`), because a truncated catalog would quietly break chain-building, viability and
 * alternate ranking.
 */
export async function loadCatalogCached(
  db: DbClient,
  options: CatalogCacheOptions = {},
): Promise<readonly CachedCatalogRow[]> {
  const ttl = options.ttlMs ?? CATALOG_CACHE_TTL_MS;
  const now = options.now ?? Date.now();

  const [mirror, mine] = await Promise.all([
    loadMirror(db, ttl, now),
    catalogCardRepo.listStandIns(db),
  ]);
  if (mine.length === 0) return mirror;
  // Her stand-ins are hers and this request's alone; the array is frozen too, so a caller cannot sort it in place
  // in a test with stand-ins and corrupt the shared one in a test without.
  const merged = [...mirror, ...mine];
  return freezesShared() ? Object.freeze(merged) : merged;
}

async function loadMirror(
  db: DbClient,
  ttl: number,
  now: number,
): Promise<readonly CachedCatalogRow[]> {
  if (entry && now - entry.loadedAt < ttl) return entry.rows;

  // A second caller arriving mid-load waits for the first rather than doubling the work — the case
  // that matters is several cards committed in quick succession on a cold instance.
  if (inFlight) return inFlight;

  inFlight = catalogCardRepo
    .listAllMirror(db)
    .then((rows) => {
      if (freezesShared()) deepFreeze(rows);
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
