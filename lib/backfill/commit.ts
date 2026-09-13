/**
 * Backfill commit executors (dev-spec §5 M5; system-design §4, §7A).
 *
 * Each executor loads context, builds a pure `BackfillWrites` (see `plan.ts`), turns it into one
 * ordered `WriteOp` list, and applies the whole thing in a single transaction via the
 * `apply_write_ops` RPC (migrations 0006 + 0007).
 *
 * ATOMICITY (M10, the same boundary as lib/plan/commit.ts and lib/sync/exec.ts). This used to write
 * row group by row group through the repos and, on ANY failure, unwind them with a compensating
 * rollback in TS (`class Rollback`). That was never truly atomic: a crash between statements, or a
 * failed compensation, could leave a half-transcribed binder — and the collection tagging did a
 * read-modify-write that could lose a concurrent update. Both are gone. The pure planners are
 * untouched (`plan.ts` / `resolve.ts` still own every decision, including the terminated-line
 * invariant); this file is nothing but ordering.
 *
 * `owner_id` is NEVER forwarded. The planners still stamp it on their rows for their own unit tests,
 * but the ops below omit it so the column defaults to `auth.uid()` under the SECURITY INVOKER
 * function and 0002's `owner_all` RLS `with check` enforces it — identical to the other two paths.
 * `created_at` is likewise left to the DB default (`now()`), which is what a transcription means.
 */

import { applyWriteOps, type DbClient, type WriteOp, type WritePayload } from "@/lib/repo";
import { loadBackfillContext, planDeps } from "./context";
import { planBackLine, planFrontHalf, planSpecialty } from "./plan";
import {
  countWrites,
  type BackfillWrites,
  type BackLineCommit,
  type CommitCounts,
  type FrontHalfCommit,
  type SpecialtyCommit,
} from "./types";

/**
 * Turn a planned write set into ONE ordered op list (PURE — no I/O).
 *
 * The order is the FK-safe order the previous per-row writes used, and the RPC applies it verbatim:
 * lines → copies → slots → the deferred `copy.line_slot_id` patch → blocks → wishlist → decisions →
 * collection tags. `copy.line_slot_id` is deferred because copy ↔ line_slot is a circular FK: the
 * copy goes in with NULL and is patched once its slot exists. Blocks come after copies because a
 * repurposed-duplicate block references the sacrificed copy.
 */
export function buildBackfillPayload(writes: BackfillWrites): WritePayload {
  const ops: WriteOp[] = [];

  for (const l of writes.lines) {
    ops.push({
      op: "insert_line",
      id: l.id!,
      root_dex_id: l.root_dex_id,
      color_band: l.color_band,
      binder_id: l.binder_id ?? null,
      half: l.half ?? "back",
      status: l.status ?? "open",
    });
  }

  for (const c of writes.copies) {
    ops.push({
      op: "insert_copy",
      id: c.id!,
      catalog_card_id: c.catalog_card_id,
      variant: c.variant ?? "normal",
      haul_id: c.haul_id ?? null,
      acquired_at: c.acquired_at ?? null,
      role: c.role ?? "shelved",
      binder_id: c.binder_id ?? null,
      binder_half: c.binder_half ?? null,
      color_band: c.color_band ?? null,
      line_slot_id: null, // deferred — patched below once the slot rows exist (circular FK)
    });
  }

  for (const s of writes.slots) {
    ops.push({
      op: "insert_slot",
      id: s.id!,
      line_id: s.line_id,
      stage_index: s.stage_index,
      stage: s.stage,
      state: s.state,
      copy_id: s.copy_id ?? null,
      target_catalog_card_id: s.target_catalog_card_id ?? null,
      note: s.note ?? null,
    });
  }

  for (const link of writes.copyLineSlotLinks) {
    ops.push({ op: "update_copy", id: link.copyId, patch: { line_slot_id: link.slotId } });
  }

  for (const b of writes.blocks) {
    ops.push({
      op: "insert_binder_block",
      id: b.id!,
      binder_id: b.binder_id,
      half: b.half,
      pocket_count: b.pocket_count ?? 1,
      purpose: b.purpose,
      material: b.material,
      copy_id: b.copy_id ?? null,
      line_id: b.line_id ?? null,
    });
  }

  for (const wl of writes.wishlist) {
    ops.push({
      op: "insert_wishlist",
      id: wl.id!,
      line_slot_id: wl.line_slot_id ?? null,
      required_dex_id: wl.required_dex_id ?? null,
      required_type: wl.required_type ?? null,
      required_stage: wl.required_stage ?? null,
      chosen_catalog_card_id: wl.chosen_catalog_card_id ?? null,
      alternate_catalog_card_ids: wl.alternate_catalog_card_ids ?? [],
      will_live_in_specialty: wl.will_live_in_specialty ?? false,
      held_for_binder_id: wl.held_for_binder_id ?? null,
    });
  }

  for (const d of writes.decisions) {
    ops.push({
      op: "insert_decision",
      id: d.id!,
      haul_id: d.haul_id ?? null,
      copy_id: d.copy_id ?? null,
      decision: d.decision,
      reason: d.reason,
      resolved_by: d.resolved_by,
    });
  }

  // Collection tagging — one op per collection, unioned server-side (0007). Grouping per collection
  // keeps it to a single statement each and makes the union idempotent within the batch too.
  const idsByCollection = new Map<string, string[]>();
  for (const t of writes.collectionTags) {
    const list = idsByCollection.get(t.collectionId);
    if (list) list.push(t.catalogCardId);
    else idsByCollection.set(t.collectionId, [t.catalogCardId]);
  }
  for (const [collectionId, catalogCardIds] of idsByCollection) {
    ops.push({
      op: "union_collection_targets",
      collection_id: collectionId,
      catalog_card_ids: catalogCardIds,
    });
  }

  return { ops };
}

/** Apply a planned write set in ONE transaction. Returns the per-table counts for the summary. */
export async function applyWrites(db: DbClient, writes: BackfillWrites): Promise<CommitCounts> {
  await applyWriteOps(db, buildBackfillPayload(writes));
  return countWrites(writes);
}

/** Commit a front-half flat entry. */
export async function commitFrontHalf(
  db: DbClient,
  ownerId: string,
  input: FrontHalfCommit,
): Promise<CommitCounts> {
  const ctx = await loadBackfillContext(db);
  return applyWrites(db, planFrontHalf(input, planDeps(ctx, ownerId)));
}

/** Commit a back-half line entry. */
export async function commitBackLine(
  db: DbClient,
  ownerId: string,
  input: BackLineCommit,
): Promise<CommitCounts> {
  const ctx = await loadBackfillContext(db);
  return applyWrites(db, planBackLine(input, planDeps(ctx, ownerId)));
}

/** Commit a specialty flat entry (with collection tags). */
export async function commitSpecialty(
  db: DbClient,
  ownerId: string,
  input: SpecialtyCommit,
): Promise<CommitCounts> {
  const ctx = await loadBackfillContext(db);
  return applyWrites(db, planSpecialty(input, planDeps(ctx, ownerId)));
}
