/**
 * The routing cascade (system-design §5; dev-spec §5 M3).
 *
 * Every card in a haul runs one ordered, TOTAL rule set. First match wins; every card gets a
 * destination; nothing falls through. The ordering encodes the collector's priorities:
 *
 *   1. COLLECTION CLAIM   → specialty binder (beats a line that needed the card)
 *   2. CARD CLASS         → specialty binder (ex / V / full art / …)
 *   3. DUPLICATE          → bulk, or a holo-swap; checked against SHELVED copies only
 *   4. LINE PARTICIPATION → fill an existing slot (Basic or Stage 1/2), or — Stage 1/2 only —
 *      extend/create a viable line (UIL-063: a Basic can JOIN an existing line but never CREATE
 *      one; manual creation from a single card is her call, not the cascade's — UIL-056). An
 *      existing line is matched by SPECIES ALONE, never band (UIL-065): her manually-created lines
 *      live in whatever band she picked, not the card's natural one, and a card joining one takes
 *      the LINE's band, not its own.
 *   5. BASIC, no existing line → front half, matching band
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
  /** UIL-030: a bulk-bound duplicate the engine offers as a repurposed binder block (an open need exists). */
  offerBlockRepurpose?: boolean;
  /** Holo-swap payload (step 3): incoming inherits the shelved role, normal → bulk. */
  swap?: HoloSwap | null;
  displacedToBulkCopyId?: string | null;
  /** The line the engine proposes to create (step 4, viable, no existing line). */
  newLine?: NewLinePlan | null;
  /** An existing line slot the incoming fills (step 4a). */
  filledExistingSlot?: { lineId: string; stageIndex: number } | null;
  /**
   * Set when `target` (the existing line's own band) differs from the incoming card's own natural
   * band (UIL-069). Karvi ruled that "the line's band wins" (UIL-065) must not be a SILENT default
   * when the two disagree — she is asked, every time, with neither option pre-selected. `target`
   * still names the line option (unchanged from UIL-065, so nothing downstream that already reads
   * `target` needs to change); this carries the OTHER option plus the line's own species root, so a
   * caller that presents the choice does not have to re-derive it. `lineRootDexId` is a bare number
   * rather than a display label on purpose — naming it is a display concern, not an engine one.
   */
  bandMismatch?: { ownColorTarget: PlacementTarget; lineRootDexId: number } | null;
  /** Owned copies to pull from front halves into a new line's slots. */
  pullActions?: PullAction[];
  /** Wishlist proposals for open placeholders / a stolen-line stage. */
  wishlist?: WishlistProposal[];
  /** Blocks, caps, terminations, holo-swaps, collection conflicts — all need confirmation. */
  proposals?: DecisionProposal[];
  /** Same-colour chain members counted by the viability test (steps "line-new"/"line-nonviable"). */
  sameColorMembers?: number;
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

/**
 * Find an existing line whose slot matches the incoming stage — by species (dexId) ALONE, not band
 * (UIL-065). A line's band is her own free pick (UIL-056 "start a new line"), not something the
 * cascade derives from the card's type, so filtering this lookup on the card's natural band made a
 * manually-banded line invisible to every future card of that species forever — silently defeating
 * UIL-063's fix for exactly the lines she built herself. The caller takes the LINE's own band for
 * placement (`existing.line.colorBand`), not the card's — she chose where the line physically lives.
 */
function existingLineSlot(
  incoming: IncomingCard,
  ctx: EngineContext,
): { line: EvolutionLine; slot: LineSlotRecord } | null {
  const dexId = incoming.card.dexId[0];
  for (const line of ctx.lines) {
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
    // Matched by species alone (UIL-065) — a manually-banded line still needs this stage regardless
    // of the claimed card's own natural band, and alternates are ranked in the LINE's band, since
    // that is the band the eventual copy would actually have to match.
    const needed = existingLineSlot(incoming, ctx);
    if (needed && needed.slot.state !== "filled") {
      // `EvolutionLine.colorBand` is a plain string (a persisted DB-key); `Band` is nominal
      // display-space, but production already trusts DB-key strings through it everywhere else in
      // this file (see `PlacementTarget.band`'s own docs elsewhere) — same trust here.
      const lineBand = needed.line.colorBand as Band;
      // The claimed copy lives in the specialty binder, so it is not itself an alternate to chase.
      const alt = rankAlternates(incoming.card.dexId[0], lineBand, ctx.catalog, map, priceOf, [
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
          reason: `The ${lineBand} line still needs its ${needed.slot.stage}; its slot stays a placeholder and these printings are proposed cheapest first.`,
          lineId: needed.line.id,
          stageIndex: needed.slot.stageIndex,
        },
      ];
    }
    return result;
  }

  /**
   * STEP 2 — DUPLICATE, vs SHELVED copies only. Holo-swap, else bulk.
   *
   * BEFORE the card-class check, deliberately (UIL-049). Her rule: "All cards, regardless of whether
   * they are specialty or not, must be suggested as 'Bulk' if they are duplicates." Card class used to
   * return first, so a specialty printing that duplicated something already shelved went to the
   * specialty binder — the opposite of that. A reordering, not a removal: a specialty card that is NOT a
   * duplicate still routes to the specialty binder in the step below.
   *
   * Narrow by construction: `resolveDuplicate` keys on `artworkGroupId` or the same `(setId, localId)`,
   * and a full-art specialty usually has different art from the standard print — so this fires for a
   * second copy of the SAME specialty printing, which is the case she described.
   */
  const dup = resolveDuplicate(incoming.card, incoming.variant, ctx.owned, ctx.openBlockNeeds ?? 0);
  if (dup.kind === "holo-swap") {
    const inherit = dup.swap.incomingInherits;
    const inheritedBand = (inherit.colorBand as Band) ?? b;
    /**
     * A displaced copy with NO binder half was in a specialty binder, which has neither halves nor
     * colour bands (system-design §4). Inheriting its place therefore means a `specialty` target, not a
     * front half.
     *
     * This branch only became reachable when UIL-049 moved the duplicate check above the card-class
     * check: before that a specialty card returned at card-class and never reached the swap. Without it
     * the swap emitted `{kind: "front-half", binderId: <the specialty binder>}` — a combination the write
     * layer cannot express, since `placementForMove` clears half and band for a collection destination.
     * The issue entry recorded this interaction as already safe; it was not, and the test above is what
     * caught it.
     */
    const target: PlacementTarget =
      inherit.binderHalf === null
        ? { kind: "specialty", binderId: inherit.binderId, collectionId: null }
        : inherit.binderHalf === "back" && inherit.lineSlotId
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
      offerBlockRepurpose: dup.offerBlockRepurpose,
      target: { kind: "bulk" },
    };
  }

  // STEP 3 — CARD CLASS. Specialty class → specialty binder.
  //
  // Now AFTER the duplicate check (UIL-049), so a duplicate specialty printing is bulked rather than
  // shelved a second time. Unchanged for every non-duplicate specialty card.
  if (incoming.card.cardClass === "specialty") {
    return {
      ...head,
      step: "card-class",
      reason: `cardClass = specialty (${incoming.card.rarity ?? "specialty"}); routes to the specialty binder.`,
      target: { kind: "specialty", binderId: specialtyBinderId(ctx), collectionId: null },
    };
  }

  // STEP 4 — LINE PARTICIPATION. Stage 1/2 can JOIN an existing line or (viable) CREATE one; a Basic
  // can only JOIN — never create, since manual creation from a single card is her call, not the
  // cascade's (UIL-056: she approves every new line). A Basic with no existing line to join falls
  // through to STEP 5 unchanged, same as it always has (UIL-063).
  const isLineStage = incoming.card.stage === "Stage1" || incoming.card.stage === "Stage2";
  const isBasic = incoming.card.stage === "Basic";
  if (isLineStage || isBasic) {
    // Matched by species alone (UIL-065) — see existingLineSlot's docstring.
    const existing = existingLineSlot(incoming, ctx);
    if (existing) {
      // The LINE's own band, not the card's natural one: she chose where the line physically lives
      // (UIL-056), and deriving placement from the line is the same inversion UIL-064's picker
      // already made in the UI — the engine should agree with it, not contradict it. Cast for the
      // same reason as STEP 1 above — `colorBand` is a persisted DB-key string, not the nominal
      // display-space `Band` union.
      const lineBand = existing.line.colorBand as Band;
      if (existing.slot.state === "placeholder" || existing.slot.state === "block") {
        // A colour mismatch is surfaced, never silently decided (UIL-069 — Karvi's ruling reverses
        // UIL-065's own "the line's band wins" default). `target` still names the line option so
        // nothing that already reads it needs to change; `bandMismatch` carries the other option for
        // a caller that presents both, and its ABSENCE (the common case: the two bands agree) means
        // there is nothing to ask.
        const mismatch = lineBand !== b;
        return {
          ...head,
          step: "line-existing",
          reason: mismatch
            ? `Fills the open ${existing.slot.stage} slot of the existing ${lineBand} line, in the back half — but this card's own colour is ${b}, so which one wins is her call (UIL-069).`
            : `Fills the open ${existing.slot.stage} slot of the existing ${lineBand} line, in the back half.`,
          target: {
            kind: "back-half-line",
            binderId: existing.line.binderId,
            band: lineBand,
            lineId: existing.line.id,
            stageIndex: existing.slot.stageIndex,
          },
          filledExistingSlot: {
            lineId: existing.line.id,
            stageIndex: existing.slot.stageIndex,
          },
          bandMismatch: mismatch
            ? {
                ownColorTarget: {
                  kind: "front-half",
                  binderId: frontHalfBinderId(ctx, b),
                  band: b,
                },
                lineRootDexId: existing.line.rootDexId,
              }
            : null,
        };
      }
      // Slot already filled → this stage is tracked once; the extra copy goes to the front half,
      // in ITS OWN natural band — the front half is not the line, so her band choice for the line
      // does not follow this spare copy there.
      return {
        ...head,
        step: "line-existing",
        reason: `The ${lineBand} line already holds this stage; the extra copy goes to the front half (lines tracked once).`,
        target: { kind: "front-half", binderId: frontHalfBinderId(ctx, b), band: b },
      };
    }
  }

  if (isLineStage) {
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
        sameColorMembers: via.members,
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
      sameColorMembers: via.members,
      proposals,
    };
  }

  // STEP 6 — TRAINER / SUPPORTER / ITEM (and any non-Pokémon) → front half, White band.
  // `b` is the map's OWN white key (Trainer/Supporter/Item/Colorless all map to White), so this
  // stays in the caller's band space instead of minting the literal "White" (UIL-012 — the literal
  // is not a color_band key and violated copy_color_band_fkey at commit).
  if (incoming.card.category === "Trainer" || incoming.card.category === "Energy") {
    return {
      ...head,
      step: "trainer",
      reason: `${incoming.card.category === "Energy" ? "Energy" : "Trainer / Supporter / Item"}; to the front half, White band.`,
      target: { kind: "front-half", binderId: frontHalfBinderId(ctx, b), band: b },
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
