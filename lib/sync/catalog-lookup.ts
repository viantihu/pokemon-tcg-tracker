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
import type { DexRow, ResolvedDexId } from "./types";
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
  findSetIdsByName(setName: string): Promise<string[]>;
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
    findSetIdsByName(setName) {
      return catalogCardRepo.findSetIdsByName(db, setName);
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

  const named = await port.findSetIdsByName(setName);
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
 * Production entry point: bind an injected db client into a lookup closure that shares one
 * `sessionAliases` map across every row in a sync pass.
 */
export function createCatalogLookup(db: DbClient) {
  const port = catalogPortFromDb(db);
  const sessionAliases = new Map<string, string>();
  return (row: Pick<DexRow, "Set">, resolved: ResolvedDexId) =>
    resolveAgainstCatalog(port, row, resolved, sessionAliases);
}
