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
  lineLocaleOf,
  type CatalogCard,
  type ChainNode,
  type IncomingCard,
  type TypeColorMap,
} from "@/lib/engine";
import { localeOfId } from "@/lib/catalog/locale";
import type { Locale } from "@/lib/sync/types";
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
  /** For the line's locale (UIL-090): the placeholder's target, used when the line holds no copy. */
  target_catalog_card_id?: string | null;
  /** For the line's locale: the filled copy, whose card's namespace wins over any target. */
  copy_id?: string | null;
}

export interface LineJoinIndex {
  /**
   * Every OPEN (not filled) slot across every line, by the dexId it wants — keyed `${locale}:${dexId}`
   * (UIL-090), because a Japanese card must never be offered an English line's slot and the two are the
   * same species. `joinOptionsFor` looks up its own card's locale.
   */
  openSlotsByDexId: Map<string, LineJoinCandidate[]>;
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
  /** This card's regional variant, so the panel keys its lookups the way the server does (UIL-090). */
  locale: Locale;
  /** Flat across every band, closest-to-complete first; each carries its own binder + band. */
  joinCandidates: LineJoinCandidate[];
  /**
   * Every line this family already has, ANYWHERE in the collection — every binder, every band, both
   * regional variants (UIL-096). Oldest first, as the loaders hand lines in.
   *
   * It was a record keyed by binder + band + locale, because the server REFUSED a second line on that key
   * (UIL-084) and the panel had to ask exactly the question the server asked. Karvi overruled the rule
   * itself: "Instead of blocking the creation of an evolution line, I want a warning that there is a line
   * existing in my ENTIRE collection (not just the binder)." So the refusal is gone, and a keyed record is
   * now the wrong shape twice over: it cannot answer "where else", and once two lines CAN share a key it
   * silently drops one of them. A list cannot.
   *
   * The per-binder match is still the panel's DEFAULT SUGGESTION (the join it offers first) — the
   * Senior BA's ruling: a suggestion, never a rule.
   */
  existingLines: ExistingLineBlock[];
}

/**
 * The key both sides of the line-uniqueness question use: one line per species per band per BINDER
 * (UIL-084). Defined once here so the panel's lookup and the index's population cannot drift — a
 * bulk/unbindered line keys on the empty string, matching `binder_id is null` on the server.
 */
export function lineKey(binderId: string | null, bandKey: string, locale: Locale): string {
  return `${binderId ?? ""}|${bandKey}|${locale}`;
}

/** Open slots are offered per LOCALE as well as per species (UIL-090). */
export function candidateKey(locale: Locale, dexId: number): string {
  return `${locale}:${dexId}`;
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
  /**
   * The stored card id of a filled copy — how a line's locale is derived (UIL-090).
   *
   * REQUIRED, deliberately: a default of "no copies" is not a safe fallback, it is a wrong answer. With
   * it, every line derives from its lowest placeholder target (or "en" when it has none), so a Japanese
   * line reads as English and the label and the key are both wrong. Let the compiler find the callers.
   */
  copyCardId: (copyId: string) => string | null,
): LineJoinIndex {
  const openSlotsByDexId = new Map<string, LineJoinCandidate[]>();
  const linesByRoot = new Map<number, ExistingLineBlock[]>();
  const chains = new Map<string, ChainNode[]>();

  for (const line of lines) {
    const slots = [...(slotsByLine.get(line.id) ?? [])].sort(
      (a, b) => a.stage_index - b.stage_index,
    );

    /**
     * The line's own locale (UIL-090), by the shared rule: filled copies first, then the lowest target.
     * Everything below depends on it — which cards may join, and what the line is CALLED.
     */
    const locale = lineLocaleOf(
      slots.map((s) => ({
        id: s.id,
        stageIndex: s.stage_index,
        stage: s.stage,
        state: "placeholder" as const, // unread by the derivation; the record shape wants it
        copyId: s.copy_id ?? null,
        dexId: null,
        targetCatalogCardId: s.target_catalog_card_id ?? null,
      })),
      copyCardId,
    );

    /**
     * Rebuild the chain from the root to name every slot (incl. blocks with no stored species), seeding
     * with a card OF THIS LINE'S LOCALE. Seeding with whatever printing the catalog listed first is how
     * every line of a species with a Japanese printing came to read "ノノクラゲ LINE": `makeNode` labels a
     * species with the SHORTEST name among the node's cards, and a Japanese name is usually shorter. Two
     * same-species lines were therefore indistinguishable on screen — and so were the two READINGS of
     * Karvi's screenshot, which is why her report could not be diagnosed from it.
     */
    const seed =
      catalog.find(
        (c) =>
          !c.isDigitalOnly && c.dexId.includes(line.rootDexId) && localeOfId(c.tcgdexId) === locale,
      ) ?? catalog.find((c) => !c.isDigitalOnly && c.dexId.includes(line.rootDexId));
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
      lineId: line.id,
      speciesLabel,
      filledCount,
      totalCount,
      binderId: line.binderId,
      bandKey: line.colorBand,
      locale,
    });
    linesByRoot.set(line.rootDexId, forRoot);
    for (const s of slots) {
      if (s.state === "filled") continue;
      const dexId = chain[s.stage_index]?.dexId;
      if (dexId === undefined) continue;
      const list = openSlotsByDexId.get(candidateKey(locale, dexId)) ?? [];
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
      openSlotsByDexId.set(candidateKey(locale, dexId), list);
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
  /** This card's own locale: it may only join a line of the same regional variant (UIL-090). */
  const locale = localeOfId(card.tcgdexId);
  const joinCandidates = sortJoinCandidates(
    index.openSlotsByDexId.get(candidateKey(locale, dexId)) ?? [],
  );

  // THIS card's own chain root (may differ from its own dexId, e.g. a Stage1 whose Basic exists in the
  // catalog): a family is identified by its root, which is what `linesByRoot` is keyed on.
  const cardChain = buildChain({ id: "u", card, variant: "normal" } as IncomingCard, catalog);
  const cardRootDexId = cardChain[0]?.dexId ?? dexId;

  return {
    dexId,
    locale,
    naturalBandKey: bandOf(card, typeColorMap),
    joinCandidates,
    // Unfiltered on purpose (UIL-096): every binder, band and locale. The panel decides what to say about
    // each; filtering here would decide for it, which is how the old record came to hide lines elsewhere.
    existingLines: [...(index.linesByRoot.get(cardRootDexId) ?? [])],
  };
}
