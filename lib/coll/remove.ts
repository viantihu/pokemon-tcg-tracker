/**
 * Remove a card from a collection — architecturally a MOVE, not a delete (UIL-014).
 *
 * WHY THIS EXISTS. `copy` has no `collection_id` (0002_domain.sql). A card is "in" a collection
 * because a shelved `copy` sits in one of the collection's binders AND its catalog id is on
 * `collection.target_catalog_card_ids`; membership is derived at read time from those two facts
 * (app/(ui)/coll/actions.ts `loadCollHub`). There is no field to clear, so removing a card means
 * rewriting the copy's placement AND dropping the id from the chase list.
 *
 * Those two writes MUST land together. Half-applied either way is corrupt:
 *   * placement rewritten, list edit lost → the card reappears as an un-owned target she is chasing
 *     even though she still holds it;
 *   * list entry dropped, placement rewrite lost → the copy is still shelved in the collection's
 *     binder while being invisible in every collection and wishlist view (both keyed off
 *     `target_catalog_card_ids`). An untracked physical card occupying a real pocket. That is exactly
 *     what the Edit modal's "✕" did before this fix: it persisted only the chase list.
 *
 * So the whole removal goes through `apply_write_ops` as ONE transaction (migration 0008 added the
 * `subtract_collection_targets` and `update_line` ops it needed). It stays a SEPARATE entry point from
 * `lib/line/write.ts`'s `applyMove` because a removal is not a move: it requires the card to be on the
 * source collection's list, subtracts it, refuses self-destinations, and re-homes EVERY copy in the
 * binder. (`applyMove` is atomic too as of UIL-023 — that caveat used to live here and is gone.)
 *
 * Neither the placement arithmetic nor the membership write is reinvented: `lib/line/move.ts` is the
 * one authority on what a destination means, and both halves are called from there unchanged —
 * `placementForMove` for the copy's columns, `collectionTargetJoinOp` for the destination collection's
 * chase list.
 *
 * Pure op-building is separated from I/O so the ordered write set is testable without a database.
 */

import {
  applyWriteOps,
  binderRepo,
  catalogCardRepo,
  collectionRepo,
  copyRepo,
  evolutionLineRepo,
  lineSlotRepo,
  type DbClient,
  type Row,
  type WriteOp,
} from "@/lib/repo";
import {
  collectionTargetJoinOp,
  describeMove,
  placementForMove,
  type MoveNameLookups,
} from "@/lib/line/move";
import type { MoveDestination } from "@/lib/line/types";

/* ------------------------------- pure planning ------------------------------ */

/** One physical copy leaving the collection, plus the line bookkeeping its departure implies. */
export interface RemovalCopy {
  id: string;
  /** The line slot this copy fills, which the move vacates. Null when it fills none. */
  reopenSlotId: string | null;
  /** The `complete` line to demote back to `open` because that slot is no longer filled. */
  demoteLineId: string | null;
}

/** A fully-resolved removal: every id read from fresh state, ready to become ops. */
export interface CollectionRemovalPlan {
  collectionId: string;
  collectionName: string;
  tcgdexId: string;
  /** Every shelved copy of the card sitting in one of the collection's binders. May be empty. */
  copies: RemovalCopy[];
  destination: MoveDestination;
  destinationLabel: string;
  /**
   * Set when the destination is a DIFFERENT collection. The card has to join that collection's target
   * list too, or moving it there would just re-orphan it in another binder.
   */
  destinationCollectionId: string | null;
}

/** The `PlacementDecision.reason` for a removal (always `resolved_by: 'user'`; dev-spec §4). */
export function removalDecisionReason(plan: {
  collectionName: string;
  destinationLabel: string;
  hasCopy: boolean;
}): string {
  if (!plan.hasCopy) {
    return (
      `Removed from ${plan.collectionName} (list only): no copy of this card was shelved in the ` +
      `collection's binder, so there was no placement to rewrite.`
    );
  }
  return (
    `Removed from ${plan.collectionName} — a removal is a move, not a delete (your call, no rule ` +
    `applied): the copy now lives in ${plan.destinationLabel}.`
  );
}

/**
 * The complete ordered write set for one removal. Applied verbatim inside one transaction, so the
 * order only has to be FK-safe and read-consistent: placement first (mirroring `applyMove`), then the
 * vacated slot, then the demoted line, then the two membership lists, then the audit rows.
 */
export function buildCollectionRemovalOps(plan: CollectionRemovalPlan): WriteOp[] {
  const patch = placementForMove(plan.destination);
  const ops: WriteOp[] = [];

  for (const copy of plan.copies) {
    ops.push({
      op: "update_copy",
      id: copy.id,
      patch: {
        role: patch.role,
        binder_id: patch.binder_id,
        binder_half: patch.binder_half,
        color_band: patch.color_band,
        line_slot_id: patch.line_slot_id,
      },
    });
  }

  // Moving a card OFF a line reopens the slot it filled (removal symmetry, sync-arch §1.6) …
  for (const copy of plan.copies) {
    if (copy.reopenSlotId) {
      ops.push({
        op: "update_slot",
        id: copy.reopenSlotId,
        patch: { state: "placeholder", copy_id: null },
      });
    }
  }
  // … and a line that was complete is no longer complete.
  for (const copy of plan.copies) {
    if (copy.demoteLineId) {
      ops.push({ op: "update_line", id: copy.demoteLineId, patch: { status: "open" } });
    }
  }

  ops.push({
    op: "subtract_collection_targets",
    collection_id: plan.collectionId,
    catalog_card_ids: [plan.tcgdexId],
  });

  // Landing in another collection means joining ITS chase list — otherwise the copy is shelved in
  // that collection's binder while being on no list at all, which is the orphan we are removing.
  // The op itself comes from `collectionTargetJoinOp` (lib/line/move.ts), the ONE definition of what
  // joining a collection means, shared with the Line-screen move and the Plan-commit override
  // (UIL-022). Only the "not the collection we are removing FROM" guard is local to this path.
  const join = collectionTargetJoinOp(plan.destination, plan.tcgdexId);
  if (join && join.collection_id !== plan.collectionId) ops.push(join);

  const reason = removalDecisionReason({
    collectionName: plan.collectionName,
    destinationLabel: plan.destinationLabel,
    hasCopy: plan.copies.length > 0,
  });
  if (plan.copies.length === 0) {
    ops.push({
      op: "insert_decision",
      haul_id: null,
      copy_id: null,
      decision: "collection-remove",
      reason,
      resolved_by: "user",
    });
  } else {
    for (const copy of plan.copies) {
      ops.push({
        op: "insert_decision",
        haul_id: null,
        copy_id: copy.id,
        decision: "collection-remove",
        reason,
        resolved_by: "user",
      });
    }
  }

  return ops;
}

/**
 * Reject a destination that would leave the card exactly where it is while dropping it from the list.
 * Returns the operator-facing error, or null when the destination is usable.
 *
 * Moving into a DIFFERENT collection that happens to share the same specialty binder is fine — the
 * card joins that collection's list, so it stays tracked.
 */
export function rejectSelfDestination(
  destination: MoveDestination,
  collectionId: string,
  collectionBinderIds: string[],
): string | null {
  if (destination.kind === "collection" && destination.collectionId === collectionId) {
    return "That is the collection you are removing it from. Pick a different home.";
  }
  if (destination.kind === "shelf" && collectionBinderIds.includes(destination.binderId)) {
    return "That is this collection's own binder. Pick a different home.";
  }
  return null;
}

/* ----------------------------------- I/O ----------------------------------- */

export interface CollectionRemovalResult {
  collectionName: string;
  movedCopyIds: string[];
  destinationLabel: string;
}

export interface CollectionRemovalRequest {
  collectionId: string;
  tcgdexId: string;
  destination: MoveDestination;
}

/**
 * Remove one card from one collection, atomically.
 *
 * Everything is re-derived from FRESH state — which copies are shelved in the collection's binders,
 * which slots they fill, which lines that demotes. The client sends only the collection, the catalog
 * id and the chosen destination; a stale copy id from the browser is never trusted (the same rule
 * `applyDecision` follows).
 *
 * ALL copies of the card shelved in the collection's binders move. Membership is per catalog card, so
 * leaving a second copy behind would leave it shelved in the collection's binder and on no list.
 */
export async function applyCollectionRemoval(
  db: DbClient,
  req: CollectionRemovalRequest,
  names: MoveNameLookups,
): Promise<CollectionRemovalResult> {
  const col = await collectionRepo.getByPk(db, req.collectionId);
  if (!col) throw new Error("That collection no longer exists.");

  const targets = col.target_catalog_card_ids ?? [];
  if (!targets.includes(req.tcgdexId)) {
    throw new Error("That card is no longer in this collection — reload and try again.");
  }

  const binderIds = col.current_binder_ids ?? [];
  const rejection = rejectSelfDestination(req.destination, col.id, binderIds);
  if (rejection) throw new Error(rejection);

  const copyRows = (await copyRepo.listByCatalogCard(db, req.tcgdexId)).filter(
    (c) => c.role === "shelved" && c.binder_id !== null && binderIds.includes(c.binder_id),
  );

  const copies: RemovalCopy[] = [];
  for (const c of copyRows) {
    let reopenSlotId: string | null = null;
    let demoteLineId: string | null = null;
    if (c.line_slot_id) {
      // By primary key: a full-table list is capped at the server's max-rows, so scanning for the
      // slot could silently miss it once the collection outgrows one page.
      const slot = await lineSlotRepo.getByPk(db, c.line_slot_id);
      if (slot && slot.copy_id === c.id) {
        reopenSlotId = slot.id;
        const line = await evolutionLineRepo.getByPk(db, slot.line_id);
        if (line && line.status === "complete") demoteLineId = line.id;
      }
    }
    copies.push({ id: c.id, reopenSlotId, demoteLineId });
  }

  const destinationLabel = describeMove(req.destination, names);
  const ops = buildCollectionRemovalOps({
    collectionId: col.id,
    collectionName: col.name,
    tcgdexId: req.tcgdexId,
    copies,
    destination: req.destination,
    destinationLabel,
    destinationCollectionId:
      req.destination.kind === "collection" ? req.destination.collectionId : null,
  });

  await applyWriteOps(db, { ops });

  return {
    collectionName: col.name,
    movedCopyIds: copies.map((c) => c.id),
    destinationLabel,
  };
}

/* --------------------- the guard on the chase-list editor -------------------- */

/** An owned target whose removal from the chase list would orphan its physical copy. */
export interface BlockedTargetDrop {
  tcgdexId: string;
  name: string;
  binderName: string;
  copyCount: number;
}

/**
 * The targets a chase-list save is trying to drop while a physical copy of them is still shelved in
 * the collection's binder.
 *
 * This is the backstop for defect (2) of UIL-014: the editor's "✕" edited only the in-memory draft and
 * `saveCollection` persisted it as `target_catalog_card_ids`, never touching the `copy` row — so every
 * owned card dropped from the list became an invisible copy in a real pocket. The client now hides
 * that control for owned targets, but a stale page, a second tab, or a direct action call would walk
 * straight back into it, so the refusal lives on the server.
 *
 * Dropping an UN-owned target is harmless (there is no copy to strand) and stays allowed.
 */
export async function blockedTargetDrops(
  db: DbClient,
  col: Row<"collection">,
  nextTargetIds: string[],
): Promise<BlockedTargetDrop[]> {
  const binderIds = col.current_binder_ids ?? [];
  if (binderIds.length === 0) return [];

  const keep = new Set(nextTargetIds);
  const dropped = (col.target_catalog_card_ids ?? []).filter((id) => !keep.has(id));
  if (dropped.length === 0) return [];

  const shelvedByCard = new Map<string, Row<"copy">[]>();
  for (const id of dropped) {
    const rows = (await copyRepo.listByCatalogCard(db, id)).filter(
      (c) => c.role === "shelved" && c.binder_id !== null && binderIds.includes(c.binder_id),
    );
    if (rows.length > 0) shelvedByCard.set(id, rows);
  }
  if (shelvedByCard.size === 0) return [];

  const [cards, binders] = await Promise.all([
    catalogCardRepo.listByIds(db, [...shelvedByCard.keys()]),
    binderRepo.list(db),
  ]);
  const nameById = new Map(cards.map((c) => [c.tcgdex_id, c.name]));
  const binderNameById = new Map(binders.map((b) => [b.id, b.name]));

  return [...shelvedByCard.entries()].map(([tcgdexId, rows]) => ({
    tcgdexId,
    name: nameById.get(tcgdexId) ?? tcgdexId,
    binderName: binderNameById.get(rows[0].binder_id as string) ?? "its binder",
    copyCount: rows.length,
  }));
}

/** The refusal shown when a save would strand owned copies. Names the cards; points at the fix. */
export function blockedTargetDropsMessage(blocked: BlockedTargetDrop[]): string {
  const named = blocked
    .slice(0, 3)
    .map((b) => `${b.name} (${b.binderName})`)
    .join(", ");
  const rest = blocked.length > 3 ? ` and ${blocked.length - 3} more` : "";
  return (
    `You still own ${named}${rest}. Taking a card off the list does not move the physical card, so ` +
    `it would stay in the binder while disappearing from every view. Use Remove on the card itself ` +
    `to give it a new home first.`
  );
}

/**
 * The same orphan class as `blockedTargetDrops`, triggered by a binder-id CHANGE instead of a
 * target-list drop (UIL-040). The chase list is untouched, but any binder leaving
 * `current_binder_ids` strands every shelved copy of a target card that was sitting there: it no
 * longer matches the collection's (new) binder list, so it reads as un-owned while still occupying a
 * real pocket in the old binder.
 */
export async function blockedBinderRebind(
  db: DbClient,
  col: Row<"collection">,
  nextBinderIds: string[],
): Promise<BlockedTargetDrop[]> {
  const removedBinderIds = (col.current_binder_ids ?? []).filter(
    (id) => !nextBinderIds.includes(id),
  );
  const targetIds = col.target_catalog_card_ids ?? [];
  if (removedBinderIds.length === 0 || targetIds.length === 0) return [];

  const shelvedByCard = new Map<string, Row<"copy">[]>();
  for (const id of targetIds) {
    const rows = (await copyRepo.listByCatalogCard(db, id)).filter(
      (c) => c.role === "shelved" && c.binder_id !== null && removedBinderIds.includes(c.binder_id),
    );
    if (rows.length > 0) shelvedByCard.set(id, rows);
  }
  if (shelvedByCard.size === 0) return [];

  const [cards, binders] = await Promise.all([
    catalogCardRepo.listByIds(db, [...shelvedByCard.keys()]),
    binderRepo.list(db),
  ]);
  const nameById = new Map(cards.map((c) => [c.tcgdex_id, c.name]));
  const binderNameById = new Map(binders.map((b) => [b.id, b.name]));

  return [...shelvedByCard.entries()].map(([tcgdexId, rows]) => ({
    tcgdexId,
    name: nameById.get(tcgdexId) ?? tcgdexId,
    binderName: binderNameById.get(rows[0].binder_id as string) ?? "its binder",
    copyCount: rows.length,
  }));
}

/** The refusal shown when a binder rebind would strand owned copies left behind in the old binder. */
export function blockedBinderRebindMessage(blocked: BlockedTargetDrop[]): string {
  const named = blocked
    .slice(0, 3)
    .map((b) => `${b.name} (${b.binderName})`)
    .join(", ");
  const rest = blocked.length > 3 ? ` and ${blocked.length - 3} more` : "";
  const count = blocked.reduce((n, b) => n + b.copyCount, 0);
  return (
    `Moving to a new binder would strand ${count} shelved card${count === 1 ? "" : "s"} in the old ` +
    `one, including ${named}${rest}. This app can't relocate a collection's cards yet — move them out ` +
    `individually first, or keep this collection in its current binder.`
  );
}
