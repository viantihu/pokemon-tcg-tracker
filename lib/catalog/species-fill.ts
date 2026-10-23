/**
 * A Pokémon printing TCGdex has not finished: no Pokédex number, and often no "evolves from" (UIL-138). The whole
 * "30th Celebration" set (30th, 30th-c) arrived this way, so its Vivillon matched no species: the cascade could not
 * find her Vivillon line, ran the new-line test on a card of no species, and told her there were "0 same-colour
 * cards" when the line was already there and full.
 *
 * A printing of the same name, in the same language, is the same Pokémon (the form is read off the name too, see
 * lib/engine/form.ts), so the gap is filled from one: its species, and the card it evolves from when this one says
 * none. A name whose printings disagree on the species is left as it is, rather than guessed.
 *
 * Read-time only: the row stays as TCGdex sent it, and once the mirror carries the number this changes nothing.
 * Pure and I/O-free.
 */

import { localeOfId } from "@/lib/catalog/locale";
import type { CatalogCard } from "@/lib/engine/types";

/** The mechanic a printing's name carries after the Pokémon's own: "Vivillon ex" is a Vivillon. */
const MECHANIC = /\s+(ex|v|vmax|vstar|v-union|gx|break|lv\.\s?x|prime|star|δ)$/i;

const speciesName = (name: string) => name.trim().replace(MECHANIC, "").trim().toLowerCase();
const keyOf = (c: CatalogCard) => `${localeOfId(c.tcgdexId)}|${speciesName(c.name)}`;

/** A Pokémon (it has a stage) whose printing names no species. */
const lacksSpecies = (c: CatalogCard) => c.dexId.length === 0 && c.stage != null;

interface Known {
  dexId: number[] | "conflict";
  /** The card each stage of this species evolves from, where a printing says. */
  evolveFrom: Map<string, string>;
}

/**
 * The catalog with every unfinished Pokémon printing's species filled from a same-name printing. The SAME array when
 * nothing is missing; otherwise a new one, where only the filled cards are new objects (the others are shared).
 */
export function fillMissingSpecies(cards: CatalogCard[]): CatalogCard[] {
  if (!cards.some(lacksSpecies)) return cards;
  const known = new Map<string, Known>();
  for (const c of cards) {
    if (c.dexId.length === 0 || c.isDigitalOnly) continue;
    const k = keyOf(c);
    const hit = known.get(k) ?? { dexId: c.dexId, evolveFrom: new Map<string, string>() };
    if (hit.dexId !== "conflict" && hit.dexId.join(",") !== c.dexId.join(","))
      hit.dexId = "conflict";
    if (c.stage && c.evolveFrom && !hit.evolveFrom.has(c.stage))
      hit.evolveFrom.set(c.stage, c.evolveFrom);
    known.set(k, hit);
  }
  return cards.map((c) => {
    if (!lacksSpecies(c)) return c;
    const hit = known.get(keyOf(c));
    if (!hit || hit.dexId === "conflict") return c;
    const evolveFrom =
      c.evolveFrom ??
      (c.stage && c.stage !== "Basic" ? (hit.evolveFrom.get(c.stage) ?? null) : null);
    return { ...c, dexId: [...hit.dexId], evolveFrom };
  });
}
