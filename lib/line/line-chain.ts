/**
 * An existing line's species chain (issue #493), shared by Lines' "Choose" popup (./stages-load) and its write
 * (./decide-stages), so the two can never disagree about which species a stage is.
 *
 * `buildChain` walks forward from a card only while the way is single: it stops at a branch (Gloom → Vileplume or
 * Bellossom, Eevee, Wurmple), because the card alone cannot say which way its line goes. A line whose top stage was
 * left "Not decided" then had no species for that stage, and the popup dropped it ("Every stage of this line holds a
 * card"), with no way to choose. Two answers, in order:
 *
 *   1. The chain is built from the HIGHEST card the line knows (a filled stage's card, else a chased target), so a
 *      line that already says which way it goes is read that way.
 *   2. When the chain still stops short of the line's stages, the species it can branch into are returned, and SHE
 *      picks one (`branchDexId`); the chain is then built through it. Nothing is picked for her.
 */

import {
  buildChain,
  physicalIndex,
  printingsEvolvingFrom,
  printingsOfDex,
  type CatalogCard,
  type ChainNode,
} from "@/lib/engine";
import { localeOfId } from "@/lib/catalog/locale";
import type { Locale } from "@/lib/sync/types";

/** A card the line knows at a stage: the copy filling it, or the target she chases there. */
export interface KnownStageCard {
  stageIndex: number;
  cardId: string;
}

export interface LineChain {
  chain: ChainNode[];
  /** The stage index where the chain stops at a branch short of the line's stages; null when it reaches them all. */
  branchAt: number | null;
  /** The species the line can follow from `branchAt`, by name; empty when there is no branch. */
  branches: ChainNode[];
}

const norm = (s: string) => s.trim().toLowerCase();

function node(dexId: number, cards: readonly CatalogCard[]): ChainNode {
  const name = cards.map((c) => c.name).sort((a, b) => a.length - b.length)[0] ?? "";
  return { dexId, stage: cards[0]?.stage ?? "", name, cards: [...cards] };
}

export function lineChain(args: {
  catalog: CatalogCard[];
  byId: ReadonlyMap<string, CatalogCard>;
  locale: Locale;
  /** The line's stage count: how far the chain has to reach. */
  slotCount: number;
  /** Cards the line knows, by stage. */
  known: readonly KnownStageCard[];
  /** The card the chain was built from before: the lowest filled stage's, else the root's printing. */
  fallback: CatalogCard | undefined;
  /** Her pick at the branch, when the chain stops at one. */
  branchDexId?: number;
}): LineChain {
  const { catalog, byId, locale, slotCount, known, fallback, branchDexId } = args;
  const build = (card: CatalogCard) => buildChain({ id: "line", card, variant: "normal" }, catalog);

  // 1. The highest known card whose chain puts it at its own stage (a stray target never shifts the stages).
  let chain: ChainNode[] | null = null;
  for (const k of [...known].sort((a, b) => b.stageIndex - a.stageIndex)) {
    const card = byId.get(k.cardId);
    if (!card || localeOfId(card.tcgdexId) !== locale) continue;
    const c = build(card);
    if (c[k.stageIndex]?.dexId === card.dexId[0]) {
      chain = c;
      break;
    }
  }
  chain ??= fallback ? build(fallback) : [];
  if (chain.length === 0 || chain.length >= slotCount) {
    return { chain, branchAt: null, branches: [] };
  }

  // 2. Short of the line's stages: the species the last stage branches into.
  const ix = physicalIndex(catalog, locale);
  const seen = new Set(chain.map((n) => n.dexId));
  const last = chain[chain.length - 1];
  const next = printingsEvolvingFrom(ix, new Set(last.cards.map((c) => norm(c.name)))).filter(
    (c) => c.dexId[0] !== undefined && !seen.has(c.dexId[0]),
  );
  const dexIds = Array.from(new Set(next.map((c) => c.dexId[0])));
  const branches = dexIds
    .map((d) => node(d, printingsOfDex(ix, d)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const branchAt = branches.length > 0 ? chain.length : null;

  if (branchDexId !== undefined && branchAt !== null) {
    const pick = branches.find((b) => b.dexId === branchDexId);
    const card = pick?.cards[0];
    if (card) {
      const through = build(card);
      if (through[branchAt]?.dexId === branchDexId) chain = through;
    }
  }
  return { chain, branchAt, branches };
}

/** The cards a line's slots know (#493): each filled stage's card, and each chased target. */
export function knownStageCards(
  slots: readonly {
    stage_index: number;
    copy_id: string | null;
    target_catalog_card_id: string | null;
    stage_choice?: string | null;
    state: string;
  }[],
  copiesById: ReadonlyMap<string, { catalog_card_id: string }>,
): KnownStageCard[] {
  const out: KnownStageCard[] = [];
  for (const s of slots) {
    const cardId =
      s.state === "filled" && s.copy_id
        ? copiesById.get(s.copy_id)?.catalog_card_id
        : s.stage_choice === "chase"
          ? s.target_catalog_card_id
          : null;
    if (cardId) out.push({ stageIndex: s.stage_index, cardId });
  }
  return out;
}
