/**
 * The line-join options a card is offered (UIL-056, UIL-064): which existing lines have an open slot
 * for its species, which bands already hold a line for its family with that stage filled, and its own
 * type-derived band. PURE — no I/O — and shared by two screens (UIL-070 part 1): the Line screen's
 * `buildScreenModel` (lib/line/load.ts) and the Haul Plan's spotlight (lib/plan/line-join.ts). One
 * derivation, so "which lines can this card join" cannot mean two different things depending on
 * where she opened the picker.
 *
 * Lifted verbatim from `buildScreenModel`, where it was computed inline per line and per card. The
 * index is built once (one chain walk per line, reused for the Line screen's slot naming via
 * `chains`), then `joinOptionsFor` answers per card. Inputs are the shapes both callers already hold:
 * a minimal line record (DB row or engine `EvolutionLine`, structurally) and raw `line_slot` rows.
 */

import {
  band as bandOf,
  buildChain,
  type CatalogCard,
  type ChainNode,
  type IncomingCard,
  type TypeColorMap,
} from "@/lib/engine";
import type { ExistingLineBlock, LineJoinCandidate } from "./types";

/** The line columns the index reads — `Row<"evolution_line">` mapped, or an engine `EvolutionLine`. */
export interface JoinIndexLine {
  id: string;
  rootDexId: number;
  colorBand: string;
  binderId: string | null;
}

/** The slot columns the index reads — a raw `Row<"line_slot">` satisfies this structurally. */
export interface JoinIndexSlot {
  id: string;
  stage_index: number;
  stage: string;
  state: string;
}

export interface LineJoinIndex {
  /** Every OPEN (not filled) slot across every line, by the dexId it wants. */
  openSlotsByDexId: Map<number, LineJoinCandidate[]>;
  /** Every line for a family, by chain-root dexId — each carrying its own binder and band, so a
   *  caller can ask the question the server actually answers: is there already one HERE (UIL-084). */
  linesByRoot: Map<number, ExistingLineBlock[]>;
  /** Each line's chain rebuilt from its root, by line id — so the caller never walks it twice. */
  chains: Map<string, ChainNode[]>;
}

/** What the picker needs for one card. Serialisable: arrays, records and strings only. */
export interface LineJoinOptions {
  dexId: number;
  /** This card's own type-derived band — the "start a new line" default (UIL-064 part 1). */
  naturalBandKey: string;
  /** Flat across every band, closest-to-complete first; each carries its own binder + band. */
  joinCandidates: LineJoinCandidate[];
  /**
   * Every line this family already has, keyed by BINDER AND BAND (`lineKey`) — UIL-084.
   *
   * It was keyed by band alone AND filtered to bands with no open candidate, which is two ways of
   * disagreeing with the server: the refusal is keyed on the binder, and it fires whether or not the
   * card has an open slot in that line. So a back-half pick into a second binder looked allowed and
   * was refused, and a band with a joinable line showed no warning yet refused a NEW line there.
   * Unfiltered and binder-keyed, this answers exactly the question `applyMove` asks.
   */
  existingLineByBinderBand: Record<string, ExistingLineBlock>;
}

/**
 * The key both sides of the line-uniqueness question use: one line per species per band per BINDER
 * (UIL-084). Defined once here so the panel's lookup and the index's population cannot drift — a
 * bulk/unbindered line keys on the empty string, matching `binder_id is null` on the server.
 */
export function lineKey(binderId: string | null, bandKey: string): string {
  return `${binderId ?? ""}|${bandKey}`;
}

/** Closest-to-complete first (UIL-064 part 1) — finishing a nearly-done line is the more satisfying
 *  default, and in practice a card's species usually matches at most one candidate anyway. */
export function sortJoinCandidates(list: LineJoinCandidate[]): LineJoinCandidate[] {
  return [...list].sort((a, b) => {
    const ratioA = a.totalCount > 0 ? a.filledCount / a.totalCount : 0;
    const ratioB = b.totalCount > 0 ? b.filledCount / b.totalCount : 0;
    return ratioB - ratioA || a.speciesLabel.localeCompare(b.speciesLabel);
  });
}

export function buildLineJoinIndex(
  lines: readonly JoinIndexLine[],
  slotsByLine: ReadonlyMap<string, readonly JoinIndexSlot[]>,
  catalog: CatalogCard[],
): LineJoinIndex {
  const openSlotsByDexId = new Map<number, LineJoinCandidate[]>();
  const linesByRoot = new Map<number, ExistingLineBlock[]>();
  const chains = new Map<string, ChainNode[]>();

  for (const line of lines) {
    const slots = [...(slotsByLine.get(line.id) ?? [])].sort(
      (a, b) => a.stage_index - b.stage_index,
    );

    // Rebuild the chain from the root to name every slot (incl. blocks with no stored species).
    const seed = catalog.find((c) => !c.isDigitalOnly && c.dexId.includes(line.rootDexId));
    const chain = seed
      ? buildChain({ id: "r", card: seed, variant: "normal" } as IncomingCard, catalog)
      : [];
    chains.set(line.id, chain);

    const rootName = chain[0]?.name;
    const speciesLabel = rootName ? `${rootName.toUpperCase()} LINE` : "EVOLUTION LINE";
    const filledCount = slots.filter((s) => s.state === "filled").length;
    const totalCount = slots.length;
    const forRoot = linesByRoot.get(line.rootDexId) ?? [];
    forRoot.push({
      speciesLabel,
      filledCount,
      totalCount,
      binderId: line.binderId,
      bandKey: line.colorBand,
    });
    linesByRoot.set(line.rootDexId, forRoot);
    for (const s of slots) {
      if (s.state === "filled") continue;
      const dexId = chain[s.stage_index]?.dexId;
      if (dexId === undefined) continue;
      const list = openSlotsByDexId.get(dexId) ?? [];
      list.push({
        lineId: line.id,
        slotId: s.id,
        binderId: line.binderId,
        bandKey: line.colorBand,
        speciesLabel,
        stage: s.stage,
        filledCount,
        totalCount,
      });
      openSlotsByDexId.set(dexId, list);
    }
  }

  return { openSlotsByDexId, linesByRoot, chains };
}

/**
 * The options for one printing. Null for a Trainer/Energy — there is no line concept for them, which
 * is also why `buildScreenModel` never lists them as unlined.
 */
export function joinOptionsFor(
  card: CatalogCard,
  index: LineJoinIndex,
  typeColorMap: TypeColorMap,
  catalog: CatalogCard[],
): LineJoinOptions | null {
  const dexId = card.dexId[0];
  if (dexId === undefined) return null;
  const joinCandidates = sortJoinCandidates(index.openSlotsByDexId.get(dexId) ?? []);

  // THIS card's own chain root (may differ from its own dexId, e.g. a Stage1 whose Basic exists in
  // the catalog) — the same key `applyMove`'s "does a line already exist" check uses, so a band that
  // would REFUSE a new line explains why here rather than showing an empty candidate list.
  const cardChain = buildChain({ id: "u", card, variant: "normal" } as IncomingCard, catalog);
  const cardRootDexId = cardChain[0]?.dexId ?? dexId;
  // Every line this family already has, wherever it is — keyed the way the server refuses (UIL-084).
  // Not filtered by "has an open slot for this card": that filter is what let the panel recommend a
  // new line the write would reject.
  const existingLineByBinderBand: Record<string, ExistingLineBlock> = {};
  for (const line of index.linesByRoot.get(cardRootDexId) ?? []) {
    existingLineByBinderBand[lineKey(line.binderId, line.bandKey)] = line;
  }

  return {
    dexId,
    naturalBandKey: bandOf(card, typeColorMap),
    joinCandidates,
    existingLineByBinderBand,
  };
}
