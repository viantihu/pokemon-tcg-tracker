/**
 * The catalog's physical printings, indexed once per catalog array and language (the Tech Lead's profile, 2026-10-02).
 *
 * A chain is resolved by WALKING the catalog (`buildChain`, ./line): back through `evolveFrom` names, forward through
 * the cards that evolve from the current stage. Every step of that walk was a filter of the whole catalog: the
 * language's physical printings first (36,334 rows on her data), then by name, by species and by what a card evolves
 * from, at every stage, for every line and every card a screen asked about. A CPU profile of a production build on her
 * data put about 60% of a Lines load there, after it had come down to 14 round trips, and the Haul Plan's line-join
 * options (~1.9 s on 13 trips) on the same walk. `rankAlternates` filtered the whole catalog again for every open
 * stage it priced.
 *
 * So each of those questions is a lookup here instead, built in ONE pass per catalog array and language and kept in a
 * WeakMap keyed by the array, the way `chainFor` and the form index (./form) keep theirs: a reloaded catalog is a new
 * array and so a new index, and an old index goes with its array.
 *
 * THE SAME ANSWERS, IN THE SAME ORDER. Every list holds its cards in CATALOG order, so each lookup returns exactly what
 * the filter it replaces returned, card for card. The order is part of the answer: the walk follows `prev[0]`, a node
 * keeps its `cards` in that order, and its label is the shortest name among them with the first of equals winning.
 * Names are normalized exactly as the filters normalized them (trimmed, lower-cased); a card is listed under every
 * species in its `dexId`, once, as `dexId.includes` finds it once. Pinned against the old filters, kept as an oracle,
 * in tests/engine/catalog-index.test.ts.
 *
 * Shared, so read-only: every caller of one catalog reads the same lists. A caller that keeps one copies it.
 *
 * Pure and I/O-free, like the rest of lib/engine.
 */

import { localeOfId } from "@/lib/catalog/locale";
import type { Locale } from "@/lib/sync/types";
import type { CatalogCard } from "./types";

const norm = (s: string) => s.trim().toLowerCase();

/** One language's physical printings (or every language's), each lookup a list in catalog order. */
export interface PhysicalIndex {
  /** Every physical printing: what `catalog.filter((c) => !c.isDigitalOnly && localeOfId(c.tcgdexId) === locale)` was. */
  readonly cards: readonly CatalogCard[];
  /** By name, normalized. */
  readonly byName: ReadonlyMap<string, readonly CatalogCard[]>;
  /** By species: each card under every dex id it has, once. */
  readonly byDex: ReadonlyMap<number, readonly CatalogCard[]>;
  /** By the name a card evolves from, normalized: POSITIONS in `cards`, so several names merge back into catalog order. */
  readonly byEvolveFrom: ReadonlyMap<string, readonly number[]>;
}

/** The key for every language at once: the one question asked across both (the Lines screen's stage facts). */
const EVERY = "*";

const indexes = new WeakMap<readonly CatalogCard[], Map<Locale | typeof EVERY, PhysicalIndex>>();

/** The physical printings of a catalog in one language, or in every language when none is named. */
export function physicalIndex(catalog: readonly CatalogCard[], locale?: Locale): PhysicalIndex {
  let byLocale = indexes.get(catalog);
  if (!byLocale) {
    byLocale = new Map();
    indexes.set(catalog, byLocale);
  }
  const key = locale ?? EVERY;
  const hit = byLocale.get(key);
  if (hit) return hit;
  const ix = buildIndex(catalog, locale);
  byLocale.set(key, ix);
  return ix;
}

function buildIndex(catalog: readonly CatalogCard[], locale: Locale | undefined): PhysicalIndex {
  const cards: CatalogCard[] = [];
  const byName = new Map<string, CatalogCard[]>();
  const byDex = new Map<number, CatalogCard[]>();
  const byEvolveFrom = new Map<string, number[]>();
  for (const c of catalog) {
    if (c.isDigitalOnly) continue;
    if (locale !== undefined && localeOfId(c.tcgdexId) !== locale) continue;
    const at = cards.push(c) - 1;
    listUnder(byName, norm(c.name), c);
    // Once per species, as `includes` finds it once, however often the array names it.
    if (c.dexId.length === 1) listUnder(byDex, c.dexId[0], c);
    else for (const d of new Set(c.dexId)) listUnder(byDex, d, c);
    if (c.evolveFrom) listUnder(byEvolveFrom, norm(c.evolveFrom), at);
  }
  return { cards, byName, byDex, byEvolveFrom };
}

function listUnder<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

const NONE: readonly CatalogCard[] = [];

/** The printings named `name`, normalized as the walk compares names. */
export function printingsNamed(ix: PhysicalIndex, name: string): readonly CatalogCard[] {
  return ix.byName.get(norm(name)) ?? NONE;
}

/** The printings of a species: every card whose `dexId` includes it. */
export function printingsOfDex(ix: PhysicalIndex, dexId: number): readonly CatalogCard[] {
  return ix.byDex.get(dexId) ?? NONE;
}

/** The printings that evolve from any of `names` (already normalized), in catalog order. A new array. */
export function printingsEvolvingFrom(
  ix: PhysicalIndex,
  names: ReadonlySet<string>,
): CatalogCard[] {
  const at: number[] = [];
  for (const n of names) {
    const list = ix.byEvolveFrom.get(n);
    if (list) for (const i of list) at.push(i);
  }
  // A card evolves from one name, so the lists are disjoint; merged by position they are in catalog order again.
  if (names.size > 1) at.sort((a, b) => a - b);
  return at.map((i) => ix.cards[i]);
}
