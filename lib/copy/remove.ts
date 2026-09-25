/**
 * "Remove this copy from the app" — one plain action, no reason field (UIL-089).
 *
 * Karvi: "no reason is necessary." A card gets traded, lost, or was never really there; the app's job is
 * to stop claiming she has it, not to interview her about it. So there is no reason field, no "gone" list
 * to curate, and no second screen: one button wherever a copy is shown.
 *
 * NOT in lib/coll, deliberately. `applyCollectionRemoval` means "take this card off this collection's
 * chase list", which is a different action with a different meaning, and this one is not about collections
 * at all. It lives here so neither has to grow a mode flag.
 *
 * THE WHOLE ACTION IS ONE `apply_write_ops` CALL (UIL-014 / UIL-033). Five things have to be true together
 * or none of them: the slot the copy filled is released, the line it completed is no longer complete, the
 * audit row exists, the copy is gone, and — when Dex would otherwise hand it back — the memory of the
 * removal exists. Any split leaves a state nobody designed: a filled slot pointing at nothing, or a copy
 * removed and re-created by the next import.
 *
 * WHAT IT DOES NOT DO, both on the Senior BA's ruling (2026-09-22):
 *   * It does not subtract the collection's chase tag. A chase tag is a WANT — she can chase a card she
 *     does not own, that is the normal state of a chase list — so trading a Pikachu away does not mean she
 *     stopped wanting one. `applyCollectionRemoval` is the action that means that.
 *   * It does not delete history. `placement_decision` rows survive (UIL-042), and this path ADDS one.
 */

import { errorMessage } from "@/lib/errors";
import { releaseSlotOps } from "@/lib/line/move";
import {
  applyWriteOps,
  binderRepo,
  copyRepo,
  evolutionLineRepo,
  lineSlotRepo,
  type DbClient,
  type Row,
  type WriteOp,
  type WritePayload,
} from "@/lib/repo";

/** Everything the op set needs, read once so the builder stays pure and testable. */
export interface RemoveCopyPlan {
  copy: Row<"copy">;
  /** The slot this copy fills, to release. Null when it holds none. */
  reopenSlotId: string | null;
  /** The line to demote to `open`, set only when releasing the slot makes it no longer complete. */
  demoteLineId: string | null;
  /** Where it was, for the audit row — see `removalReason` for why this has to be written down. */
  formerPlacement: string;
  /**
   * The (card, Dex variant) key to remember, or null when nothing would bring this copy back.
   *
   * Set only for a copy an import or a manual match created — one that belongs to a `presence_group` and
   * carries the export's own variant string. A hand-typed copy is in no group, so no import counts it and
   * no import will re-create it; remembering it would suppress a future genuine Dex row for that printing.
   */
  rememberKey: { catalogCardId: string; dexVariantRaw: string } | null;
}

/**
 * The audit row's text, and it carries more than it looks like it should.
 *
 * `placement_decision.copy_id` is `references copy (id) on delete set null` (0002). The insert and the
 * delete are in ONE transaction, so by the time it commits the link is already null: the row survives,
 * exactly as UIL-042 requires, but it no longer says which card it was about. Until that is fixed
 * (UIL-094), this sentence is the only surviving identity, so it names the printing, the variant and where
 * the card was sitting. Not decoration — the history is illegible without it.
 */
export function removalReason(plan: RemoveCopyPlan): string {
  const variant = plan.copy.dex_variant_raw ?? plan.copy.variant;
  return `Removed — ${plan.copy.catalog_card_id} (${variant}), was ${plan.formerPlacement}`;
}

/** Where the copy sat, in the same vocabulary the Line and Lookup rows use. */
export function describeFormerPlacement(
  copy: Row<"copy">,
  binderName: (id: string) => string | undefined,
): string {
  if (copy.role === "haul") return "in the haul, not placed yet";
  if (copy.role === "bulk") return "the bulk box";
  const binder = (copy.binder_id && binderName(copy.binder_id)) || "a binder";
  const half = copy.binder_half === "front" ? "Front" : copy.binder_half === "back" ? "Back" : null;
  const inLine = copy.line_slot_id ? "in a line" : null;
  const where = [binder, half, copy.color_band, inLine].filter(Boolean).join(" · ");
  return copy.role === "block" ? `${binder} · binder block` : where;
}

/**
 * The ordered op set. Release first, then audit, then delete, then remember.
 *
 * The order is not cosmetic: the slot release must precede the delete, because `line_slot.copy_id` is
 * `on delete set null` too. A bare `delete_copy` therefore leaves the slot `state = 'filled'` with a null
 * copy — the exact two-sided contradiction UIL-062 was about, and the shape migration 0018's rule (a) had
 * to be taught to guard against. Releasing it in the same transaction is what keeps that from being
 * possible at all.
 */
/*
 * NO COUNT CHECK HERE, deliberately (UIL-100). A removal takes one copy away AND records one removal
 * against the same key, so copies and max(0, dex − removed) fall together: it can never turn a card that
 * adds up into one that does not. Asserting would therefore only ever fire on a card that ALREADY
 * disagreed with Dex — and refuse the very removal that is her remedy for a double. A merge keeps the
 * count as well (one record out, the survivor in).
 */
export function buildRemoveCopyOps(plan: RemoveCopyPlan): WriteOp[] {
  const ops: WriteOp[] = [
    ...releaseSlotOps(plan.reopenSlotId, plan.demoteLineId),
    {
      op: "insert_decision",
      haul_id: plan.copy.haul_id,
      copy_id: plan.copy.id,
      decision: "copy-removed",
      reason: removalReason(plan),
      resolved_by: "user",
    },
    { op: "delete_copy", id: plan.copy.id },
  ];
  if (plan.rememberKey) {
    ops.push({
      op: "remember_removed_presence",
      catalog_card_id: plan.rememberKey.catalogCardId,
      dex_variant_raw: plan.rememberKey.dexVariantRaw,
      delta: 1,
    });
  }
  return ops;
}

/** Read the plan for one copy. Returns null when the copy is not hers or no longer exists. */
export async function loadRemoveCopyPlan(
  db: DbClient,
  copyId: string,
): Promise<RemoveCopyPlan | null> {
  const copy = await copyRepo.getByPk(db, copyId);
  if (!copy) return null;

  let reopenSlotId: string | null = null;
  let demoteLineId: string | null = null;
  if (copy.line_slot_id) {
    const slot = await lineSlotRepo.getByPk(db, copy.line_slot_id);
    if (slot) {
      reopenSlotId = slot.id;
      // Only a line that WAS complete is demoted: releasing a stage from an already-open line changes
      // nothing about its status, and rewriting it would make the audit trail claim a change that is not
      // one. Same rule the Line-screen move follows.
      const line = await evolutionLineRepo.getByPk(db, slot.line_id);
      if (line?.status === "complete") demoteLineId = line.id;
    }
  }

  const binders = await binderRepo.list(db);
  const nameById = new Map(binders.map((b) => [b.id, b.name]));

  return {
    copy,
    reopenSlotId,
    demoteLineId,
    formerPlacement: describeFormerPlacement(copy, (id) => nameById.get(id)),
    rememberKey:
      copy.presence_group_id && copy.dex_variant_raw
        ? { catalogCardId: copy.catalog_card_id, dexVariantRaw: copy.dex_variant_raw }
        : null,
  };
}

export type RemoveCopyOutcome =
  { ok: true; removedCopyId: string; remembered: boolean } | { ok: false; error: string };

/**
 * Remove one copy. One transaction, and the presence group is resynced inside it.
 *
 * `resync_group_ids` matters even though the memory exists: `presence_group.desired_count` is a
 * materialised LIVE COPY COUNT (0008 onwards, replacing exec.ts's `resyncGroupCount`), so leaving it stale
 * would make the group disagree with its own copies. The memory is a different fact — what Dex still
 * claims that she no longer has.
 */
export async function applyCopyRemoval(db: DbClient, copyId: string): Promise<RemoveCopyOutcome> {
  const plan = await loadRemoveCopyPlan(db, copyId);
  if (!plan) return { ok: false, error: "That card is no longer in your collection." };

  const payload: WritePayload = {
    ops: buildRemoveCopyOps(plan),
    resyncGroupIds: plan.copy.presence_group_id ? [plan.copy.presence_group_id] : [],
  };
  try {
    await applyWriteOps(db, payload);
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
  return { ok: true, removedCopyId: plan.copy.id, remembered: plan.rememberKey !== null };
}

/* --------------------------------- two records, one card --------------------------------- */

/**
 * MERGE two records of the same physical card (UIL-089, the incident's shape).
 *
 * Today's duplicates are one card held twice: a copy she typed by hand and shelved, and the Dex twin the
 * import created, still waiting in the haul. Her model is that each card is a separate underlying object,
 * and these two records are ONE object — so the honest remedy is not "remove one", it is "these are the
 * same card".
 *
 * WHY THIS IS SMALLER THAN REMOVING THE TWIN, which is the surprising part. Remove-the-twin leaves the
 * surviving hand-typed copy in no `presence_group`, and `reconcile` builds `current` from groups — an
 * ungrouped copy is invisible to the diff. So Dex says 1, current says 0, forever, and only the
 * `removed_presence` memory stops every future import re-creating it: permanently load-bearing memory for
 * a card she still owns. Merging puts the survivor IN the group, so desired 1 / current 1 and the import
 * creates nothing. It needs NO memory row, because nothing was lost.
 *
 * The survivor keeps its own placement and adopts the twin's IDENTITY (group, Dex variant string, variant
 * flag). The twin then goes through the ordinary removal path — with `rememberKey` forced to null, which is
 * the whole difference between "this card is gone" and "this record was a duplicate".
 */
export interface MergeCopiesPlan {
  survivor: Row<"copy">;
  twin: RemoveCopyPlan;
}

export function buildMergeCopiesOps(plan: MergeCopiesPlan): WriteOp[] {
  return [
    {
      op: "update_copy",
      id: plan.survivor.id,
      patch: {
        presence_group_id: plan.twin.copy.presence_group_id,
        dex_variant_raw: plan.twin.copy.dex_variant_raw,
        variant: plan.twin.copy.variant,
      },
    },
    // No `rememberKey`: the Dex row is still hers and still accounted for, by the survivor.
    ...buildRemoveCopyOps({ ...plan.twin, rememberKey: null }),
  ];
}

export const MERGE_REFUSALS = {
  missing: "One of those copies is no longer in your collection.",
  same: "Those are the same record.",
  differentCard:
    "Those are two different printings, so they are two different cards. Remove one instead if you do not have it.",
  bothTracked:
    "Both of those came from your Dex export, so Dex says you own two. Fix the count in Dex, or remove one here.",
  neitherTracked:
    "Neither of those came from your Dex export, so there is no identity to merge. Remove one instead.",
} as const;

export type MergeCopiesOutcome =
  { ok: true; survivorCopyId: string; removedCopyId: string } | { ok: false; error: string };

/**
 * Merge the Dex-backed `twinId` into `survivorId`.
 *
 * Refuses rather than guesses in every ambiguous case, because a wrong merge silently destroys a copy she
 * owns: two different printings are two cards (a different art is its own card, system-design §2); two
 * Dex-backed records mean Dex itself claims two, which is a Dex problem and not this action's to overrule;
 * and two hand-typed records have no identity to adopt, so merging them would just be a removal wearing a
 * merge's name.
 */
export async function applyCopyMerge(
  db: DbClient,
  survivorId: string,
  twinId: string,
): Promise<MergeCopiesOutcome> {
  if (survivorId === twinId) return { ok: false, error: MERGE_REFUSALS.same };
  const survivor = await copyRepo.getByPk(db, survivorId);
  const twinPlan = await loadRemoveCopyPlan(db, twinId);
  if (!survivor || !twinPlan) return { ok: false, error: MERGE_REFUSALS.missing };
  if (survivor.catalog_card_id !== twinPlan.copy.catalog_card_id) {
    return { ok: false, error: MERGE_REFUSALS.differentCard };
  }
  if (survivor.presence_group_id && twinPlan.copy.presence_group_id) {
    return { ok: false, error: MERGE_REFUSALS.bothTracked };
  }
  if (!twinPlan.copy.presence_group_id) return { ok: false, error: MERGE_REFUSALS.neitherTracked };

  const payload: WritePayload = {
    ops: buildMergeCopiesOps({ survivor, twin: twinPlan }),
    // The group's live count is unchanged in total — the survivor joins as the twin leaves — but it is
    // resynced anyway, because the count is materialised and this transaction touches both of its members.
    resyncGroupIds: [twinPlan.copy.presence_group_id],
  };
  try {
    await applyWriteOps(db, payload);
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
  return { ok: true, survivorCopyId: survivor.id, removedCopyId: twinPlan.copy.id };
}
