/**
 * Placement override — move ANY owned/shelved card (dev-spec §5 M7; memory-confirmed; system-design
 * §12 "coarse location is a feature").
 *
 * Pure translation of a move destination into the `copy` placement columns, plus the audit reason
 * for the `PlacementDecision` the move writes (`resolved_by: 'user'`). The escape hatch from the
 * cascade: no rule applies, it is her call. Moving a card off a line clears its `line_slot_id`; the
 * I/O layer reopens the vacated slot (removal symmetry, sync-arch §1.6).
 *
 * Coarse location only: a move sets binder + half + band (or a collection, or bulk); it never
 * addresses a pocket or page. It DOES resolve a line for a back-half destination now (UIL-056) — the
 * back half IS the lines area, so a shelf move that landed there with no line was always the same
 * strand `line_slot_id: null` describes. `buildNewLineJoinOps`/`buildExistingLineJoinOps` do that;
 * see `MoveDestination`'s `lineJoin` in ./types.
 *
 * This module is the ONE authority on what a destination means. That now covers two things, because
 * collection membership is derived from two facts, not one (app/(ui)/coll/actions.ts `loadCollHub`):
 * `placementForMove` says what the destination does to the copy's placement COLUMNS, and
 * `collectionTargetJoinOp` says what it does to the destination collection's CHASE LIST. Landing in a
 * collection's binder without joining its list leaves the card invisible in the very collection
 * holding it while occupying a real pocket (UIL-022) — so the two always travel together, and they
 * travel from here so no surface can hold a second, drifting definition of either (UIL-012's shape).
 *
 * Pure: no I/O. `WriteOp` is a type-only import (erased at build), so there is no runtime dependency
 * on lib/repo and no cycle.
 */

import {
  generateSlots,
  testViability,
  type Band,
  type CatalogCard,
  type IncomingCard,
  type TypeColorMap,
} from "@/lib/engine";
import type { WriteOp } from "@/lib/repo";
import type { CopyPlacementPatch, LineJoinChoice, MoveDestination, MoveOptions } from "./types";

/** Derive the four placement columns (+ cleared line link) for a moved copy. */
export function placementForMove(dest: MoveDestination): CopyPlacementPatch {
  switch (dest.kind) {
    case "bulk":
      // Bulk box has no internal structure: no binder, no half, no band, no line slot.
      return {
        role: "bulk",
        binder_id: null,
        binder_half: null,
        color_band: null,
        line_slot_id: null,
      };
    case "collection":
      // Specialty binders are a single section — no half, no rainbow band (system-design §4).
      return {
        role: "shelved",
        binder_id: dest.binderId,
        binder_half: null,
        color_band: null,
        line_slot_id: null,
      };
    case "shelf":
      return {
        role: "shelved",
        binder_id: dest.binderId,
        binder_half: dest.half,
        color_band: dest.band,
        line_slot_id: null,
      };
    case "block":
      // A binder block lives in the line's binder back half, in a reserved pocket run — no band, and
      // not "in" the slot the way a filled card is (the slot stays 'block'; binder_block tracks it).
      return {
        role: "block",
        binder_id: dest.binderId,
        binder_half: "back",
        color_band: null,
        line_slot_id: null,
      };
  }
}

/**
 * The writes that make a moved/overridden copy a BINDER BLOCK (UIL-030), emitted right after its copy
 * write by both `buildMoveOps` and the Haul Plan's `writeOverriddenCard` so the two cannot drift: the
 * `binder_block` row (line-terminated, a repurposed duplicate, pointing at the copy and the line) that
 * closes the open need, and the slot's note. Backfill writes the same row shape (lib/backfill/plan.ts).
 */
export function blockOps(
  dest: Extract<MoveDestination, { kind: "block" }>,
  copyId: string,
): WriteOp[] {
  return [
    {
      op: "insert_binder_block",
      id: crypto.randomUUID(),
      binder_id: dest.binderId,
      half: "back",
      pocket_count: 1,
      purpose: "line-terminated",
      material: "repurposedDuplicate",
      copy_id: copyId,
      line_id: dest.lineId,
    },
    { op: "update_slot", id: dest.slotId, patch: { note: "repurposed duplicate block" } },
  ];
}

/** Human destination label for the audit reason + the "MOVED → …" tag. */
export function describeMove(dest: MoveDestination, names: MoveNameLookups): string {
  switch (dest.kind) {
    case "bulk":
      return "Bulk box (not shelved)";
    case "collection": {
      const binder = names.binderName(dest.binderId);
      const coll = names.collectionName(dest.collectionId);
      return coll ? `${binder} · ${coll}` : binder;
    }
    case "shelf": {
      const binder = names.binderName(dest.binderId);
      const half = dest.half === "front" ? "Front" : "Back";
      const band = names.bandDisplay(dest.band);
      return `${binder} · ${half} · ${band}`;
    }
    case "block": {
      // "BLOCK · <species> line · <binder> back" when the caller can name the line (the Plan can, from
      // its candidates); the binder-only form otherwise.
      const line = names.lineLabel?.(dest.lineId);
      const binder = names.binderName(dest.binderId);
      return line ? `Block · ${line} · ${binder} · Back` : `${binder} · Back · Binder block`;
    }
  }
}

export interface MoveNameLookups {
  binderName: (id: string | null) => string;
  collectionName: (id: string) => string | null;
  bandDisplay: (key: string) => string;
  /** UIL-030: the species label of a line, for a block destination's sentence. Optional — only the
   *  Plan holds the candidates that know it. */
  lineLabel?: (lineId: string) => string | null;
}

/**
 * `describeMove`'s name lookups, resolved from the same `MoveOptions` the move panel is driven by.
 *
 * Lives here rather than beside its first caller because it now has two: the Line screen's server
 * action (which labels the move it just applied) and the Haul Plan, which labels an override she has
 * set but not yet shelved (UIL-037). Two copies of this would be free to drift, and a drift here does
 * not throw — it shows her a destination name that is subtly not the one she picked, which is the same
 * failure mode UIL-037 is itself about.
 *
 * Pure and dependency-free on purpose: the Plan caller is a client component.
 */
export function moveNameLookups(options: MoveOptions): MoveNameLookups {
  return {
    binderName: (id) => (id && options.binders.find((b) => b.id === id)?.name) || "Binder",
    collectionName: (id) => {
      for (const list of Object.values(options.collectionsByBinder)) {
        const hit = list.find((c) => c.id === id);
        if (hit) return hit.name;
      }
      return null;
    },
    bandDisplay: (key) => options.bands.find((b) => b.key === key)?.display ?? key,
  };
}

/**
 * Ops that let go of the line slot a copy is leaving (removal symmetry, sync-arch §1.6).
 *
 * ONE definition, because there are now three callers and the third was missing (UIL-062). `applyMove`
 * did this correctly; the Haul Plan's `writeOverriddenCard` did not, so overriding a card that filled a
 * slot cleared the copy's pointer — `placementForMove` clears `line_slot_id` for EVERY destination kind
 * — and left the slot `state: 'filled'` naming a copy that was no longer in it. Measured on Testing as
 * 5 stale slots. The Lines page reads the slot, so it rendered them as occupied by a card that had
 * moved, and nothing on screen contradicted it.
 *
 * `demoteLineId` is separate on purpose: a line that was `complete` is not complete once a stage
 * empties, and forgetting that leaves a line claiming completion it no longer has.
 *
 * Deliberately takes ids rather than resolving them: the Line screen resolves them with DB reads and
 * the Haul Plan resolves them from its in-memory context. Sharing the RESOLUTION would force one of
 * them into the wrong shape; sharing the emission is what stops the op lists drifting.
 */
export function releaseSlotOps(
  slotId: string | null | undefined,
  demoteLineId: string | null | undefined,
): WriteOp[] {
  const ops: WriteOp[] = [];
  if (slotId) {
    ops.push({
      op: "update_slot",
      id: slotId,
      patch: {
        state: "placeholder",
        copy_id: null,
        // A vacated slot is a new situation: whatever decision she resolved on it before it was filled
        // (UIL-078's "stays resolved" marker) must not carry over, or a released-and-refilled slot would
        // never ask again. Cleared here, on the one path every release goes through, so the Line move,
        // the Haul Plan pull (#145) and the Haul Plan override (#151) all get it without knowing.
        resolved_decision_kind: null,
        resolved_decision_choice: null,
        resolved_decision_collection_id: null,
      },
    });
  }
  if (demoteLineId) {
    ops.push({ op: "update_line", id: demoteLineId, patch: { status: "open" } });
  }
  return ops;
}

/**
 * The refusal when she asks for a SECOND line for one species, in one band, in one binder (UIL-084).
 *
 * One string, shared by `applyMove` and the Haul Plan's commit, so a stale pick reads the same way
 * whichever screen she moved from (the "one vocabulary" rule the other refusals already follow).
 *
 * Its predecessor — "A line for this species and band already exists — reload the screen and join it
 * instead." — was unactionable in the case she actually hit: the existing line's matching stage was
 * already FILLED, so there was no slot to join, and the refusal named the one remedy that did not
 * exist. This names the condition (this binder, this species, this band) and two remedies that do:
 * join the line's open slot IF it has one, or use the front half, which needs no line at all.
 */
export const LINE_EXISTS_IN_BINDER =
  "That binder already has a line for this species in this band. Join its open slot if it has one, " +
  "or place this copy in the front half.";

/** The `PlacementDecision.reason` recorded for a manual move (always `resolved_by: 'user'`). */
export function moveDecisionReason(dest: MoveDestination, destLabel: string): string {
  const where =
    dest.kind === "bulk"
      ? "the bulk box"
      : dest.kind === "collection"
        ? "a collection in the specialty binder"
        : dest.kind === "block"
          ? "a reserved pocket, as a repurposed binder block"
          : "a binder half + band";
  return `Manual placement override (your call, no rule applied): moved to ${where} — ${destLabel}.`;
}

/** Validate a destination before it is applied (guards the empty picker states the panel allows). */
export function isMoveDestinationComplete(dest: MoveDestination): boolean {
  switch (dest.kind) {
    case "bulk":
      return true;
    case "collection":
      return Boolean(dest.binderId && dest.collectionId);
    case "shelf":
      // The back half IS the lines area (UIL-056) — a back-half shelf is incomplete without a line
      // choice, the same way a specialty binder is incomplete without a collection.
      if (dest.half === "back" && !dest.lineJoin) return false;
      return Boolean(dest.binderId && dest.half && dest.band);
    case "block":
      return Boolean(dest.lineId && dest.slotId && dest.binderId);
  }
}

/**
 * The half a FRESH move panel opens on (no `initial` destination) — a regression `isMoveDestinationComplete`
 * itself surfaced (UIL-056): without the line picker (`allowLineJoin` false — the Plan spotlight,
 * Collections), defaulting to "back" opened the panel on a destination that check can never confirm,
 * with Confirm just sitting disabled and nothing explaining why. Only a caller that HAS the picker
 * (the Line screen) should default toward the back half — that is the entire point of that flow.
 */
export function defaultMoveHalf(
  initial: MoveDestination | undefined,
  allowLineJoin: boolean,
): "front" | "back" {
  if (initial?.kind === "shelf") return initial.half;
  return allowLineJoin ? "back" : "front";
}

/* ------------------- membership: the other half of a collection destination ------------------- */

/**
 * The chase-list write a destination implies — the SINGLE definition of "this card joins that
 * collection", shared by every surface that can send a card into one (UIL-022).
 *
 * A card is "in" a collection because a shelved copy sits in one of its binders AND the catalog id is
 * on `collection.target_catalog_card_ids`. `placementForMove` only ever produces the first fact, so a
 * `{kind: "collection"}` destination that stops there orphans the card: physically in the collection's
 * binder, absent from its list, therefore invisible in the collection view and every wishlist view
 * (both keyed off that column) while occupying a real pocket.
 *
 * Returns null for `bulk` / `shelf` — those destinations join nothing, and a caller that pushes the
 * null result would emit an op the RPC has no branch for, so callers must skip it.
 *
 * `union_collection_targets` (migration 0007) unions SERVER-SIDE in one statement, so it composes with
 * a concurrent edit instead of clobbering it, and re-sending an id already present is a no-op.
 */
export function collectionTargetJoinOp(
  dest: MoveDestination,
  catalogCardId: string,
): Extract<WriteOp, { op: "union_collection_targets" }> | null {
  if (dest.kind !== "collection") return null;
  return {
    op: "union_collection_targets",
    collection_id: dest.collectionId,
    catalog_card_ids: [catalogCardId],
  };
}

/* ---------------------- line join: the back-half destination's line target (UIL-056) --------------------- */

/** Fresh state a `{ mode: "new" }` join needs to build the family's line + slots. */
export interface NewLineContext {
  incoming: IncomingCard;
  catalog: CatalogCard[];
  typeColorMap: TypeColorMap;
  binderId: string | null;
  /**
   * The band SHE picked in the panel, not the card's own natural band. Coarse location is a
   * feature (system-design §12) — a move destination's band is her call, never re-derived — so the
   * line this creates, and every same-colour/placeholder lookup that builds its slots, must use this
   * band or the line would silently land in a different band than the copy it was created for.
   */
  destinationBand: string;
}

/**
 * Build the `insert_line` + `insert_slot` ops for starting a new line around `incoming` (UIL-056).
 * Reuses the M3 engine's own chain-walk and slot generation (`lib/engine/line.ts`) — the exact same
 * shapes the cascade's own line-new step produces — but forces `viable: true` regardless of the
 * `>= 2` same-colour threshold: a manual start is Karvi's own call on a single card, not a proposal
 * the engine is confident in, so the engine's confidence threshold does not apply here. `owned` is
 * passed as `[]` deliberately — this creates placeholders/blocks for the rest of the family but does
 * not reach out and pull any OTHER owned copy into the new line as a side effect of this move; she
 * can join those the same way (an "existing line" join) afterward.
 */
export function buildNewLineJoinOps(ctx: NewLineContext): {
  ops: WriteOp[];
  slotId: string | null;
  /** The line's actual root — NOT necessarily `incoming`'s own dexId when it isn't the chain's
   *  root (e.g. starting a line from a Stage1 whose Basic exists in the catalog as a placeholder).
   *  The caller's "does a line already exist" check must key on this, not the card's own dexId. */
  rootDexId: number;
} {
  const chainViability = testViability(ctx.incoming, [], ctx.catalog, ctx.typeColorMap);
  // Chain-walking is species-only (no band involved); same-colour/placeholder matching is not — so
  // `band` is overridden to HER destination band here, before any of that matching runs, rather than
  // trusting `testViability`'s own band guess from the card's type.
  // `Band` is a nominal display-space union; production actually carries DB-key strings through it
  // (the same trust the rest of this codebase already gives `band()`'s own return value) — never
  // validated against the ten literals here, same as elsewhere.
  const viability = { ...chainViability, band: ctx.destinationBand as Band, viable: true };
  const gen = generateSlots(ctx.incoming, viability, [], ctx.catalog, ctx.typeColorMap);
  const lineId = crypto.randomUUID();
  const rootDexId = viability.chain[0]?.dexId ?? ctx.incoming.card.dexId[0];
  const ops: WriteOp[] = [
    {
      op: "insert_line",
      id: lineId,
      root_dex_id: rootDexId,
      color_band: ctx.destinationBand,
      binder_id: ctx.binderId,
      half: "back",
      status: gen.status,
    },
  ];
  let ownSlotId: string | null = null;
  for (const slot of gen.slots) {
    const slotId = crypto.randomUUID();
    const isIncoming = slot.stageIndex === gen.incomingStageIndex;
    if (isIncoming) ownSlotId = slotId;
    ops.push({
      op: "insert_slot",
      id: slotId,
      line_id: lineId,
      stage_index: slot.stageIndex,
      stage: slot.stage,
      state: slot.state,
      copy_id: isIncoming ? ctx.incoming.id : null,
      target_catalog_card_id: slot.targetCatalogCardId,
      note: slot.note ?? null,
    });
  }
  return { ops, slotId: ownSlotId, rootDexId };
}

/**
 * Build the ops for joining an EXISTING line's open slot (UIL-056): fill the slot, and complete the
 * line when this was its last open stage. `slotIsLastOpen` is computed by the caller against fresh
 * slot rows — never trusted from the client, the same rule `reopenSlotId`/`demoteLineId` follow.
 */
export function buildExistingLineJoinOps(params: {
  copyId: string;
  lineId: string;
  slotId: string;
  slotIsLastOpen: boolean;
}): { ops: WriteOp[]; slotId: string } {
  const ops: WriteOp[] = [
    { op: "update_slot", id: params.slotId, patch: { state: "filled", copy_id: params.copyId } },
  ];
  if (params.slotIsLastOpen) {
    ops.push({ op: "update_line", id: params.lineId, patch: { status: "complete" } });
  }
  return { ops, slotId: params.slotId };
}

/** Read the `lineJoin` choice off a destination, if any (only a back-half shelf carries one). */
export function lineJoinOf(dest: MoveDestination): LineJoinChoice | null {
  return dest.kind === "shelf" ? (dest.lineJoin ?? null) : null;
}

/* ------------------------------ the whole move, as one op set ------------------------------ */

/** A move fully resolved against FRESH state: every id read from the DB, ready to become ops. */
export interface MovePlan {
  copyId: string;
  /** The moved copy's catalog id — needed to join a destination collection's chase list. */
  catalogCardId: string;
  destination: MoveDestination;
  /** The line slot this copy fills, which the move vacates. Null when it fills none. */
  reopenSlotId: string | null;
  /** The `complete` line to demote back to `open` because that slot is no longer filled. */
  demoteLineId: string | null;
  destinationLabel: string;
  /**
   * Ops a resolved `lineJoin` needs (UIL-056) — either filling an existing slot (+ completing its
   * line) or creating a new line and its slots. Must land BEFORE the copy's own placement update: a
   * new line's slot ids do not exist until `insert_line`/`insert_slot` run, and the copy update
   * below references one of them via `resolvedLineSlotId`. Resolved fresh by the caller (`applyMove`)
   * — never trusted from the client — the same rule `reopenSlotId`/`demoteLineId` already follow.
   */
  lineJoinOps?: WriteOp[];
  /** Overrides `placementForMove`'s default `null` when `lineJoinOps` resolved a slot to fill. */
  resolvedLineSlotId?: string | null;
}

/**
 * The complete ordered write set for one move (PURE — no I/O), applied verbatim inside ONE
 * transaction by `apply_write_ops`.
 *
 * Order mirrors `buildCollectionRemovalOps`: placement, then the vacated slot, then the demoted line,
 * then the membership list, then the audit row. Applied atomically the order only has to be FK-safe;
 * keeping it identical across the two paths means one shape to reason about, not two.
 *
 * `owner_id` is deliberately absent from every op — the RPC is SECURITY INVOKER, so the column
 * defaults to `auth.uid()` and 0002's `owner_all` RLS `with check` enforces it. It is never read from
 * a payload.
 */
export function buildMoveOps(plan: MovePlan): WriteOp[] {
  const patch = placementForMove(plan.destination);
  if (plan.resolvedLineSlotId !== undefined) patch.line_slot_id = plan.resolvedLineSlotId;
  const ops: WriteOp[] = [
    // A new line's slots (or the existing slot being filled) must exist before the copy update below
    // can reference one by id.
    ...(plan.lineJoinOps ?? []),
    {
      op: "update_copy",
      id: plan.copyId,
      patch: {
        role: patch.role,
        binder_id: patch.binder_id,
        binder_half: patch.binder_half,
        color_band: patch.color_band,
        line_slot_id: patch.line_slot_id,
      },
    },
  ];

  // Moving a card OFF a line reopens the slot it filled, and a line that was complete no longer is.
  // Shared with the Haul Plan's override path (UIL-062) so the two cannot drift.
  ops.push(...releaseSlotOps(plan.reopenSlotId, plan.demoteLineId));

  // Becoming a binder block writes the block row that closes the open need (UIL-030).
  if (plan.destination.kind === "block") ops.push(...blockOps(plan.destination, plan.copyId));

  // Landing in a collection means joining ITS chase list, or the card is orphaned there (UIL-022).
  const join = collectionTargetJoinOp(plan.destination, plan.catalogCardId);
  if (join) ops.push(join);

  ops.push({
    op: "insert_decision",
    haul_id: null,
    copy_id: plan.copyId,
    decision: "placement-move",
    reason: moveDecisionReason(plan.destination, plan.destinationLabel),
    resolved_by: "user",
  });

  return ops;
}
