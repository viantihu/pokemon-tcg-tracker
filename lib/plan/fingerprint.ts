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
 *   - copy PLACEMENTS, as a multiset — where every copy sits, not how many there are
 *   - pending copy ids        — which cards are waiting to be placed (and the order they are worked)
 *   - last-sync snapshot id   — an apply overwrites it, an undo consumes it
 *   - `evolution_line` rows: id + status + band — a decision caps or terminates a line IN PLACE
 *   - `line_slot` rows: id + state + filling copy + wishlist target — all rewritten IN PLACE by M7
 *   - binder rows, in full    — capacity edits are IN PLACE, so a count would miss them entirely
 *   - collection ids + target counts — step 1 of the cascade is a collection claim
 *   - type→band map           — changes which band a card routes to
 *   - `placement_decision` count — a backstop, see below
 *
 * COUNTS ARE NOT ENOUGH. The first version of this stamp reasoned correctly that binder capacity is
 * edited in place and so carried binder rows whole, then used plain row COUNTS for copies, lines and
 * slots. That left two holes, both reachable from the M7 line screen and both able to change what an
 * incoming card routes to without moving the stamp by a character:
 *
 *   1. A placement move (`lib/line/write.ts`) rewrites one copy's `role` / `binder_id` /
 *      `binder_half` / `color_band` / `line_slot_id`. The row count does not change, but
 *      `resolveDuplicate` only considers `role: 'shelved'` copies, `ownedAt` picks the copy that fills
 *      a generated slot, and the pull-from-front-half hint reads `binderHalf` + `role`. Moving a card
 *      out of a binder half can turn "duplicate, send to bulk" into "shelve it" — silently.
 *   2. A decision resolution rewrites `line_slot.state` (and its `copy_id` / target) and
 *      `evolution_line.status`. Again no count changes, but the cascade routes FILL vs FRONT on
 *      `slot.state` and skips a line whose needed slot is already `filled`.
 *
 * So slots and lines are carried as rows (both tables are small), and copies are carried as a
 * MULTISET OF PLACEMENTS: distinct `(role, binderId, binderHalf, colorBand, lineSlotId)` tuples with
 * a count each. That is the shape that matters — the cascade never asks which copy, only what is
 * where — and it stays compact at collection scale, because hundreds of bulk copies collapse to one
 * entry and shelved copies collapse per binder half per band. Two copies trading places within the
 * same tuple is invisible here, and correctly so: it is invisible to the cascade too. Two copies
 * trading LINE SLOTS is not invisible, because `line_slot.copy_id` is carried per row.
 *
 * Copy `variant` and `catalog_card_id` are also cascade inputs (the holo-swap step reads both) and can
 * be rewritten in place by a sync apply — but every apply writes a fresh undo snapshot and every undo
 * consumes it, so `snapshotId` already covers that path.
 *
 * `placement_decision` is a count and a deliberate backstop rather than a primary input: every user
 * move and every decision resolution writes exactly one audit row, so any placement write we have not
 * enumerated still moves the stamp. It can over-invalidate — re-confirming a card into the spot it is
 * already in bumps it — and that is the direction to err in.
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
  placementDecisionRepo,
  typeColorMapRepo,
  type DbClient,
} from "@/lib/repo";

/** Where one copy sits. The cascade reads exactly these columns off an owned copy. */
export interface StampCopyPlacement {
  role: string;
  binderId: string | null;
  binderHalf: string | null;
  colorBand: string | null;
  lineSlotId: string | null;
}

/** A line's mutable-in-place state. Its band is rewritten by a Settings type→band remap. */
export interface StampLineState {
  id: string;
  status: string;
  colorBand: string | null;
}

/** A slot's mutable-in-place state: what the cascade routes FILL vs FRONT on. */
export interface StampSlotState {
  id: string;
  state: string;
  copyId: string | null;
  targetCatalogCardId: string | null;
}

/** The raw inputs of the stamp, kept separate from the I/O so the digest is unit-testable. */
export interface PlanFingerprintParts {
  /** One entry per copy. Digested as a multiset of placements — see the header. */
  copies: readonly StampCopyPlacement[];
  /** Ids of the copies waiting to be placed, in queue order. */
  pendingCopyIds: readonly string[];
  snapshotId: string | null;
  lines: readonly StampLineState[];
  slots: readonly StampSlotState[];
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
  /** Audit rows: one per user move or decision resolution. A backstop — see the header. */
  decisionCount: number;
}

const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);

/**
 * Copies → sorted `[role, binderId, binderHalf, colorBand, lineSlotId, count]` tuples.
 *
 * Grouping is what keeps this affordable: the stamp is computed on every visit to `/plan` and shipped
 * to the client in the RSC payload, so it has to stay small while still moving for any placement
 * change. A per-copy list would be linear in the collection; the distinct-placement list is bounded by
 * binders × halves × bands plus one entry per line-bound copy.
 */
function digestCopies(copies: readonly StampCopyPlacement[]): (string | number | null)[][] {
  const groups = new Map<string, { at: StampCopyPlacement; n: number }>();
  for (const c of copies) {
    const key = JSON.stringify([c.role, c.binderId, c.binderHalf, c.colorBand, c.lineSlotId]);
    const hit = groups.get(key);
    if (hit) hit.n += 1;
    else groups.set(key, { at: c, n: 1 });
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, { at, n }]) => [at.role, at.binderId, at.binderHalf, at.colorBand, at.lineSlotId, n]);
}

/**
 * Stable digest of the parts. Order-independent for sets, order-preserving for the queue.
 *
 * Serialized as JSON rather than joined with separators. A hand-rolled `join("|")` makes
 * `["a|b"]` and `["a", "b"]` digest identically — today's ids are UUIDs so that particular collision
 * cannot occur, but a stamp whose correctness rests on "the ids happen not to contain the separator"
 * is a trap for whoever changes an id format later. JSON is unambiguous by construction and still
 * perfectly readable when a mismatch needs explaining.
 *
 * `v` is the shape version. Bump it whenever the parts change, so a plan parked in sessionStorage
 * under the old shape is dropped on the next deploy instead of being compared field-by-field against
 * a stamp that no longer means the same thing.
 */
export function planFingerprint(p: PlanFingerprintParts): string {
  return JSON.stringify({
    v: 2,
    copies: digestCopies(p.copies),
    // Queue ORDER is part of the identity: the plan's rows are worked in it.
    pending: [...p.pendingCopyIds],
    snapshot: p.snapshotId,
    decisions: p.decisionCount,
    lines: [...p.lines].sort(byId).map((l) => [l.id, l.status, l.colorBand]),
    slots: [...p.slots].sort(byId).map((s) => [s.id, s.state, s.copyId, s.targetCatalogCardId]),
    binders: [...p.binders]
      .sort(byId)
      .map((b) => [b.id, b.type, b.pages, b.pocketsPerPage, b.backHalfStartPage]),
    collections: [...p.collections].sort(byId).map((c) => [c.id, c.targetCount]),
    typeMap: [...p.typeMap]
      .sort((a, b) => a.cardType.localeCompare(b.cardType))
      .map((t) => [t.cardType, t.band]),
  });
}

/**
 * Read the parts and digest them.
 *
 * Narrow reads only. `copy`, `evolution_line` and `line_slot` need every row for the stamp to be
 * sound, but only a few columns each, so they go through `listAllFields` rather than `listAll` — the
 * copy read is a fifth of the bytes of the one `loadPlanContext` already does, and lines and slots are
 * small tables. Everything else is a handful of config rows or a `head: true` count. Cheap enough to
 * run on every visit to the plan route, which is the whole point: the stamp has to be affordable
 * enough that checking it is never the reason to skip checking it.
 */
export async function loadPlanFingerprint(
  db: DbClient,
  pendingCopyIds: readonly string[],
): Promise<string> {
  const [
    copyRows,
    lineRows,
    slotRows,
    binderRows,
    collectionRows,
    typeMapRows,
    snapshots,
    decisionCount,
  ] = await Promise.all([
    copyRepo.listAllFields(db, ["role", "binder_id", "binder_half", "color_band", "line_slot_id"]),
    evolutionLineRepo.listAllFields(db, ["id", "status", "color_band"]),
    lineSlotRepo.listAllFields(db, ["id", "state", "copy_id", "target_catalog_card_id"]),
    binderRepo.list(db),
    collectionRepo.list(db),
    typeColorMapRepo.list(db),
    lastSyncSnapshotRepo.list(db),
    placementDecisionRepo.count(db),
  ]);

  return planFingerprint({
    copies: copyRows.map((c) => ({
      role: c.role,
      binderId: c.binder_id,
      binderHalf: c.binder_half,
      colorBand: c.color_band,
      lineSlotId: c.line_slot_id,
    })),
    pendingCopyIds,
    snapshotId: snapshots[0]?.id ?? null,
    lines: lineRows.map((l) => ({ id: l.id, status: l.status, colorBand: l.color_band })),
    slots: slotRows.map((s) => ({
      id: s.id,
      state: s.state,
      copyId: s.copy_id,
      targetCatalogCardId: s.target_catalog_card_id,
    })),
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
    decisionCount,
  });
}
