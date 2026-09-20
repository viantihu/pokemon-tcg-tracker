/**
 * Move a collection to a different specialty binder WITH the cards already shelved in the old one
 * (UIL-040 step 2) — the remedy to step 1's refusal, as ONE confirmed, atomic action.
 *
 * WHY THIS EXISTS. Step 1 (#102) made `applyCollectionSave` REFUSE a rebind that would strand shelved
 * copies: membership is derived at read time from a shelved `copy` in one of `current_binder_ids` whose
 * catalog id is on `target_catalog_card_ids`, so re-pointing the collection alone leaves every such copy
 * occupying a real pocket while reading as un-owned everywhere (the UIL-014 / UIL-022 orphan class, a
 * fourth site). The refusal named the cards and ended with "move them out individually first". Step 2 is
 * the remedy on the same screen: carry those copies into the new binder AND re-point the collection.
 *
 * Those two writes MUST land together. Copies moved but the collection still on the old binder, or the
 * collection re-pointed but the copies still in the old binder — both are the orphan step 1 refuses. So
 * the whole thing goes through `apply_write_ops` as ONE transaction; migration 0017 added the
 * `set_collection_binders` op it needed, because `current_binder_ids` was only ever written by a bare
 * PostgREST update outside the RPC before.
 *
 * WHICH COPIES MOVE, AND WHICH STAY. Every shelved copy of a target card sitting in a binder the
 * collection is leaving — all copies of a card, duplicates included (the same "ALL copies" rule as
 * `applyCollectionRemoval`; leaving one behind is the orphan). EXCEPT a card that ANOTHER collection
 * still in the old binder also chases: moving its copy would make that other collection read it as
 * missing, leaving it makes this one read it as missing, and neither strands it (it stays tracked by the
 * other list + binder pair). It STAYS — least surprise for the collection she is not editing — and the
 * remedy names it as staying so nothing is silent. Senior BA's call 2026-09-20, flagged to Karvi as a
 * default rather than a blocker.
 *
 * NEVER a delete. No copy is deleted and no `placement_decision` row is deleted (UIL-042: the decision
 * table is queue state); one decision is INSERTED per moved copy, `resolved_by: 'user'`. Copies in a
 * specialty binder carry `line_slot_id: null` by construction (`placementForMove`'s collection branch),
 * so no slot work is expected — but it is re-derived from fresh state exactly as the removal path does,
 * so a copy that defensively holds a slot reopens it and demotes a `complete` line, in the same
 * transaction.
 *
 * Everything is re-derived server-side from FRESH state at click time. The client sends the collection
 * and the destination binder; which copies move, which stay, which slots they hold are never trusted
 * from the browser (the rule `applyCollectionRemoval` and `applyDecision` already follow).
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
import { placementForMove } from "@/lib/line/move";

/* ------------------------------- pure planning ------------------------------ */

/** One physical copy moving with the collection, plus the line bookkeeping its departure implies. */
export interface RebindCopy {
  id: string;
  /** The line slot this copy fills, which the move vacates. Null when it fills none (the norm here). */
  reopenSlotId: string | null;
  /** The `complete` line to demote back to `open` because that slot is no longer filled. */
  demoteLineId: string | null;
}

/** A fully-resolved rebind: every id read from fresh state, ready to become ops. */
export interface CollectionRebindPlan {
  collectionId: string;
  collectionName: string;
  /** The binder(s) the collection is leaving, by display name — for the audit reason. */
  fromBinderNames: string[];
  toBinderId: string;
  toBinderName: string;
  /** Every shelved copy moving with the collection. May be empty (everything stayed, see above). */
  copies: RebindCopy[];
  /** Cards left in the old binder because another collection there still chases them. Audit only. */
  stayingNames: string[];
}

/** The `PlacementDecision.reason` for a rebind move (always `resolved_by: 'user'`; dev-spec §4). */
export function rebindDecisionReason(plan: {
  collectionName: string;
  fromBinderNames: string[];
  toBinderName: string;
  hasCopy: boolean;
  stayingNames: string[];
}): string {
  const from = plan.fromBinderNames.join(", ") || "its binder";
  if (!plan.hasCopy) {
    const stay =
      plan.stayingNames.length > 0
        ? ` ${plan.stayingNames.join(", ")} stayed in ${from}, chased by another collection there.`
        : "";
    return (
      `Rebound ${plan.collectionName} from ${from} to ${plan.toBinderName} (list only): no copy ` +
      `moved with it.${stay}`
    );
  }
  return (
    `Moved with ${plan.collectionName} from ${from} to ${plan.toBinderName} — your call, no rule ` +
    `applied: the collection changed binder and this copy went with it.`
  );
}

/**
 * The complete ordered write set for one rebind. Applied verbatim inside one transaction, so the order
 * only has to be FK-safe and read-consistent: placements first (mirroring `applyMove` and the removal
 * path), then the vacated slots, then the demoted lines, then the collection's binder list, then the
 * audit rows. `set_collection_binders` sits AFTER the copies deliberately — if the RPC ever raised
 * mid-batch the rollback covers all of it either way, but reading top to bottom this is "the cards
 * moved, then the collection followed them", which is what the audit rows say too.
 */
export function buildCollectionRebindOps(plan: CollectionRebindPlan): WriteOp[] {
  const patch = placementForMove({
    kind: "collection",
    binderId: plan.toBinderId,
    collectionId: plan.collectionId,
  });
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
  for (const copy of plan.copies) {
    if (copy.reopenSlotId) {
      ops.push({
        op: "update_slot",
        id: copy.reopenSlotId,
        patch: { state: "placeholder", copy_id: null },
      });
    }
  }
  for (const copy of plan.copies) {
    if (copy.demoteLineId) {
      ops.push({ op: "update_line", id: copy.demoteLineId, patch: { status: "open" } });
    }
  }

  ops.push({
    op: "set_collection_binders",
    collection_id: plan.collectionId,
    binder_ids: [plan.toBinderId],
  });

  const reason = rebindDecisionReason({
    collectionName: plan.collectionName,
    fromBinderNames: plan.fromBinderNames,
    toBinderName: plan.toBinderName,
    hasCopy: plan.copies.length > 0,
    stayingNames: plan.stayingNames,
  });
  if (plan.copies.length === 0) {
    ops.push({
      op: "insert_decision",
      haul_id: null,
      copy_id: null,
      decision: "collection-rebind",
      reason,
      resolved_by: "user",
    });
  } else {
    for (const copy of plan.copies) {
      ops.push({
        op: "insert_decision",
        haul_id: null,
        copy_id: copy.id,
        decision: "collection-rebind",
        reason,
        resolved_by: "user",
      });
    }
  }
  return ops;
}

/* ------------------------ the remedy the refusal carries ----------------------- */

/** A target card whose copies MOVE with the collection when she confirms. */
export interface RebindMovingCard {
  tcgdexId: string;
  name: string;
  copyCount: number;
}

/** A target card that STAYS in the old binder, because another collection there still chases it. */
export interface RebindStayingCard {
  tcgdexId: string;
  name: string;
  copyCount: number;
  /** The other collection(s) — named, so "stays" is explained rather than asserted. */
  alsoChasedBy: string[];
}

/**
 * What "move them and rebind" would do, shaped for the refusal bar. Serializable (crosses the server
 * action boundary inside `SaveCollectionResult`), display-ready (names, not ids, except the two ids the
 * confirming click has to send back), and computed from the same fresh read the write will repeat.
 */
export interface RebindRemedy {
  kind: "rebind-move";
  collectionId: string;
  toBinderId: string;
  toBinderName: string;
  fromBinderNames: string[];
  /** Copies that will move — the number on the button. */
  copyCount: number;
  cards: RebindMovingCard[];
  staying: RebindStayingCard[];
}

interface RebindPartition {
  removedBinderIds: string[];
  fromBinderNames: string[];
  toBinderName: string;
  /** Target id → its shelved copies in the leaving binder(s), for cards that MOVE. */
  moving: Map<string, Row<"copy">[]>;
  /** Target id → its copies + the other collections that keep it, for cards that STAY. */
  staying: Map<string, { rows: Row<"copy">[]; alsoChasedBy: string[] }>;
  nameById: Map<string, string>;
}

/**
 * The one read both the remedy and the write share, so the bar and the transaction cannot disagree
 * about which cards move. Returns null when the destination binder does not exist.
 */
async function partitionRebind(
  db: DbClient,
  col: Row<"collection">,
  toBinderId: string,
): Promise<RebindPartition | null> {
  const binders = await binderRepo.list(db);
  const toBinder = binders.find((b) => b.id === toBinderId);
  if (!toBinder) return null;
  const binderNameById = new Map(binders.map((b) => [b.id, b.name]));

  const removedBinderIds = (col.current_binder_ids ?? []).filter((id) => id !== toBinderId);
  const targetIds = col.target_catalog_card_ids ?? [];

  // The other collections still living in a binder this one is leaving — their chase lists decide
  // which cards stay behind.
  const others = (await collectionRepo.list(db)).filter(
    (c) =>
      c.id !== col.id && (c.current_binder_ids ?? []).some((b) => removedBinderIds.includes(b)),
  );

  const moving = new Map<string, Row<"copy">[]>();
  const staying = new Map<string, { rows: Row<"copy">[]; alsoChasedBy: string[] }>();
  if (removedBinderIds.length > 0) {
    for (const id of targetIds) {
      const rows = (await copyRepo.listByCatalogCard(db, id)).filter(
        (c) =>
          c.role === "shelved" && c.binder_id !== null && removedBinderIds.includes(c.binder_id),
      );
      if (rows.length === 0) continue;
      const alsoChasedBy = others
        .filter((o) => (o.target_catalog_card_ids ?? []).includes(id))
        .map((o) => o.name);
      if (alsoChasedBy.length > 0) staying.set(id, { rows, alsoChasedBy });
      else moving.set(id, rows);
    }
  }

  const involved = [...moving.keys(), ...staying.keys()];
  const cards = involved.length > 0 ? await catalogCardRepo.listByIds(db, involved) : [];
  const nameById = new Map(cards.map((c) => [c.tcgdex_id, c.name]));

  return {
    removedBinderIds,
    fromBinderNames: removedBinderIds.map((id) => binderNameById.get(id) ?? "its binder"),
    toBinderName: toBinder.name,
    moving,
    staying,
    nameById,
  };
}

/**
 * The remedy for a refused rebind, or null when there is nothing to offer: the destination binder is
 * gone, the collection is not actually leaving a binder, or no shelved copy of a target card sits in the
 * binder(s) it is leaving (in which case the guard would not have fired).
 */
export async function rebindRemedyFor(
  db: DbClient,
  col: Row<"collection">,
  toBinderId: string,
): Promise<RebindRemedy | null> {
  const part = await partitionRebind(db, col, toBinderId);
  if (!part || part.removedBinderIds.length === 0) return null;
  if (part.moving.size === 0 && part.staying.size === 0) return null;

  const cards: RebindMovingCard[] = [...part.moving.entries()].map(([tcgdexId, rows]) => ({
    tcgdexId,
    name: part.nameById.get(tcgdexId) ?? tcgdexId,
    copyCount: rows.length,
  }));
  const staying: RebindStayingCard[] = [...part.staying.entries()].map(([tcgdexId, s]) => ({
    tcgdexId,
    name: part.nameById.get(tcgdexId) ?? tcgdexId,
    copyCount: s.rows.length,
    alsoChasedBy: s.alsoChasedBy,
  }));
  return {
    kind: "rebind-move",
    collectionId: col.id,
    toBinderId,
    toBinderName: part.toBinderName,
    fromBinderNames: part.fromBinderNames,
    copyCount: cards.reduce((n, c) => n + c.copyCount, 0),
    cards,
    staying,
  };
}

/* ----------------------------------- I/O ----------------------------------- */

export interface CollectionRebindRequest {
  collectionId: string;
  toBinderId: string;
}

export interface CollectionRebindResult {
  collectionName: string;
  toBinderName: string;
  movedCopyIds: string[];
  /** Cards left in the old binder, by name, with the collection(s) that keep them. */
  staying: RebindStayingCard[];
}

/**
 * Move a collection and its shelved copies to another binder, atomically.
 *
 * Refuses (throws, nothing written) when the collection or the destination binder no longer exists, or
 * when the collection already lives in that binder — the remedy button is only ever offered on a live
 * refusal, so each of these means the screen is stale.
 */
export async function applyCollectionRebindMove(
  db: DbClient,
  req: CollectionRebindRequest,
): Promise<CollectionRebindResult> {
  const col = await collectionRepo.getByPk(db, req.collectionId);
  if (!col) throw new Error("That collection no longer exists.");

  const part = await partitionRebind(db, col, req.toBinderId);
  if (!part) throw new Error("That binder no longer exists — reload and pick again.");
  if (part.removedBinderIds.length === 0) {
    throw new Error("This collection is already in that binder — reload the screen.");
  }

  const copies: RebindCopy[] = [];
  for (const rows of part.moving.values()) {
    for (const c of rows) {
      let reopenSlotId: string | null = null;
      let demoteLineId: string | null = null;
      if (c.line_slot_id) {
        // By primary key, never by scanning (the removal path's own reason: a full-table list is
        // capped at the server's max-rows).
        const slot = await lineSlotRepo.getByPk(db, c.line_slot_id);
        if (slot && slot.copy_id === c.id) {
          reopenSlotId = slot.id;
          const line = await evolutionLineRepo.getByPk(db, slot.line_id);
          if (line && line.status === "complete") demoteLineId = line.id;
        }
      }
      copies.push({ id: c.id, reopenSlotId, demoteLineId });
    }
  }

  const staying: RebindStayingCard[] = [...part.staying.entries()].map(([tcgdexId, s]) => ({
    tcgdexId,
    name: part.nameById.get(tcgdexId) ?? tcgdexId,
    copyCount: s.rows.length,
    alsoChasedBy: s.alsoChasedBy,
  }));

  const ops = buildCollectionRebindOps({
    collectionId: col.id,
    collectionName: col.name,
    fromBinderNames: part.fromBinderNames,
    toBinderId: req.toBinderId,
    toBinderName: part.toBinderName,
    copies,
    stayingNames: staying.map((s) => s.name),
  });

  await applyWriteOps(db, { ops });

  return {
    collectionName: col.name,
    toBinderName: part.toBinderName,
    movedCopyIds: copies.map((c) => c.id),
    staying,
  };
}
