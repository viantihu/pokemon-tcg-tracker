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

/** The catch-all band. Anything not explicitly mapped lands here (system-design §4). */
export const WHITE: Band = "White";

/**
 * The confirmed energy-type → band table (system-design §4). Callers normally inject their own map
 * (loaded from `type_color_map`); this is the verified default used when none is supplied and in
 * tests.
 */
export const DEFAULT_TYPE_COLOR_MAP: TypeColorMap = {
  Fire: "Red",
  Fighting: "Orange",
  Lightning: "Yellow",
  Dragon: "Olive",
  Grass: "Green",
  Darkness: "Dark blue",
  Water: "Light blue",
  Psychic: "Purple",
  Fairy: "Pink",
  // White absorbs all of these:
  Colorless: "White",
  Metal: "White",
  Trainer: "White",
  Supporter: "White",
  Item: "White",
};

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
 */
export function band(
  card: Pick<CatalogCard, "types" | "category" | "trainerType">,
  map: TypeColorMap,
): Band {
  const type = effectiveType(card);
  const resolved = map[type];
  return (resolved as Band) ?? WHITE;
}

/** Sort index of a band in the rainbow, for ordering plans/sections. Unknown bands sort last. */
export function bandPosition(b: string): number {
  const i = (BAND_ORDER as readonly string[]).indexOf(b);
  return i === -1 ? BAND_ORDER.length : i;
}
