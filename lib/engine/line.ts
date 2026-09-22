/**
 * Evolution-line engine (system-design §6; dev-spec §5 M3).
 *
 * Two responsibilities, both pure:
 *   1. VIABILITY — walk the species chain (via `evolveFrom` / `dexId`, excluding digital-only cards)
 *      and decide whether an incoming Stage-1/2 card is worth a back-half line. A line forms only if
 *      it will hold at least TWO same-colour members. This is a THRESHOLD, not a per-stage rule: the
 *      SAME catalog fact (a stage with no same-colour printing) kills a 2-stage chain but leaves a
 *      3-stage chain alive with a block slot (system-design/rationale — Scizor vs Trapinch).
 *   2. SLOT GENERATION — for a viable line, produce one slot per chain stage: filled / placeholder /
 *      block, with the side effects from the §6 table (pull actions, wishlist items, ex-only caps,
 *      root/interior blocks). Every block and termination is surfaced as a proposal; the engine
 *      never auto-blocks.
 *
 * No forward block is ever invented past the final species stage: the chain only extends to stages
 * that actually exist in the catalog, so a line whose top is the last evolution gets no phantom slot.
 */

import { band, type Band } from "./bands";
import type {
  CatalogCard,
  IncomingCard,
  LineStatus,
  OwnedCopy,
  SlotState,
  TypeColorMap,
} from "./types";

/** Injected price accessor (system-design §6 alternates rank by market price ascending). */
export type PriceOf = (card: CatalogCard) => number | null | undefined;

const defaultPriceOf: PriceOf = (c) => c.priceMarket;

/** A species-stage in the resolved chain, carrying every physical printing at that stage. */
export interface ChainNode {
  dexId: number;
  stage: string;
  name: string;
  cards: CatalogCard[];
}

const norm = (s: string) => s.trim().toLowerCase();

const physical = (catalog: CatalogCard[]) => catalog.filter((c) => !c.isDigitalOnly);

const byName = (cards: CatalogCard[], name: string) =>
  cards.filter((c) => norm(c.name) === norm(name));

const byDex = (cards: CatalogCard[], dexId: number) => cards.filter((c) => c.dexId.includes(dexId));

const evolvingFrom = (cards: CatalogCard[], names: Set<string>) =>
  cards.filter((c) => c.evolveFrom && names.has(norm(c.evolveFrom)));

function makeNode(dexId: number, cards: CatalogCard[]): ChainNode {
  // A dexId maps to a single species-stage; regional forms share it but the same-colour rule
  // separates them downstream. Use the shortest name as the base species label.
  const name = cards.map((c) => c.name).sort((a, b) => a.length - b.length)[0] ?? "";
  return { dexId, stage: cards[0]?.stage ?? "", name, cards };
}

/**
 * Resolve the full species chain around an incoming card, root → final, from the catalog. Walks
 * backward via `evolveFrom` and forward via cards that evolve FROM the current stage. Digital-only
 * cards are excluded. Forward walking stops at a branch (e.g. Eevee) because the incoming line is
 * ambiguous there; for a Stage-1/2 trigger the forward path is linear in practice.
 */
export function buildChain(incoming: IncomingCard, catalog: CatalogCard[]): ChainNode[] {
  const phys = physical(catalog);
  const xDex = incoming.card.dexId[0];
  const seen = new Set<number>([xDex]);

  // Backward to the root.
  const back: ChainNode[] = [];
  let cur: CatalogCard | undefined = incoming.card;
  while (cur?.evolveFrom) {
    const prev = byName(phys, cur.evolveFrom);
    if (prev.length === 0) break;
    const pDex = prev[0].dexId[0];
    if (pDex === undefined || seen.has(pDex)) break;
    seen.add(pDex);
    back.unshift(makeNode(pDex, byDex(phys, pDex)));
    cur = prev[0];
  }

  const xNode = makeNode(xDex, byDex(phys, xDex));

  // Forward to the final stage.
  const fwd: ChainNode[] = [];
  let frontier = new Set(xNode.cards.map((c) => norm(c.name)));
  while (back.length + fwd.length < 6) {
    const next = evolvingFrom(phys, frontier).filter((c) => !seen.has(c.dexId[0]));
    if (next.length === 0) break;
    const dexIds = Array.from(new Set(next.map((c) => c.dexId[0])));
    if (dexIds.length !== 1) break; // branch — cannot disambiguate the line's forward path
    const nDex = dexIds[0];
    seen.add(nDex);
    const node = makeNode(nDex, byDex(phys, nDex));
    fwd.push(node);
    frontier = new Set(node.cards.map((c) => norm(c.name)));
  }

  return [...back, xNode, ...fwd];
}

/** Same-colour physical printings at a node, split by class (system-design §6 slot table). */
function sameColour(node: ChainNode, b: Band, map: TypeColorMap) {
  const same = node.cards.filter((c) => band(c, map) === b);
  return {
    all: same,
    standard: same.filter((c) => c.cardClass === "standard"),
    specialty: same.filter((c) => c.cardClass === "specialty"),
  };
}

/**
 * An owned same-colour copy sitting at a node (used to fill slots and emit pull actions).
 *
 * BULK copies count (UIL-087, the Senior BA's ruling): a card in the pile is still hers, and pulling it
 * into its line is exactly the work a haul sitting is for — the write now shelves it and the disclosure
 * says to fetch it. `role: "block"` is the one exclusion, and not as a general role filter: a block copy
 * is a card deliberately sacrificed as a physical spacer and is REFERENCED BY a `binder_block` row, so
 * shelving it into a line would leave that row naming a copy which is now in a line slot — the same
 * half-written shape this entry exists to close. Un-blocking a line is a real action, but it is the
 * UIL-030 flow's to offer, with the block row removed in the same transaction, not a side effect of
 * filling a slot.
 */
function ownedAt(node: ChainNode, b: Band, owned: OwnedCopy[], map: TypeColorMap) {
  return owned.find(
    (o) => o.role !== "block" && o.card.dexId.includes(node.dexId) && band(o.card, map) === b,
  );
}

export interface Viability {
  viable: boolean;
  /** Count of same-colour members (owned or catalog-confirmed) across the chain. */
  members: number;
  chain: ChainNode[];
  band: Band;
  /** dexIds of chain stages with NO same-colour printing at all (block conditions). */
  blockedStages: number[];
}

/**
 * The viability test (system-design §6). Counts chain stages that have at least one prospective
 * same-colour member — an owned copy OR a catalog-confirmed printing that could be a placeholder.
 * `< 2` ⇒ not viable ⇒ the caller routes the card to the front half.
 */
export function testViability(
  incoming: IncomingCard,
  owned: OwnedCopy[],
  catalog: CatalogCard[],
  map: TypeColorMap,
): Viability {
  const b = band(incoming.card, map);
  const chain = buildChain(incoming, catalog);
  let members = 0;
  const blockedStages: number[] = [];
  for (const node of chain) {
    const sc = sameColour(node, b, map);
    const owns = ownedAt(node, b, owned, map);
    if (sc.all.length > 0 || owns) members += 1;
    else blockedStages.push(node.dexId);
  }
  return { viable: members >= 2, members, chain, band: b, blockedStages };
}

/** Ranked cheaper-first alternates for a placeholder (system-design §6 "Alternates"). */
export interface PricedAlternates {
  /** The cheapest chosen printing (target), or null when nothing same-colour exists. */
  chosenCatalogCardId: string | null;
  /** Remaining printings, market price ascending. */
  alternateCatalogCardIds: string[];
  /** True when only specialty-class printings exist — the card lives in the specialty binder. */
  willLiveInSpecialty: boolean;
}

/**
 * Rank same-species, same-colour, physical printings by market price ascending (ties broken by id
 * for determinism). Standard class is preferred; a stage with only specialty printings yields a
 * specialty target flagged `willLiveInSpecialty` (system-design §6 ex-only completion).
 */
export function rankAlternates(
  dexId: number,
  b: Band,
  catalog: CatalogCard[],
  map: TypeColorMap,
  priceOf: PriceOf = defaultPriceOf,
  exclude: readonly string[] = [],
): PricedAlternates {
  const excluded = new Set(exclude);
  const phys = physical(catalog).filter(
    (c) => c.dexId.includes(dexId) && band(c, map) === b && !excluded.has(c.tcgdexId),
  );
  const price = (c: CatalogCard) => {
    const p = priceOf(c);
    return p === null || p === undefined ? Number.POSITIVE_INFINITY : p;
  };
  const sortByPrice = (list: CatalogCard[]) =>
    [...list].sort((a, b2) => price(a) - price(b2) || a.tcgdexId.localeCompare(b2.tcgdexId));

  const standard = sortByPrice(phys.filter((c) => c.cardClass === "standard"));
  const specialty = sortByPrice(phys.filter((c) => c.cardClass === "specialty"));

  const ranked = standard.length > 0 ? standard : specialty;
  const willLiveInSpecialty = standard.length === 0 && specialty.length > 0;
  return {
    chosenCatalogCardId: ranked[0]?.tcgdexId ?? null,
    alternateCatalogCardIds: ranked.slice(1).map((c) => c.tcgdexId),
    willLiveInSpecialty,
  };
}

export interface WishlistProposal {
  stageIndex: number;
  requiredDexId: number;
  requiredType: string;
  requiredStage: string;
  chosenCatalogCardId: string | null;
  alternateCatalogCardIds: string[];
  willLiveInSpecialty: boolean;
}

export type LineProposalKind = "root-block" | "block" | "ex-only-cap";

export interface LineProposal {
  kind: LineProposalKind;
  stageIndex: number;
  dexId: number;
  reason: string;
}

export interface LineSlotPlan {
  stageIndex: number;
  stage: string;
  dexId: number;
  state: SlotState;
  /** Owned copy id that fills this slot, when filled. */
  copyId: string | null;
  /** Wishlist target for a placeholder slot. */
  targetCatalogCardId: string | null;
  /** Set when a filled slot must be pulled from a front half (worklist action). */
  pullFrom?: { binderId: string | null; half: "front" } | null;
  note?: string;
}

export interface SlotGeneration {
  slots: LineSlotPlan[];
  status: LineStatus;
  wishlist: WishlistProposal[];
  proposals: LineProposal[];
  /** stageIndex of the incoming card within the chain. */
  incomingStageIndex: number;
}

/**
 * Generate slots for a VIABLE line (system-design §6 slot table). The incoming card fills its own
 * stage; owned same-colour copies fill theirs (pulling from front halves); missing stages become
 * placeholders (with priced alternates) or, when no same-colour printing exists at all, blocks.
 */
export function generateSlots(
  incoming: IncomingCard,
  viability: Viability,
  owned: OwnedCopy[],
  catalog: CatalogCard[],
  map: TypeColorMap,
  priceOf: PriceOf = defaultPriceOf,
): SlotGeneration {
  const b = viability.band;
  const requiredType = incoming.card.types[0] ?? "Colorless";
  const slots: LineSlotPlan[] = [];
  const wishlist: WishlistProposal[] = [];
  const proposals: LineProposal[] = [];
  let capped = false;

  const incomingDex = incoming.card.dexId[0];
  const incomingStageIndex = viability.chain.findIndex((n) => n.dexId === incomingDex);

  viability.chain.forEach((node, stageIndex) => {
    const isRoot = stageIndex === 0;
    const sc = sameColour(node, b, map);
    const isIncoming = node.dexId === incomingDex;
    const ownedCopy = isIncoming ? undefined : ownedAt(node, b, owned, map);

    // Filled: the incoming card, or an owned same-colour copy (pulled from a front half if shelved).
    if (isIncoming) {
      slots.push({
        stageIndex,
        stage: node.stage,
        dexId: node.dexId,
        state: "filled",
        copyId: incoming.id,
        targetCatalogCardId: incoming.card.tcgdexId,
        note: "incoming this haul",
      });
      return;
    }
    if (ownedCopy) {
      const fromFront = ownedCopy.binderHalf === "front" && ownedCopy.role === "shelved";
      slots.push({
        stageIndex,
        stage: node.stage,
        dexId: node.dexId,
        state: "filled",
        copyId: ownedCopy.id,
        targetCatalogCardId: ownedCopy.card.tcgdexId,
        pullFrom: fromFront ? { binderId: ownedCopy.binderId, half: "front" } : null,
        /**
         * UIL-087: "already placed" was asserted for every copy that was not in a front half, which
         * quietly included copies that are placed NOWHERE. Karvi has to find that card before the line
         * really holds it, so the note says so instead of claiming it is already where it belongs.
         *
         * The wording is "not yet placed (still in the haul)", not "in the bulk box", on her ruling
         * (2026-09-22): the app conflates two different states in `role: 'bulk'` — a card deliberately
         * filed in a bulk box, and a card an import created that has not been placed anywhere yet. Only
         * the second is what a pulled copy usually is. Calling it "the bulk box" would assert a placement
         * she never made. That conflation is UIL-088; this wording is true under today's data and under
         * the model that replaces it.
         */
        note: fromFront
          ? "pull from front half"
          : ownedCopy.role === "bulk"
            ? "not yet placed (still in the haul)"
            : "already placed",
      });
      return;
    }

    // Not owned: placeholder (standard or specialty-only) or block (no same-colour printing).
    if (sc.all.length > 0) {
      const alt = rankAlternates(node.dexId, b, catalog, map, priceOf);
      if (alt.willLiveInSpecialty) capped = true;
      slots.push({
        stageIndex,
        stage: node.stage,
        dexId: node.dexId,
        state: "placeholder",
        copyId: null,
        targetCatalogCardId: alt.chosenCatalogCardId,
      });
      wishlist.push({
        stageIndex,
        requiredDexId: node.dexId,
        requiredType,
        requiredStage: node.stage,
        chosenCatalogCardId: alt.chosenCatalogCardId,
        alternateCatalogCardIds: alt.alternateCatalogCardIds,
        willLiveInSpecialty: alt.willLiveInSpecialty,
      });
      if (alt.willLiveInSpecialty) {
        proposals.push({
          kind: "ex-only-cap",
          stageIndex,
          dexId: node.dexId,
          reason: `Only specialty-class ${b} printings exist for ${node.name}; wishlist it to the specialty binder and cap the line.`,
        });
      }
      return;
    }

    // No same-colour printing at all → block. Root blocks keep the line; both surface a proposal.
    slots.push({
      stageIndex,
      stage: node.stage,
      dexId: node.dexId,
      state: "block",
      copyId: null,
      targetCatalogCardId: null,
      note: isRoot ? "root blocked" : "blocked",
    });
    proposals.push({
      kind: isRoot ? "root-block" : "block",
      stageIndex,
      dexId: node.dexId,
      reason: `No ${b} printing exists for ${node.name}; propose blocking this slot (never auto-blocked).`,
    });
  });

  const allFilled = slots.every((s) => s.state === "filled");
  const status: LineStatus = capped ? "capped" : allFilled ? "complete" : "open";

  return { slots, status, wishlist, proposals, incomingStageIndex };
}
