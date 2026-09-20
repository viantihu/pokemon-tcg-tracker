import { namespaceId, normalizeLocale } from "@/lib/catalog/locale";
import type { DexRow, Locale, ResolvedDexId } from "./types";

/**
 * Deterministic Dex `Id` -> TCGdex resolution (docs/sync-architecture.md §1.3).
 *
 * The Dex `Id` (e.g. `me2-112`, `jpn_sv11w-2`) is NOT byte-identical to the
 * TCGdex card id. Three verified drifts are handled here:
 *   1. Set-code drift   — Dex `me1..me5` -> `me01..me05`, `me25` -> `me02.5`.
 *   2. localId padding  — TCGdex zero-pads some sets; Dex does not (`mep-87` -> `mep-087`).
 *   3. Locale namespace  — `jpn_` prefix + Locale=Japanese resolve against the `ja` locale.
 *
 * Set codes not in the alias table pass through unchanged as the best guess;
 * the caller resolves those by set NAME against the live catalog and persists
 * the mapping. Name/catalog lookups are intentionally out of this pure module.
 */

/**
 * Verified set-code aliases, keyed by `${locale}:${dexCode}`. Only sets whose
 * Dex code drifts from the TCGdex id need an entry; everything else passes through.
 * Extend as new drifts are verified against the live API — never guess.
 */
export const SET_ALIAS_SEED: Readonly<Record<string, string>> = {
  "en:me1": "me01",
  "en:me2": "me02",
  "en:me3": "me03",
  "en:me4": "me04",
  "en:me5": "me05",
  "en:me25": "me02.5", // Ascended Heroes — a decimal, NOT a zero-pad.
};

export function detectLocale(row: Pick<DexRow, "Locale">): Locale {
  return normalizeLocale(row.Locale);
}

/** Split a Dex `Id` into its raw set code (jpn_ stripped) and localId. */
export function parseDexId(id: string): { rawCode: string; localId: string } {
  const dash = id.indexOf("-");
  if (dash === -1) {
    return { rawCode: id.replace(/^jpn_/, ""), localId: "" };
  }
  const rawCode = id.slice(0, dash).replace(/^jpn_/, "");
  const localId = id.slice(dash + 1);
  return { rawCode, localId };
}

/** Zero-pad a purely-numeric localId to 3 digits (`2` -> `002`, `87` -> `087`). */
export function zeroPad3(localId: string): string {
  return /^\d+$/.test(localId) ? localId.padStart(3, "0") : localId;
}

/** Strip leading zeros from a numeric localId (`002` -> `2`), keeping at least one digit. */
export function stripPad(localId: string): string {
  return /^\d+$/.test(localId) ? String(Number(localId)) : localId;
}

/**
 * Ordered, de-duplicated localId candidates to try against the catalog.
 *
 * LOAD-BEARING BEYOND SYNC (UIL-010). This is no longer only the Dex-import resolver's padding rule:
 * `catalogCardRepo.search` uses it too, so a collector number typed as printed ("099/182") finds a card
 * in a set that stores `99`. `local_id` keeps TCGdex's padding verbatim and it varies by set, which is
 * why the same three candidates are needed in both places. Changing this order or these variants moves
 * BOTH the sync join and every card search in the app — plan, backfill, collections, lookup and sync.
 */
export function localIdCandidates(localId: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of [localId, zeroPad3(localId), stripPad(localId)]) {
    if (c && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

export function resolveSetId(
  locale: Locale,
  rawCode: string,
  alias: Readonly<Record<string, string>> = SET_ALIAS_SEED,
): { setId: string; aliased: boolean } {
  const hit = alias[`${locale}:${rawCode}`];
  // UIL-047: an alias target is a STORED set id (en bare, ja namespaced), so it is used as-is. A raw
  // passthrough code is TCGdex's own, so for a non-en row it is namespaced into that locale's space —
  // a Japanese `sv11w` must never look inside the English `sv11w`.
  if (hit === undefined) return { setId: namespaceId(locale, rawCode), aliased: false };
  return { setId: hit, aliased: true };
}

/** Full deterministic resolve of a Dex row's `Id` (§1.3, steps that need no catalog). */
export function resolveDexId(
  row: Pick<DexRow, "Id" | "Locale">,
  alias: Readonly<Record<string, string>> = SET_ALIAS_SEED,
): ResolvedDexId {
  const locale = detectLocale(row);
  const { rawCode, localId } = parseDexId(row.Id);
  const { setId, aliased } = resolveSetId(locale, rawCode, alias);
  return { locale, setId, aliased, localIdCandidates: localIdCandidates(localId) };
}
