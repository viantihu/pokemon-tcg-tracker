/**
 * Resolve a deterministically-resolved Dex id (`ResolvedDexId`, §1.3) to a concrete catalog card id
 * against the M2 mirror (docs/sync-architecture.md §1.3; dev-spec §5 M4).
 *
 * I/O IS ALLOWED here (this is not one of the pure modules). It reads the mirror through
 * `lib/repo` and, on a set-code miss, matches by set NAME and persists a learned `set_alias` so the
 * rest of that set — and future imports — resolve automatically ("one match drains the set").
 *
 * The db client is injected, never hardcoded: `createCatalogLookup(db)` wires the repos into a
 * `CatalogPort`, and the pure `resolveAgainstCatalog(port, ...)` core does the matching so it can
 * be unit-tested with a fake port. A per-sync `sessionAliases` map lets a set-name match learned on
 * one row drain the remaining rows of that set within the SAME pass, not only the next one.
 */
import type { DbClient } from "@/lib/repo";
import { catalogCardRepo, setAliasRepo } from "@/lib/repo";
import type { DexRow, Locale, ResolvedDexId } from "./types";
import type { UnresolvedReason } from "./reconcile";

export interface CatalogLookupResult {
  catalogCardId: string | null;
  reason?: UnresolvedReason;
  /** Set when a set-name match taught the engine a new `(locale, dexCode) → tcgdexSetId` alias. */
  learnedAlias?: { locale: string; dexCode: string; tcgdexSetId: string };
}

/** The narrow slice of the mirror the lookup needs. Backed by repos in prod; faked in tests. */
export interface CatalogPort {
  /** Cards at `(setId, localId)`; a set+localId maps to at most one printing in a healthy mirror. */
  findBySetLocal(setId: string, localId: string): Promise<{ tcgdexId: string }[]>;
  /** Distinct TCGdex set ids whose set name matches `setName` exactly. */
  findSetIdsByName(setName: string, locale: Locale): Promise<string[]>;
  /** Persist a learned set-code alias (name-resolved source). */
  learnAlias(alias: { locale: string; dexCode: string; tcgdexSetId: string }): Promise<void>;
}

/** Build a `CatalogPort` from an injected Supabase client via the repo layer. */
export function catalogPortFromDb(db: DbClient): CatalogPort {
  return {
    async findBySetLocal(setId, localId) {
      const rows = await catalogCardRepo.findBySetLocal(db, setId, localId);
      return rows.map((r) => ({ tcgdexId: r.tcgdex_id }));
    },
    findSetIdsByName(setName, locale) {
      return catalogCardRepo.findSetIdsByName(db, setName, locale);
    },
    async learnAlias(alias) {
      await setAliasRepo.upsert(db, {
        locale: alias.locale,
        dex_code: alias.dexCode,
        tcgdex_set_id: alias.tcgdexSetId,
        source: "name-resolved",
      });
    },
  };
}

/** First catalog card matching any localId candidate against `setId`, in candidate order. */
async function findByCandidates(
  port: CatalogPort,
  setId: string,
  candidates: string[],
): Promise<string | null> {
  for (const localId of candidates) {
    const hits = await port.findBySetLocal(setId, localId);
    if (hits.length > 0) {
      // Deterministic pick when a mirror somehow holds duplicates at one (set, localId).
      return [...hits].sort((a, b) => a.tcgdexId.localeCompare(b.tcgdexId))[0].tcgdexId;
    }
  }
  return null;
}

/**
 * PURE-of-Supabase core: match one resolved Dex id against the catalog through a `CatalogPort`.
 *
 * 1. Try the resolved set id (alias-mapped or raw passthrough) across the localId candidates.
 * 2. On a miss where the set code was NOT a known alias, resolve the set by NAME. A unique name
 *    match learns the alias (persisted + cached in `sessionAliases`) and retries the lookup.
 * 3. Classify a remaining miss: `UNKNOWN_SET` (no set match at all) vs `UNKNOWN_CARD` (set known,
 *    no card at that localId) — sync-ui-spec §A.2.
 */
export async function resolveAgainstCatalog(
  port: CatalogPort,
  row: Pick<DexRow, "Set">,
  resolved: ResolvedDexId,
  sessionAliases: Map<string, string> = new Map(),
): Promise<CatalogLookupResult> {
  const candidates = resolved.localIdCandidates;
  if (candidates.length === 0) {
    return { catalogCardId: null, reason: "UNKNOWN_CARD" };
  }

  // A code learned earlier in this same pass takes precedence over the raw passthrough.
  const sessionKey = `${resolved.locale}:${resolved.setId}`;
  const sessionSetId = !resolved.aliased ? sessionAliases.get(sessionKey) : undefined;
  const primarySetId = sessionSetId ?? resolved.setId;

  const primaryHit = await findByCandidates(port, primarySetId, candidates);
  if (primaryHit) return { catalogCardId: primaryHit };

  // The set id came from a known alias (seed or already-learned): the set is known, the card is not.
  if (resolved.aliased || sessionSetId) {
    return { catalogCardId: null, reason: "UNKNOWN_CARD" };
  }

  // Set-code miss: try to resolve the set by its human name and learn the mapping.
  const setName = row.Set?.trim();
  if (!setName) return { catalogCardId: null, reason: "UNKNOWN_SET" };

  const named = await port.findSetIdsByName(setName, resolved.locale);
  if (named.length !== 1) {
    // No match, or ambiguous — never mis-learn an alias from an ambiguous name.
    return { catalogCardId: null, reason: "UNKNOWN_SET" };
  }

  const learnedSetId = named[0];
  const alias = { locale: resolved.locale, dexCode: resolved.setId, tcgdexSetId: learnedSetId };
  await port.learnAlias(alias);
  sessionAliases.set(sessionKey, learnedSetId);

  const learnedHit = await findByCandidates(port, learnedSetId, candidates);
  if (learnedHit) return { catalogCardId: learnedHit, learnedAlias: alias };

  // Set now resolves (alias learned + drains the set next pass), but this localId has no card.
  return { catalogCardId: null, reason: "UNKNOWN_CARD", learnedAlias: alias };
}

/**
 * A `CatalogPort` that answers `findBySetLocal` from memory wherever it can.
 *
 * WHY A PORT AND NOT A FASTER ALGORITHM. `resolveAgainstCatalog` has an INTRA-PASS DATA DEPENDENCY:
 * on a set-code miss it resolves the set by name, learns an alias, and caches it in `sessionAliases`,
 * so row N can change how row N+1 resolves ("one match drains the set", this file's header). Any
 * rewrite that fires the rows concurrently, or folds them into one `in`-list, would break that — the
 * siblings of a newly-aliased set would each take the name-resolution path instead of seeing the
 * alias, and the answer could depend on scheduling. That is a correctness regression wearing the
 * costume of a speedup.
 *
 * So the resolution algorithm is NOT touched. The rows are still walked one at a time, in order,
 * through the same function, with the same `sessionAliases` map. The only thing that changes is where
 * `findBySetLocal` gets its answer: keys prefetched below are served from memory, everything else
 * falls through to a real query and is memoized. `alias-drain.test.ts` therefore holds by
 * construction, not by re-verification.
 *
 * A key ABSENT from the index is never treated as "no such card" unless it was actually prefetched —
 * `fetched` records what was asked for, so a miss in `index` only short-circuits when we know the
 * query was run. Guessing there would silently unresolve cards.
 */
export function prefetchedCatalogPort(
  inner: CatalogPort,
  index: Map<string, { tcgdexId: string }[]>,
  fetched: Set<string>,
): CatalogPort {
  const liveHits = new Map<string, { tcgdexId: string }[]>();
  const namedSets = new Map<string, string[]>();
  return {
    async findBySetLocal(setId, localId) {
      const k = `${setId}:${localId}`;
      if (fetched.has(k)) return index.get(k) ?? [];
      const memo = liveHits.get(k);
      if (memo) return memo;
      const rows = await inner.findBySetLocal(setId, localId);
      liveHits.set(k, rows);
      return rows;
    },
    async findSetIdsByName(setName, locale) {
      // Many rows share a set name, and a miss re-asks for every one of them. Keyed by locale too
      // (UIL-047): the same set name exists in both catalogs and must not share an answer.
      const key = `${locale}:${setName}`;
      const memo = namedSets.get(key);
      if (memo) return memo;
      const ids = await inner.findSetIdsByName(setName, locale);
      namedSets.set(key, ids);
      return ids;
    },
    learnAlias: (alias) => inner.learnAlias(alias),
  };
}

/**
 * Prefetch every `(setId, localId)` a pass will ask for FIRST, grouped into one query per distinct
 * set instead of one per candidate. This is the whole speedup: ~685 rows x 1-2 candidates went from
 * ~1,000 serial round trips to roughly one per set she owns cards from.
 *
 * Only the primary (pre-alias) set ids can be predicted here. A retry against a set learned mid-pass
 * is not knowable up front and falls through to a live query — correct, and rare on a mature
 * `set_alias` table.
 */
export async function buildCatalogPrefetch(
  db: DbClient,
  wants: readonly { setId: string; candidates: readonly string[] }[],
): Promise<{ index: Map<string, { tcgdexId: string }[]>; fetched: Set<string>; queries: number }> {
  const bySet = new Map<string, Set<string>>();
  for (const w of wants) {
    if (!w.setId || w.candidates.length === 0) continue;
    const set = bySet.get(w.setId) ?? new Set<string>();
    for (const c of w.candidates) set.add(c);
    bySet.set(w.setId, set);
  }

  const index = new Map<string, { tcgdexId: string }[]>();
  const fetched = new Set<string>();
  let queries = 0;

  for (const [setId, localIds] of bySet) {
    const rows = await catalogCardRepo.findBySetLocalMany(db, setId, [...localIds]);
    queries += 1;
    for (const localId of localIds) fetched.add(`${setId}:${localId}`);
    for (const r of rows) {
      if (!r.local_id) continue;
      const k = `${setId}:${r.local_id}`;
      const list = index.get(k) ?? [];
      list.push({ tcgdexId: r.tcgdex_id });
      index.set(k, list);
    }
  }
  return { index, fetched, queries };
}

/**
 * Production entry point: bind an injected db client into a lookup closure that shares one
 * `sessionAliases` map across every row in a sync pass.
 */
export function createCatalogLookup(db: DbClient) {
  const port = catalogPortFromDb(db);
  const sessionAliases = new Map<string, string>();
  return (row: Pick<DexRow, "Set">, resolved: ResolvedDexId) =>
    resolveAgainstCatalog(port, row, resolved, sessionAliases);
}

/**
 * As `createCatalogLookup`, but with the pass's lookups prefetched (see `buildCatalogPrefetch`).
 * Identical closure shape, identical resolution order, identical `sessionAliases` sharing — the rows
 * simply stop paying a round trip each.
 */
export async function createPrefetchedCatalogLookup(
  db: DbClient,
  wants: readonly { setId: string; candidates: readonly string[] }[],
) {
  const { index, fetched } = await buildCatalogPrefetch(db, wants);
  const port = prefetchedCatalogPort(catalogPortFromDb(db), index, fetched);
  const sessionAliases = new Map<string, string>();
  return (row: Pick<DexRow, "Set">, resolved: ResolvedDexId) =>
    resolveAgainstCatalog(port, row, resolved, sessionAliases);
}
