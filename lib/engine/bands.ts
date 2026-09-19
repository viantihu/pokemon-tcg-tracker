/**
 * Band derivation (system-design §4, dev-spec §5 M3).
 *
 * A card's colour band is computed from its energy type via an injected `TypeColorMap`. White is the
 * catch-all: it absorbs Colorless, Metal, and every Trainer / Supporter / Item. Fairy (Pink) sits
 * after Purple. Bands are first-class and ordered even at zero cards — the empty Pink band keeps its
 * slot in the rainbow (system-design §4), so `BAND_ORDER` always contains all ten.
 */

import type { CatalogCard, TypeColorMap } from "./types";

/**
 * The ten ordered bands. The order is the physical sort order in both halves of every general
 * binder, and the rainbow resets between halves. Fairy (Pink) is inserted after Purple; Metal is
 * folded into White (system-design §4, §10). Position is preserved even when a band is empty.
 */
export const BAND_ORDER = [
  "Red",
  "Orange",
  "Yellow",
  "Olive",
  "Green",
  "Dark blue",
  "Light blue",
  "Purple",
  "Pink",
  "White",
] as const;

export type Band = (typeof BAND_ORDER)[number];

/** The catch-all band, in DISPLAY-NAME space. Only used as the last-resort constant when a map
 *  cannot resolve its own white key (see `whiteKey`). Never return this into DB-key space. */
export const WHITE: Band = "White";

/**
 * The types White absorbs (system-design §4). Any of these keys names the white band IN THE MAP'S
 * OWN VOCABULARY, so they are how `band()` recovers the white key without minting a literal.
 */
const WHITE_ABSORBED = ["Colorless", "Metal", "Trainer", "Supporter", "Item"] as const;

/**
 * The white / catch-all band key expressed in the caller's OWN space (UIL-012).
 *
 * `band()` must never return a band string the caller's vocabulary does not contain: a literal
 * `"White"` returned into DB-key space is not a `color_band` row, so a stored `copy.color_band`
 * violates `copy_color_band_fkey` at commit. White absorbs Colorless/Metal/Trainer/Supporter/Item,
 * so the map's own entry for any of those names the white band in whatever space the map was loaded
 * — DB keys (`"white"`) in production, display names (`"White"`) in a hand-built display-space map. Only when the
 * map cannot resolve white at all (empty/broken config, surfaced separately by `assertBandConfig`)
 * do we fall back to the `WHITE` display constant.
 */
export function whiteKey(map: TypeColorMap): Band {
  for (const t of WHITE_ABSORBED) {
    const resolved = map[t];
    if (resolved) return resolved as Band;
  }
  return WHITE;
}

/*
 * There is deliberately NO default TypeColorMap here any more (UIL-013). The one that lived here was in
 * display-name space (`Fire: "Red"`), a vocabulary production never uses — the engine is always fed the
 * DB's `type_color_map` rows, key-form (`Fire: "red"`), by lib/plan/context.ts — and its only readers
 * were the engine tests, which is how a display literal used as a band value passed a green suite
 * while violating `copy_color_band_fkey` at commit (UIL-012). Tests build their map from the same
 * rows migration 0003 ships: tests/engine/fixtures.ts `KEY_FORM_TYPE_COLOR_MAP`.
 */
/**
 * The single type used to look a card up in the `TypeColorMap`.
 *
 * Pokémon carry `types` (usually one; the first is authoritative for placement). Trainers carry no
 * `types` — they route via `trainerType` (Supporter / Item / …) or, failing that, the literal
 * "Trainer". Energy and anything else fall through to White via the caller's map lookup.
 */
export function effectiveType(
  card: Pick<CatalogCard, "types" | "category" | "trainerType">,
): string {
  if (card.types && card.types.length > 0) return card.types[0];
  if (card.category === "Trainer") return card.trainerType ?? "Trainer";
  // Energy / unknown: no explicit key, resolves to White through the map fallback.
  return "Colorless";
}

/**
 * Resolve a card's colour band from an injected `TypeColorMap`. Unmapped types fall back to White,
 * which is the documented catch-all (Colorless, Metal, Trainer, Supporter, Item all live there).
 *
 * The fallback resolves to the map's OWN white key (`whiteKey`), never a hard-coded literal, so the
 * result is always a band the caller's space contains (UIL-012).
 */
export function band(
  card: Pick<CatalogCard, "types" | "category" | "trainerType">,
  map: TypeColorMap,
): Band {
  const type = effectiveType(card);
  const resolved = map[type];
  return (resolved as Band) ?? whiteKey(map);
}

/** Canonical comparison form so a band matches whether it arrives as a display name (`"Dark blue"`)
 *  or its DB key (`"dark_blue"`): lower-cased with spaces and underscores stripped. */
function normalizeBand(b: string): string {
  return b.toLowerCase().replace(/[\s_]+/g, "");
}

const BAND_ORDER_NORMALIZED = BAND_ORDER.map(normalizeBand);

/**
 * Sort index of a band in the rainbow, for ordering plans/sections. Accepts EITHER the display name
 * (`"White"`) or the DB key (`"white"`, `"dark_blue"`) — the stored `color_band` is a DB key, so a
 * key form used to always score "unknown, sort last" (UIL-012). Unknown bands still sort last.
 */
export function bandPosition(b: string): number {
  const i = BAND_ORDER_NORMALIZED.indexOf(normalizeBand(b));
  return i === -1 ? BAND_ORDER.length : i;
}

/**
 * Fail loudly if the band config is empty or internally inconsistent (UIL-012).
 *
 * The engine STORES a card's band and never re-derives it on read (decision §1), so a stored
 * `copy.color_band` must both equal `band(card, map)` AND be a `color_band` row (the FK target). Two
 * config states break that silently until a commit hits `copy_color_band_fkey`: an empty table (no
 * card can be placed) and a `type_color_map` value that is not a `color_band` key — e.g. a
 * hand-entered display name `"White"` where the key `"white"` is expected, which `0003_config.sql`'s
 * `on conflict do nothing` would leave in place beside the migration's own rows. Called at
 * plan-context load so both surface as a clear message on the first page load rather than as an
 * opaque 23503 after a whole haul has been built. Pure.
 *
 * @param map              `type_color_map` as loaded (card_type → band key).
 * @param orderedBandKeys  the `color_band` keys — the FK target set.
 */
export function assertBandConfig(map: TypeColorMap, orderedBandKeys: readonly string[]): void {
  if (orderedBandKeys.length === 0) {
    throw new Error(
      "Band config is empty: color_band has no rows. Migration 0003_config.sql fills it; the app " +
        "cannot place any card until it has run on this environment.",
    );
  }
  const entries = Object.entries(map);
  if (entries.length === 0) {
    throw new Error(
      "Band config is empty: type_color_map has no rows. Migration 0003_config.sql fills it; every " +
        "card would otherwise fall through to the same fallback and no haul could commit.",
    );
  }
  const known = new Set(orderedBandKeys);
  const orphans = entries.filter(([, bandKey]) => !known.has(bandKey));
  if (orphans.length > 0) {
    const detail = orphans.map(([type, bandKey]) => `${type} → "${bandKey}"`).join(", ");
    throw new Error(
      `type_color_map points at colour bands that color_band does not have (${detail}). Every mapped ` +
        `band must be one of [${orderedBandKeys.join(", ")}]. A display name such as "White" where the ` +
        `key "white" is expected is the usual cause — fix the row in Settings or via a migration.`,
    );
  }
}
