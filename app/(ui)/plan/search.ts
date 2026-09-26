/**
 * "Search haul" (UIL-115): find a card in the plan she already has loaded. Karvi: "I'm loading hundreds of
 * cards at a time."
 *
 * CLIENT-SIDE, over the plan on screen, so it is instant at hundreds of cards and asks the server nothing.
 * A query is split into words, and a card matches when EVERY word does: "charm 026" finds Charmander
 * 026/197 and not every Charm-something. A word matches when it is part of the card's name, set, set code
 * (as stored, so a Japanese set's "ja:" prefix makes "ja" find her Japanese cards) or variant (her Dex's own "Reverse Holo" as well as the app's "reverse"), or when it IS the card's
 * collector number: "026", "26", "026/197" and "26/197" all find 026/197. A word of digits matches only
 * whole (a collector number, or a whole word such as the "151" in "Pokémon Card 151"), never as a
 * fragment, so "2" does not light up every card whose set code has a 2 in it. Accents fold ("flabebe"
 * finds Flabébé).
 *
 * Results keep the plan's own order, the order she works in. Shelved cards are included and marked Done
 * (the Senior BA's ruling): "where did I put it" is a real question at the table.
 *
 * PURE, so the matching rule is pinned without a DOM.
 */

import { formatCollectorNumber } from "@/lib/catalog/collector-number";
import type { PlanItem } from "@/lib/plan";

/** How many tiles show at once; "Show more" adds this many again, so hundreds never render at once. */
export const SEARCH_PAGE = 60;

export interface HaulSearchEntry {
  item: PlanItem;
  /** From the draft row: the plan item carries the set code, not its name. */
  setName: string | null;
  /** Her Dex's variant text, e.g. "Reverse Holo". */
  dexVariantRaw: string | null;
}

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Every way she might type this card's number: as printed, without leading zeros, with and without the set total. */
function numberForms(localId: string | null, total: number | null | undefined): Set<string> {
  if (!localId) return new Set();
  const id = fold(localId);
  const bare = id.replace(/^0+(?=\d)/, "");
  const out = new Set([id, bare]);
  const printed = formatCollectorNumber(localId, total ?? null);
  if (printed && printed.includes("/")) {
    const of = printed.slice(printed.indexOf("/"));
    out.add(id + of);
    out.add(bare + of);
  }
  return out;
}

/** The entries whose card matches every word of `query`, in the order given. An empty query matches none. */
export function searchHaul<T extends HaulSearchEntry>(entries: readonly T[], query: string): T[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return entries.filter((e) => {
    const { item } = e;
    const text = fold(
      [item.name, e.setName ?? "", item.setId ?? "", item.variant, e.dexVariantRaw ?? ""].join(" "),
    );
    const numbers = numberForms(item.localId, item.setCardCountOfficial);
    const wholeWords = new Set(text.split(/[^\p{L}\p{N}]+/u));
    return words.every((w) => {
      const word = w.replace(/^#/, "");
      if (numbers.has(word)) return true;
      if (/^[\d/]+$/.test(word)) return wholeWords.has(word);
      return text.includes(word);
    });
  });
}
