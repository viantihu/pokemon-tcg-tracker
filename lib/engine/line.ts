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

import { localeOfId } from "@/lib/catalog/locale";
import type { Locale } from "@/lib/sync/types";
import type { LineSlotRecord } from "./types";
import { band, type Band } from "./bands";
import { isPlaced } from "./types";
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

/**
 * Physical printings IN ONE LOCALE (UIL-090).
 *
 * An English and a Japanese printing of one species are two different cards with two placements
 * (sync-architecture L5), and a line belongs to one of them. The chain walk used the whole catalog, so
 * every `ChainNode` came back holding both namespaces — measured: a chain built from the English
 * Toedscruel returned `cards: ["ja:SV9-088", "sv09-088"]` at each node. Everything downstream inherited
 * it: a Japanese copy was offered an English line's open slot, a new line could be given placeholder
 * targets from the other locale, and the species LABEL took the shortest name across both, which is why
 * every line of that species read "ノノクラゲ LINE" whatever locale it actually was.
 *
 * `localeOfId` is imported rather than re-testing the `ja:` prefix here: lib/catalog/locale.ts is
 * deliberately the only place that prefix is spelled out, and a second copy of that rule is exactly how
 * the two drift. It is a pure string function, so the engine stays I/O-free.
 */
const physicalIn = (catalog: CatalogCard[], locale: Locale) =>
  catalog.filter((c) => !c.isDigitalOnly && localeOfId(c.tcgdexId) === locale);

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
  // The chain is scoped to the incoming card's own locale (UIL-090): a regional variant is a different
  // card, so it belongs to a different line. Derived from the card rather than passed in, so every
  // caller — the cascade, the pickers, the backfill, a line's own label — gets it without knowing.
  const phys = physicalIn(catalog, localeOfId(incoming.card.tcgdexId));
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
 * An owned same-colour copy of the SAME LOCALE sitting at a node (used to fill slots and emit pulls).
 *
 * THREE exclusions, from three entries, and all of them have to hold:
 *
 * BULK copies count (UIL-087, the Senior BA's ruling): a card in the pile is still hers, and pulling it
 * into its line is exactly the work a haul sitting is for — the write shelves it and the disclosure names
 * the bulk box so she knows where to go and get it. `role: "block"` is excluded, and not as a general role
 * filter: a block copy is a card deliberately sacrificed as a physical spacer and is REFERENCED BY a
 * `binder_block` row, so shelving it into a line would leave that row naming a copy which is now in a
 * line slot. Un-blocking a line belongs to the UIL-030 flow, with the block row removed in the same
 * transaction, not to filling a slot.
 *
 * IN-HAUL copies do NOT count (UIL-088). A bulk copy has a home she chose, so offering to pull it into a
 * line is a real proposal; an in-haul copy has no home at all — it IS the Haul Plan's queue, and proposing
 * it here would be the app placing a card behind her back. The role filter that was rightly declined for
 * UIL-087 became expressible once the two states were separate. Asked through `isPlaced`, which is her
 * SHELVED, so the line reads as the question it is.
 *
 * And only copies of the LINE'S OWN LOCALE (UIL-090): an English and a Japanese printing of one species
 * are two different cards with two placements (sync-architecture L5), so a Japanese copy never fills an
 * English line's slot and is never counted as already filling one.
 */
function ownedAt(node: ChainNode, b: Band, owned: OwnedCopy[], map: TypeColorMap, locale: Locale) {
  return owned.find(
    (o) =>
      o.role !== "block" &&
      isPlaced(o.role) &&
      localeOfId(o.card.tcgdexId) === locale &&
      o.card.dexId.includes(node.dexId) &&
      band(o.card, map) === b,
  );
}

/**
 * A LINE's locale, derived rather than stored (UIL-090).
 *
 * `evolution_line` has no locale column and needs none: `root_dex_id` is a species key shared by both
 * regional variants, so the locale can only come from the CARDS at the line's slots — and a stored id's
 * namespace IS its locale.
 *
 * THE RULE, and it is the same rule migration 0019 repairs by, deliberately: FILLED COPIES FIRST — the
 * lowest-stage slot that holds a copy — and only when the line holds no copy at all does it fall back to
 * the lowest slot's placeholder target. A copy is a card she physically owns; a target is a suggestion
 * the app made, and in an already-mixed line that suggestion is the thing that is wrong. Reading the
 * lowest slot's card WITHOUT that precedence would let a Japanese target at stage 0 declare an otherwise
 * English line Japanese — and a repair built on the same mistake would then release the ENGLISH targets
 * instead. The app and the migration must not be able to disagree about a line's locale.
 *
 * For a line that is already mixed it returns that answer and the write paths stop new ones; the Lines
 * screen flags the odd slot so she can move it out.
 *
 * Returns "en" for a line with no card at all, which is also the namespace-free default.
 */
export function lineLocaleOf(
  slots: readonly LineSlotRecord[],
  cardIdOfCopy: (copyId: string) => string | null,
): Locale {
  const ordered = [...slots].sort((a, b) => a.stageIndex - b.stageIndex);
  for (const s of ordered) {
    const id = s.copyId ? cardIdOfCopy(s.copyId) : null;
    if (id) return localeOfId(id);
  }
  for (const s of ordered) {
    if (s.targetCatalogCardId) return localeOfId(s.targetCatalogCardId);
  }
  return "en";
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
  // The card's own locale scopes everything below (UIL-090): a regional variant is a different card and
  // belongs to a different line, so it neither counts toward viability nor fills a slot here.
  const locale = localeOfId(incoming.card.tcgdexId);
  let members = 0;
  const blockedStages: number[] = [];
  for (const node of chain) {
    const sc = sameColour(node, b, map);
    const owns = ownedAt(node, b, owned, map, locale);
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
  /** The line's locale (UIL-090): an English line's wishlist must not rank Japanese printings. */
  locale: Locale,
  catalog: CatalogCard[],
  map: TypeColorMap,
  priceOf: PriceOf = defaultPriceOf,
  exclude: readonly string[] = [],
): PricedAlternates {
  const excluded = new Set(exclude);
  const phys = physicalIn(catalog, locale).filter(
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
  /** The line's locale is the incoming card's: it is the card that starts it (UIL-090). */
  const locale = localeOfId(incoming.card.tcgdexId);

  viability.chain.forEach((node, stageIndex) => {
    const isRoot = stageIndex === 0;
    const sc = sameColour(node, b, map);
    const isIncoming = node.dexId === incomingDex;
    const ownedCopy = isIncoming ? undefined : ownedAt(node, b, owned, map, locale);

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
         * really holds it, so the note says where it is instead of claiming it is already where it belongs.
         *
         * UIL-087 had to word that case as "not yet placed (still in the haul)" rather than naming the box,
         * because `role: 'bulk'` meant either "filed in a bulk box" or "imported and placed nowhere", and
         * asserting the box would have claimed a placement she never made. UIL-088 separated the two, and
         * an in-haul copy is no longer proposed as a pull at all (`ownedAt` asks `isPlaced`), so a bulk pull
         * really is in the bulk box. Saying so is both true and more useful: it tells her where to go.
         */
        note: fromFront
          ? "pull from front half"
          : ownedCopy.role === "bulk"
            ? "from the bulk box"
            : "already placed",
      });
      return;
    }

    // Not owned: placeholder (standard or specialty-only) or block (no same-colour printing).
    if (sc.all.length > 0) {
      const alt = rankAlternates(node.dexId, b, locale, catalog, map, priceOf);
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
