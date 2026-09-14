/**
 * A stamp for "everything a computed haul plan depends on" (UIL-006).
 *
 * WHY. The plan lives only in React state, so navigating away throws away the run, the check-off set,
 * the cursor, and any placement overrides. Coming back means re-running from scratch — and the cost
 * lands exactly when she is standing at the binder working through a stack, which is when redoing
 * work is most expensive. Her rule is "the only time the haul plan needs to reload is if there's been
 * a change in the sync", and the way to honour that safely is to cache the run and invalidate it on a
 * stamp rather than trust that nothing moved.
 *
 * WHAT IT COVERS. A plan is `placeCard` over `loadPlanContext` + the draft, so the stamp has to move
 * whenever any cascade input does. Serving a silently stale plan would be the same class of bug as the
 * ones this log is full of, so the stamp errs toward changing too often rather than too rarely:
 *
 *   - `copy` count            — a sync apply/undo or a haul commit adds or removes copies
 *   - pending copy ids        — which cards are waiting to be placed (and the order they are worked)
 *   - last-sync snapshot id   — an apply overwrites it, an undo consumes it
 *   - `evolution_line` / `line_slot` counts — lines created or slots filled elsewhere (M7)
 *   - binder rows, in full    — capacity edits are IN PLACE, so a count would miss them entirely
 *   - collection ids + target counts — step 1 of the cascade is a collection claim
 *   - type→band map           — changes which band a card routes to
 *
 * What it deliberately does NOT cover: the catalog mirror. It is append-mostly reference data, a
 * ~23.5k-row count on every page load is not free, and a new printing cannot change where an
 * already-drafted card goes.
 *
 * The digest is a plain string, not a hash: it is compared for equality, never inverted, so hashing
 * would only make a mismatch harder to debug.
 */

import {
  binderRepo,
  collectionRepo,
  copyRepo,
  evolutionLineRepo,
  lineSlotRepo,
  lastSyncSnapshotRepo,
  typeColorMapRepo,
  type DbClient,
} from "@/lib/repo";

/** The raw inputs of the stamp, kept separate from the I/O so the digest is unit-testable. */
export interface PlanFingerprintParts {
  copyCount: number;
  /** Ids of the copies waiting to be placed, in queue order. */
  pendingCopyIds: readonly string[];
  snapshotId: string | null;
  lineCount: number;
  slotCount: number;
  /** Capacity-relevant binder columns; edits are in place, so the values matter, not the count. */
  binders: readonly {
    id: string;
    type: string;
    pages: number;
    pocketsPerPage: number;
    backHalfStartPage: number | null;
  }[];
  collections: readonly { id: string; targetCount: number }[];
  typeMap: readonly { cardType: string; band: string }[];
}

/**
 * Stable digest of the parts. Order-independent for sets, order-preserving for the queue.
 *
 * Serialized as JSON rather than joined with separators. A hand-rolled `join("|")` makes
 * `["a|b"]` and `["a", "b"]` digest identically — today's ids are UUIDs so that particular collision
 * cannot occur, but a stamp whose correctness rests on "the ids happen not to contain the separator"
 * is a trap for whoever changes an id format later. JSON is unambiguous by construction and still
 * perfectly readable when a mismatch needs explaining.
 */
export function planFingerprint(p: PlanFingerprintParts): string {
  return JSON.stringify({
    v: 1,
    copies: p.copyCount,
    // Queue ORDER is part of the identity: the plan's rows are worked in it.
    pending: [...p.pendingCopyIds],
    snapshot: p.snapshotId,
    lines: p.lineCount,
    slots: p.slotCount,
    binders: [...p.binders]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((b) => [b.id, b.type, b.pages, b.pocketsPerPage, b.backHalfStartPage]),
    collections: [...p.collections]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((c) => [c.id, c.targetCount]),
    typeMap: [...p.typeMap]
      .sort((a, b) => a.cardType.localeCompare(b.cardType))
      .map((t) => [t.cardType, t.band]),
  });
}

/**
 * Read the parts and digest them. Small reads only — three `head: true` counts plus three tiny
 * tables — so this is cheap enough to run on every visit to the plan route.
 */
export async function loadPlanFingerprint(
  db: DbClient,
  pendingCopyIds: readonly string[],
): Promise<string> {
  const [copyCount, lineCount, slotCount, binderRows, collectionRows, typeMapRows, snapshots] =
    await Promise.all([
      copyRepo.count(db),
      evolutionLineRepo.count(db),
      lineSlotRepo.count(db),
      binderRepo.list(db),
      collectionRepo.list(db),
      typeColorMapRepo.list(db),
      lastSyncSnapshotRepo.list(db),
    ]);

  return planFingerprint({
    copyCount,
    pendingCopyIds,
    snapshotId: snapshots[0]?.id ?? null,
    lineCount,
    slotCount,
    binders: binderRows.map((b) => ({
      id: b.id,
      type: b.type,
      pages: b.pages,
      pocketsPerPage: b.pockets_per_page,
      backHalfStartPage: b.back_half_start_page,
    })),
    collections: collectionRows.map((c) => ({
      id: c.id,
      targetCount: (c.target_catalog_card_ids ?? []).length,
    })),
    typeMap: typeMapRows.map((t) => ({ cardType: t.card_type, band: t.band })),
  });
}
