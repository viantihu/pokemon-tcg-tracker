/**
 * The routing cascade (system-design §5; dev-spec §5 M3).
 *
 * Every card in a haul runs one ordered, TOTAL rule set. First match wins; every card gets a
 * destination; nothing falls through. The ordering encodes the collector's priorities:
 *
 *   1. COLLECTION CLAIM   → specialty binder (beats a line that needed the card)
 *   2. CARD CLASS         → specialty binder (ex / V / full art / …)
 *   3. DUPLICATE          → bulk, or a holo-swap; checked against SHELVED copies only
 *   4. LINE PARTICIPATION → fill an existing slot, extend a line, or (viable) create one
 *   5. BASIC, no line     → front half, matching band
 *   6. TRAINER/…          → front half, White band
 *
 * Steps 1–4 are prescriptive; steps 5–6 suggest a binder from free capacity. Every block, cap and
 * termination is EMITTED as a proposal — the engine never auto-blocks (system-design §3, §6).
 *
 * Pure: no I/O. The clock (`now`) and market prices (`priceOf`) are injected via `EngineContext`.
 */

import { band, type Band } from "./bands";
import { resolveDuplicate, type HoloSwap } from "./duplicate";
import {
  generateSlots,
  rankAlternates,
  testViability,
  type LineSlotPlan,
  type PriceOf,
  type WishlistProposal,
} from "./line";
import type {
  Binder,
  CatalogCard,
  Collection,
  EvolutionLine,
  IncomingCard,
  LineSlotRecord,
  LineStatus,
  OwnedCopy,
  TypeColorMap,
} from "./types";

export interface EngineContext {
  typeColorMap: TypeColorMap;
  /** The relevant catalog slice: chain-building, same-colour existence, and alternate ranking. */
  catalog: CatalogCard[];
  /** Existing owned copies (duplicate detection consults SHELVED ones; lines pull from front halves). */
  owned: OwnedCopy[];
  binders: Binder[];
  lines: EvolutionLine[];
  collections: Collection[];
  /** Injected clock (ISO string) — the engine never calls Date.now(). */
  now: string;
  /** Injected market-price accessor; defaults to `card.priceMarket`. */
  priceOf?: PriceOf;
  /** Open binder-block needs; when > 0 a bulk-bound duplicate is offered as a repurposed block. */
  openBlockNeeds?: number;
}

export type CascadeStep =
  | "collection-claim"
  | "card-class"
  | "duplicate"
  | "line-existing"
  | "line-new"
  | "line-nonviable"
  | "basic-no-line"
  | "trainer";

export type PlacementTarget =
  | { kind: "specialty"; binderId: string | null; collectionId: string | null }
  | { kind: "bulk" }
  | { kind: "front-half"; binderId: string | null; band: Band }
  | {
      kind: "back-half-line";
      binderId: string | null;
      band: Band;
      /** Existing line id, or "new" for a line the engine is proposing to create. */
      lineId: string;
      stageIndex: number;
    };

export interface NewLinePlan {
  rootDexId: number;
  colorBand: Band;
  binderId: string | null;
  status: LineStatus;
  slots: LineSlotPlan[];
}

export type DecisionProposal =
  | {
      kind: "root-block" | "block" | "ex-only-cap";
      stageIndex: number;
      dexId: number;
      reason: string;
    }
  | { kind: "holo-swap"; reason: string; displacedCopyId: string }
  | { kind: "collection-vs-line"; reason: string; lineId: string; stageIndex: number }
  | { kind: "termination"; reason: string };

export interface PullAction {
  copyId: string;
  binderId: string | null;
  half: "front";
}

export interface CascadeResult {
  incomingId: string;
  step: CascadeStep;
  reason: string;
  resolvedBy: "auto";
  target: PlacementTarget;
  /** Holo-swap payload (step 3): incoming inherits the shelved role, normal → bulk. */
  swap?: HoloSwap | null;
  displacedToBulkCopyId?: string | null;
  /** The line the engine proposes to create (step 4, viable, no existing line). */
  newLine?: NewLinePlan | null;
  /** An existing line slot the incoming fills (step 4a). */
  filledExistingSlot?: { lineId: string; stageIndex: number } | null;
  /** Owned copies to pull from front halves into a new line's slots. */
  pullActions?: PullAction[];
  /** Wishlist proposals for open placeholders / a stolen-line stage. */
  wishlist?: WishlistProposal[];
  /** Blocks, caps, terminations, holo-swaps, collection conflicts — all need confirmation. */
  proposals?: DecisionProposal[];
}

const defaultPriceOf: PriceOf = (c) => c.priceMarket;

// --- Binder selection helpers (steps 4–6). ------------------------------------------------------

function generalBinders(ctx: EngineContext): Binder[] {
  return ctx.binders.filter((b) => b.type === "general");
}

function activeGeneral(ctx: EngineContext): Binder | undefined {
  return generalBinders(ctx).find((b) => b.isActive);
}

function specialtyBinderId(ctx: EngineContext): string | null {
  return ctx.binders.find((b) => b.type === "specialty")?.id ?? null;
}

/** Front-half suggestion: a general binder with free space in the band, else the active binder. */
function frontHalfBinderId(ctx: EngineContext, b: Band): string | null {
  const withSpace = generalBinders(ctx).find((bind) => (bind.freeFrontHalfByBand?.[b] ?? 0) > 0);
  return (withSpace ?? activeGeneral(ctx) ?? generalBinders(ctx)[0])?.id ?? null;
}

/**
 * New-line binder (decision §3): the active binder, falling back to the general binder with the
 * most free back-half capacity when the active one is full.
 */
function newLineBinderId(ctx: EngineContext): string | null {
  const active = activeGeneral(ctx);
  if (active && (active.freeBackHalf === undefined || active.freeBackHalf > 0)) {
    return active.id;
  }
  const roomiest = generalBinders(ctx)
    .filter((b) => (b.freeBackHalf ?? 0) > 0)
    .sort((a, b) => (b.freeBackHalf ?? 0) - (a.freeBackHalf ?? 0))[0];
  return (roomiest ?? active ?? generalBinders(ctx)[0])?.id ?? null;
}

/** Find an existing line (unique per species-chain + colour) whose slot matches the incoming stage. */
function existingLineSlot(
  incoming: IncomingCard,
  ctx: EngineContext,
  b: Band,
): { line: EvolutionLine; slot: LineSlotRecord } | null {
  const dexId = incoming.card.dexId[0];
  for (const line of ctx.lines) {
    if (line.colorBand !== b) continue;
    const slot = line.slots.find((s) => s.dexId === dexId);
    if (slot) return { line, slot };
  }
  return null;
}

// --- The cascade. -------------------------------------------------------------------------------

/** Route a single incoming card through the ordered cascade. Always returns a destination. */
export function placeCard(incoming: IncomingCard, ctx: EngineContext): CascadeResult {
  const map = ctx.typeColorMap;
  const priceOf = ctx.priceOf ?? defaultPriceOf;
  const b = band(incoming.card, map);
  const head = { incomingId: incoming.id, resolvedBy: "auto" as const };

  // STEP 1 — COLLECTION CLAIM. Membership beats a line that needed the card.
  const claim = ctx.collections.find((c) =>
    c.targetCatalogCardIds.includes(incoming.card.tcgdexId),
  );
  if (claim) {
    const result: CascadeResult = {
      ...head,
      step: "collection-claim",
      reason: `Belongs to collection "${claim.name}"; collection membership beats line participation, so it goes to the specialty binder.`,
      target: {
        kind: "specialty",
        binderId: claim.currentBinderIds[0] ?? null,
        collectionId: claim.id,
      },
    };
    // If a line still needs this stage, it keeps its placeholder and we list priced alternates.
    const needed = existingLineSlot(incoming, ctx, b);
    if (needed && needed.slot.state !== "filled") {
      // The claimed copy lives in the specialty binder, so it is not itself an alternate to chase.
      const alt = rankAlternates(incoming.card.dexId[0], b, ctx.catalog, map, priceOf, [
        incoming.card.tcgdexId,
      ]);
      result.wishlist = [
        {
          stageIndex: needed.slot.stageIndex,
          requiredDexId: incoming.card.dexId[0],
          requiredType: incoming.card.types[0] ?? "Colorless",
          requiredStage: incoming.card.stage ?? "",
          chosenCatalogCardId: alt.chosenCatalogCardId,
          alternateCatalogCardIds: alt.alternateCatalogCardIds,
          willLiveInSpecialty: alt.willLiveInSpecialty,
        },
      ];
      result.proposals = [
        {
          kind: "collection-vs-line",
          reason: `The ${b} line still needs its ${needed.slot.stage}; its slot stays a placeholder and these printings are proposed cheapest first.`,
          lineId: needed.line.id,
          stageIndex: needed.slot.stageIndex,
        },
      ];
    }
    return result;
  }

  // STEP 2 — CARD CLASS. Specialty class → specialty binder.
  if (incoming.card.cardClass === "specialty") {
    return {
      ...head,
      step: "card-class",
      reason: `cardClass = specialty (${incoming.card.rarity ?? "specialty"}); routes to the specialty binder.`,
      target: { kind: "specialty", binderId: specialtyBinderId(ctx), collectionId: null },
    };
  }

  // STEP 3 — DUPLICATE, vs SHELVED copies only. Holo-swap, else bulk.
  const dup = resolveDuplicate(incoming.card, incoming.variant, ctx.owned, ctx.openBlockNeeds ?? 0);
  if (dup.kind === "holo-swap") {
    const inherit = dup.swap.incomingInherits;
    const inheritedBand = (inherit.colorBand as Band) ?? b;
    const target: PlacementTarget =
      inherit.binderHalf === "back" && inherit.lineSlotId
        ? {
            kind: "back-half-line",
            binderId: inherit.binderId,
            band: inheritedBand,
            lineId: "inherited",
            stageIndex: -1,
          }
        : { kind: "front-half", binderId: inherit.binderId, band: inheritedBand };
    return {
      ...head,
      step: "duplicate",
      reason: `Holo duplicate of a shelved normal; the holo takes the normal's exact place${inherit.lineSlotId ? " including its line slot" : ""} and the normal goes to bulk.`,
      target,
      swap: dup.swap,
      displacedToBulkCopyId: dup.swap.displacedCopyId,
      proposals: [
        {
          kind: "holo-swap",
          reason: `Swap confirmed by the collector: incoming holo inherits the shelved copy's role; the displaced normal moves to the bulk box.`,
          displacedCopyId: dup.swap.displacedCopyId,
        },
      ],
    };
  }
  if (dup.kind === "bulk") {
    return {
      ...head,
      step: "duplicate",
      reason: `Duplicate of a shelved copy (shared artwork or same printing); to the bulk box.${
        dup.offerBlockRepurpose ? " Offered as a repurposed binder block." : ""
      }`,
      target: { kind: "bulk" },
    };
  }

  // STEP 4 — LINE PARTICIPATION (Stage 1 / Stage 2 only).
  const isLineStage = incoming.card.stage === "Stage1" || incoming.card.stage === "Stage2";
  if (isLineStage) {
    const existing = existingLineSlot(incoming, ctx, b);
    if (existing) {
      if (existing.slot.state === "placeholder" || existing.slot.state === "block") {
        return {
          ...head,
          step: "line-existing",
          reason: `Fills the open ${existing.slot.stage} slot of the existing ${b} line, in the back half.`,
          target: {
            kind: "back-half-line",
            binderId: existing.line.binderId,
            band: b,
            lineId: existing.line.id,
            stageIndex: existing.slot.stageIndex,
          },
          filledExistingSlot: {
            lineId: existing.line.id,
            stageIndex: existing.slot.stageIndex,
          },
        };
      }
      // Slot already filled → this stage is tracked once; the extra copy goes to the front half.
      return {
        ...head,
        step: "line-existing",
        reason: `The ${b} line already holds this stage; the extra copy goes to the front half (lines tracked once).`,
        target: { kind: "front-half", binderId: frontHalfBinderId(ctx, b), band: b },
      };
    }

    // No line yet → viability test.
    const via = testViability(incoming, ctx.owned, ctx.catalog, map);
    if (via.viable) {
      const gen = generateSlots(incoming, via, ctx.owned, ctx.catalog, map, priceOf);
      const binderId = newLineBinderId(ctx);
      const rootDexId = via.chain[0]?.dexId ?? incoming.card.dexId[0];
      const pullActions: PullAction[] = gen.slots
        .filter((s) => s.pullFrom && s.copyId)
        .map((s) => ({
          copyId: s.copyId as string,
          binderId: s.pullFrom!.binderId,
          half: "front",
        }));
      return {
        ...head,
        step: "line-new",
        reason: `Creates a viable ${b} ${via.chain[0]?.name ?? ""} line (${via.members} same-colour members) in the back half of the active binder.`,
        target: {
          kind: "back-half-line",
          binderId,
          band: b,
          lineId: "new",
          stageIndex: gen.incomingStageIndex,
        },
        newLine: { rootDexId, colorBand: b, binderId, status: gen.status, slots: gen.slots },
        pullActions,
        wishlist: gen.wishlist,
        proposals: gen.proposals,
      };
    }

    // Not viable → front half. A block leaving too few members is a proposed termination.
    const proposals: DecisionProposal[] =
      via.blockedStages.length > 0
        ? [
            {
              kind: "termination",
              reason: `Only ${via.members} same-colour member${
                via.members === 1 ? "" : "s"
              }; a blocked stage leaves too few for a line, so it is proposed as terminated and the card falls through to the front half.`,
            },
          ]
        : [];
    return {
      ...head,
      step: "line-nonviable",
      reason: `Not viable (${via.members} same-colour member${
        via.members === 1 ? "" : "s"
      }); to the front half, ${b} band.`,
      target: { kind: "front-half", binderId: frontHalfBinderId(ctx, b), band: b },
      proposals,
    };
  }

  // STEP 6 — TRAINER / SUPPORTER / ITEM (and any non-Pokémon) → front half, White.
  if (incoming.card.category === "Trainer" || incoming.card.category === "Energy") {
    return {
      ...head,
      step: "trainer",
      reason: `${incoming.card.category === "Energy" ? "Energy" : "Trainer / Supporter / Item"}; to the front half, White band.`,
      target: { kind: "front-half", binderId: frontHalfBinderId(ctx, "White"), band: "White" },
    };
  }

  // STEP 5 — BASIC, no line → front half, matching band.
  return {
    ...head,
    step: "basic-no-line",
    reason: `Basic with no line; to the front half, ${b} band (prefer a binder with open ${b} space, else the active binder).`,
    target: { kind: "front-half", binderId: frontHalfBinderId(ctx, b), band: b },
  };
}
