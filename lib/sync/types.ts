/**
 * Core types for the Dex -> app reconciliation sync.
 * Authoritative spec: docs/sync-architecture.md.
 */

/** TCGdex locale a Dex row resolves against. */
export type Locale = "en" | "ja";

/** The verified Dex CSV column set (semicolon-delimited, UTF-16LE). */
export const DEX_CSV_COLUMNS = [
  "Type",
  "Category",
  "Locale",
  "Series",
  "Set",
  "Id",
  "Number",
  "Name",
  "Variant",
  "Rarity",
  "Illustrator",
  "Quantity",
  "Price",
  "Notes",
] as const;

export type DexColumn = (typeof DEX_CSV_COLUMNS)[number];

/** One parsed row of the Dex export, keyed by column name. */
export type DexRow = Record<DexColumn, string>;

/**
 * Result of resolving a Dex `Id` toward a TCGdex card. This is the deterministic
 * part of the join (§1.3): locale + candidate set id + ordered localId candidates.
 * The final catalog lookup (against the mirrored catalog) happens downstream.
 */
export interface ResolvedDexId {
  locale: Locale;
  /**
   * The set code exactly as her export wrote it (`jpn_` stripped) — NOT namespaced and NOT alias-mapped.
   *
   * The alias table is keyed `(locale, dex_code)` on this raw code (`resolveSetId` looks up
   * `${locale}:${rawCode}`), so anything that LEARNS an alias has to carry it. Without it the
   * name-resolution path keyed a learned Japanese alias on the namespaced id (`ja:sv9`), which
   * `resolveSetId` never looks up — so the alias was written and then never read (UIL-086).
   */
  rawCode: string;
  /** Best-guess TCGdex set id: alias-mapped when known, else the raw Dex code. */
  setId: string;
  /** True when `setId` came from the verified alias table, not a passthrough. */
  aliased: boolean;
  /** localId candidates to try in order (as-is, zero-padded, stripped). */
  localIdCandidates: string[];
}

/** Reconciliation identity key: preserves the RAW Dex variant string (§1.4). */
export interface PresenceKey {
  tcgdexId: string;
  dexVariantRaw: string;
}

/** Classification of a presence key when diffing desired vs current (§1.7). */
export type SyncClass = "UNCHANGED" | "ADDED" | "REMOVED" | "CHANGED" | "VARIANT_UPDATE";
