/**
 * Placement override — move ANY owned/shelved card (dev-spec §5 M7; memory-confirmed; system-design
 * §12 "coarse location is a feature").
 *
 * Pure translation of a move destination into the `copy` placement columns, plus the audit reason
 * for the `PlacementDecision` the move writes (`resolved_by: 'user'`). The escape hatch from the
 * cascade: no rule applies, it is her call. Moving a card off a line clears its `line_slot_id`; the
 * I/O layer reopens the vacated slot (removal symmetry, sync-arch §1.6).
 *
 * Coarse location only: a move sets binder + half + band (or a collection, or bulk). It never
 * auto-joins a line and never addresses a pocket or page.
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

import type { WriteOp } from "@/lib/repo";
import type { CopyPlacementPatch, MoveDestination, MoveOptions } from "./types";

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
  }
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
  }
}

export interface MoveNameLookups {
  binderName: (id: string | null) => string;
  collectionName: (id: string) => string | null;
  bandDisplay: (key: string) => string;
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

/** The `PlacementDecision.reason` recorded for a manual move (always `resolved_by: 'user'`). */
export function moveDecisionReason(dest: MoveDestination, destLabel: string): string {
  const where =
    dest.kind === "bulk"
      ? "the bulk box"
      : dest.kind === "collection"
        ? "a collection in the specialty binder"
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
      return Boolean(dest.binderId && dest.half && dest.band);
  }
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
  const ops: WriteOp[] = [
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

  // Moving a card OFF a line reopens the slot it filled (removal symmetry, sync-arch §1.6) …
  if (plan.reopenSlotId) {
    ops.push({
      op: "update_slot",
      id: plan.reopenSlotId,
      patch: { state: "placeholder", copy_id: null },
    });
  }
  // … and a line that was complete is no longer complete.
  if (plan.demoteLineId) {
    ops.push({ op: "update_line", id: plan.demoteLineId, patch: { status: "open" } });
  }

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
