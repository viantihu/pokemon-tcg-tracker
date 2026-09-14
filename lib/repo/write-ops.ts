/**
 * The atomic write-orchestration boundary (dev-spec §5 M10; migrations 0006_commit_rpc.sql +
 * 0007_backfill_ops.sql + 0008_collection_removal_ops.sql).
 *
 * All THREE commit paths (lib/plan/commit.ts haul, lib/sync/exec.ts sync, lib/backfill/commit.ts
 * backfill) — plus the collection-removal path (lib/coll/remove.ts, UIL-014) — keep ALL the pure
 * cascade / reconcile / decision logic in TS and compute a
 * fully-resolved, ORDERED write set — generating row UUIDs client-side (crypto.randomUUID) so
 * line→slot→copy cross-references resolve before insert — then hand it here. `applyWriteOps` posts
 * the whole set to the `apply_write_ops` Postgres function, which runs every op inside one implicit
 * transaction: it all commits, or it all rolls back. This replaces the interim
 * compensating-rollback that lived in those three files.
 *
 * `owner_id` is NEVER carried in a payload: every insert omits it so the column defaults to
 * `auth.uid()` under the SECURITY INVOKER function and the 0002 `owner_all` RLS `with check` enforces
 * it — identical to how the repo layer writes today. The op order is applied verbatim, so callers
 * must emit ops in an FK-safe sequence (the same sequence the old dependency-ordered writes used).
 */
import type { DbClient } from "./base";
import type { Json } from "./database.types";

/** An update patch: keys PRESENT are written (even when null); keys ABSENT are left unchanged. */
export interface CopyPatch {
  variant?: string;
  dex_variant_raw?: string | null;
  presence_group_id?: string | null;
  role?: string;
  binder_id?: string | null;
  binder_half?: string | null;
  color_band?: string | null;
  line_slot_id?: string | null;
}

export interface SlotPatch {
  state?: string;
  copy_id?: string | null;
  target_catalog_card_id?: string | null;
  note?: string | null;
}

/** An evolution-line patch (0008). Only `status` is expressible — nothing else needs patching. */
export interface LinePatch {
  status?: string;
}

export interface EntryPatch {
  status?: string;
  quantity?: number;
  retry_count?: number;
  last_retry_sync?: string | null;
  reason?: string;
  manual_match_id?: string | null;
}

/**
 * One typed write. Every variant maps 1:1 to a branch of `apply_write_ops`'s `case` — there is no
 * dynamic SQL. Inserts carry an explicit `id` (client-generated) so later ops can reference it.
 */
export type WriteOp =
  | { op: "insert_haul"; id: string; source: string; notes: string | null }
  | {
      op: "insert_copy";
      id: string;
      catalog_card_id: string;
      variant?: string;
      dex_variant_raw?: string | null;
      presence_group_id?: string | null;
      haul_id?: string | null;
      acquired_at?: string | null;
      role?: string;
      binder_id?: string | null;
      binder_half?: string | null;
      color_band?: string | null;
      line_slot_id?: string | null;
      created_at?: string;
    }
  | {
      op: "insert_line";
      id: string;
      root_dex_id: number;
      color_band: string;
      binder_id: string | null;
      half?: string;
      status?: string;
    }
  | {
      op: "insert_slot";
      id: string;
      line_id: string;
      stage_index: number;
      stage: string;
      state: string;
      copy_id: string | null;
      target_catalog_card_id: string | null;
      note: string | null;
    }
  | {
      op: "insert_wishlist";
      /** Optional: the RPC defaults it to `gen_random_uuid()`. Backfill supplies its planner's id. */
      id?: string;
      line_slot_id: string | null;
      required_dex_id: number | null;
      required_type: string | null;
      required_stage: string | null;
      chosen_catalog_card_id: string | null;
      alternate_catalog_card_ids: string[];
      will_live_in_specialty: boolean;
      held_for_binder_id: string | null;
    }
  | {
      op: "insert_decision";
      /** Optional: the RPC defaults it to `gen_random_uuid()`. Backfill supplies its planner's id. */
      id?: string;
      haul_id: string | null;
      copy_id: string | null;
      decision: string;
      reason: string;
      resolved_by: string;
    }
  /** M5 backfill only — a reserved pocket run (0007). `copy_id` is set iff a duplicate was sacrificed. */
  | {
      op: "insert_binder_block";
      id: string;
      binder_id: string;
      half: string;
      pocket_count: number;
      purpose: string;
      material: string;
      copy_id: string | null;
      line_id: string | null;
    }
  | {
      op: "insert_presence_group";
      id: string;
      catalog_card_id: string;
      dex_variant_raw: string;
      desired_count?: number;
    }
  | {
      op: "insert_unresolved_entry";
      id: string;
      dex_id: string;
      dex_set_name: string | null;
      dex_series: string | null;
      dex_number: string | null;
      dex_name: string | null;
      dex_variant_raw: string;
      quantity: number;
      locale: string | null;
      reason: string;
      status?: string;
      first_seen_sync?: string;
      last_retry_sync?: string | null;
      retry_count?: number;
      manual_match_id?: string | null;
    }
  | { op: "insert_snapshot"; id: string; snapshot: Json }
  | {
      op: "upsert_set_alias";
      locale: string;
      dex_code: string;
      tcgdex_set_id: string;
      source?: string;
    }
  | { op: "update_copy"; id: string; patch: CopyPatch }
  | { op: "update_slot"; id: string; patch: SlotPatch }
  /**
   * Patch a line's status (0008). The removal/move path demotes a `complete` line back to `open` when
   * the copy filling its last slot leaves (removal symmetry, sync-arch §1.6) — inside the same
   * transaction as the placement rewrite, which 0006/0007 could not express.
   */
  | { op: "update_line"; id: string; patch: LinePatch }
  | { op: "update_unresolved_entry"; id: string; patch: EntryPatch }
  /**
   * Union catalog ids into `collection.target_catalog_card_ids` (0007). The union happens SERVER-SIDE
   * in one statement, so it is atomic AND free of the lost update a read-modify-write would have:
   * two interleaved taggings compose. Idempotent — re-tagging the same card changes nothing.
   */
  | { op: "union_collection_targets"; collection_id: string; catalog_card_ids: string[] }
  /**
   * The inverse (0008): drop catalog ids OUT of `collection.target_catalog_card_ids`. Same
   * single-statement, column-derived shape as the union, so it is atomic, order-preserving, free of
   * the lost update a read-modify-write would have, and idempotent. Removal from a collection is a
   * MOVE plus this list edit; the two must land in one transaction or the copy is orphaned (UIL-014).
   */
  | { op: "subtract_collection_targets"; collection_id: string; catalog_card_ids: string[] }
  | { op: "delete_copy"; id: string }
  | { op: "delete_unresolved_entry"; id: string }
  | { op: "delete_snapshot"; id: string };

/** The full atomic write set for one commit. `ops` apply in order; groups resync last. */
export interface WritePayload {
  ops: WriteOp[];
  /** Presence groups whose `desired_count` is recomputed (post-apply live copy count). */
  resyncGroupIds?: string[];
}

/**
 * Apply a write set atomically via the `apply_write_ops` RPC. Throws on any DB error — the whole set
 * has already rolled back server-side, so the caller never has to compensate.
 */
export async function applyWriteOps(db: DbClient, payload: WritePayload): Promise<void> {
  const body = {
    ops: payload.ops,
    resync_group_ids: payload.resyncGroupIds ?? [],
  };
  const { error } = await db.rpc("apply_write_ops", { payload: body as unknown as Json });
  if (error) throw error;
}
