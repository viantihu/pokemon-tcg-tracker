/**
 * The atomic write-orchestration boundary (dev-spec §5 M10; migrations 0006_commit_rpc.sql +
 * 0007_backfill_ops.sql + 0008_collection_removal_ops.sql + 0014_forget_set_alias.sql).
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
  /** 0036 (UIL-130): the box she picked. Absent: the copy keeps its box, or a bulk copy gets her default box. */
  bulk_unit_id?: string | null;
}

export interface SlotPatch {
  state?: string;
  copy_id?: string | null;
  target_catalog_card_id?: string | null;
  note?: string | null;
  /**
   * UIL-078's "she already answered this" marker (0013). `releaseSlotOps` nulls all three when a slot
   * is vacated, inside the same transaction as the placement rewrite; `applyDecision` sets them
   * through the repo layer rather than here.
   */
  resolved_decision_kind?: string | null;
  resolved_decision_choice?: string | null;
  resolved_decision_collection_id?: string | null;
  /** Her choice for an unfilled stage (0030, UIL-121): chase a card, leave it empty, or a filler pocket; null = undecided. */
  stage_choice?: "chase" | "empty" | "filler" | null;
}

/** An evolution-line patch (0008; `extra_pocket` since 0030). */
export interface LinePatch {
  status?: string;
  /** What fills a short complete line's third pocket (0030, UIL-121); null = not decided. */
  extra_pocket?: "energy" | "card" | "empty" | null;
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
/** One (card, Dex variant) key, as the count check names it. */
export interface PresenceKeyRef {
  catalog_card_id: string;
  dex_variant_raw: string;
}

/** One row of the Dex record (UIL-100): Dex's raw quantity for a key, before removals. */
export interface DexRecordRow extends PresenceKeyRef {
  quantity: number;
}

export type WriteOp =
  | { op: "insert_haul"; id: string; source: string; notes: string | null }
  | {
      op: "insert_copy";
      id: string;
      catalog_card_id: string;
      variant?: string;
      dex_variant_raw?: string | null;
      /** REQUIRED since 0023 (UIL-098 part 4): an ungrouped copy is invisible to the next import. */
      presence_group_id: string;
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
      /**
       * Traceability only (0013, UIL-078) — nothing reads these back to decide behaviour. Carried by the op
       * since 0021 so `applyDecision` could move inside the transaction WITHOUT dropping them (UIL-095);
       * absent reads as NULL, so every earlier caller is unchanged.
       */
      line_id?: string | null;
      line_slot_id?: string | null;
    }
  /**
   * A block: a reserved pocket (0007). `copy_id` is set iff a card fills it. Since 0030 (UIL-121) `line_slot_id` names
   * the ONE stage pocket it fills (her "filler" choice); absent, it is line-level (a short line's third pocket, or a
   * pre-0030 run).
   */
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
      line_slot_id?: string | null;
    }
  /** Take a block out (0030, UIL-121): she changed what fills a pocket. Owner- and id-scoped, as the signed-in owner. */
  | { op: "delete_binder_block"; id: string; line_id: string }
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
  /**
   * Delete a line that holds no card, with its slots and their wishes (0029, UIL-118). The RPC refuses it whole
   * while a slot is filled, a copy points at a slot, or a binder block sits on the line.
   */
  | { op: "delete_line"; line_id: string }
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
  /**
   * SET `collection.current_binder_ids` (0017, UIL-040 step 2). Emitted by lib/coll/rebind.ts AFTER the
   * `update_copy` ops that carry the collection's shelved copies into the new binder, so the copies and
   * the collection change binder in ONE transaction — two statements in either order leave a window in
   * which they disagree, and that disagreement is the orphan step 1 (#102) refuses. A collection id that
   * matches no row (or is not the caller's, per RLS) is a silent no-op like the two target-list ops.
   */
  | { op: "set_collection_binders"; collection_id: string; binder_ids: string[] }
  | { op: "delete_copy"; id: string }
  | { op: "delete_unresolved_entry"; id: string }
  | { op: "delete_snapshot"; id: string }
  /**
   * Remember that she removed a Dex-backed copy (0020, UIL-089), so the rest of this haul (a Retry, a manual
   * match, the Count check) does not hand the card back; the next full import forgets it (UIL-111). Emitted
   * in the SAME transaction as the `delete_copy` it describes, and by Undo to restore memories an import
   * forgot.
   *
   * `delta` is added to the stored count SERVER-SIDE, computed from the column — never read-modify-written
   * here, or two removals of the same printing racing each other would lose one (0007's own lesson from
   * `union_collection_targets`). Keyed like `presence_group`, which is the key `diff()` reconciles on.
   */
  | {
      op: "remember_removed_presence";
      catalog_card_id: string;
      dex_variant_raw: string;
      delta: number;
    }
  /**
   * Forget that memory (0020, UIL-089): every one of them, on the next FULL import, which ends the haul
   * (UIL-111). A key that matches no row is a silent no-op, like `delete_copy`.
   */
  | { op: "forget_removed_presence"; catalog_card_id: string; dex_variant_raw: string }
  /**
   * Mark a slot's OPEN wishlist row resolved (0021, UIL-095). Keyed on the slot, not on a wishlist row id:
   * finding the row first is what made `applyDecision` read the whole table before deciding what to write.
   * A slot with no open row is a silent no-op, and a second run matches nothing, so it is idempotent.
   */
  | { op: "resolve_wishlist_for_slot"; line_slot_id: string }
  /**
   * Create or refresh a slot's OPEN wishlist row (0021, UIL-095). One statement, conflicting on 0021's
   * partial unique index `(owner_id, line_slot_id) where resolved_at is null`, so "update the open row, else
   * insert" is decided by the row Postgres locks rather than by an earlier read. A RESOLVED row does not
   * participate in the conflict, so it is never resurrected — a new open row is inserted beside it.
   */
  | {
      op: "upsert_wishlist_for_slot";
      line_slot_id: string;
      required_dex_id: number | null;
      required_type: string | null;
      required_stage: string | null;
      chosen_catalog_card_id: string | null;
      alternate_catalog_card_ids: string[];
      will_live_in_specialty: boolean;
      held_for_binder_id: string | null;
    }
  /**
   * Forget a learned set alias (0014, UIL-047 C3). Keyed on `set_alias`'s primary key; a key that
   * matches no row is a silent no-op like `delete_copy`. Emitted together with the re-classification of
   * that set's WAITING entries (lib/sync/alias.ts) so the two land in one transaction.
   */
  | { op: "delete_set_alias"; locale: string; dex_code: string }
  /**
   * 0033 (UIL-127b): her rainbow order, written whole. `bands` must name every configured band exactly once, or the
   * database refuses the write before any row changes.
   */
  | { op: "set_band_order"; bands: string[] }
  /** 0033 (UIL-127b): one type's band in her map. Her map starts as a copy of the defaults, so it is always whole. */
  | { op: "set_type_band"; card_type: string; band: string }
  /** 0036 (UIL-130): her bulk boxes. Her first box is her default; `capacity` null = untracked (never full). */
  | {
      op: "insert_bulk_unit";
      id: string;
      name: string;
      capacity: number | null;
      sort_order?: number;
    }
  | {
      op: "update_bulk_unit";
      id: string;
      patch: { name?: string; capacity?: number | null; sort_order?: number };
    }
  /** Her default box, swapped in one op (she always has exactly one). */
  | { op: "set_default_bulk_unit"; id: string }
  /**
   * A box goes only with somewhere for its cards to go: `move_to`, another of her boxes, checked before anything
   * moves (never her last box; never into a box with a limit that cannot take them all).
   */
  | { op: "delete_bulk_unit"; id: string; move_to: string }
  /**
   * 0033: the database's backstop for UIL-127a. Refuses when a named copy is shelved or a block with no binder.
   * Appended by `applyWriteOps` naming ONLY the copies whose binder the payload SETS (see `withCopyBinderCheck`).
   */
  | { op: "assert_copy_binders"; copy_ids: string[] }
  /**
   * UIL-100 (migration 0022): what the Dex file said, kept so every sync write can be checked against it.
   * A full import REPLACES the record (raw Dex quantities, before removals) and its file-level header;
   * a Retry promotion or a manual match ADDS the row it resolves; Undo of the first recorded import CLEARS
   * it. `assert_presence_counts` is the check itself — emitted LAST by every sync writer, it rolls the
   * whole transaction back unless each key holds max(0, dex − removed) copies. No header yet: it passes.
   */
  | {
      op: "replace_dex_record";
      rows: DexRecordRow[];
      file_total: number;
      row_count: number;
      imported_at?: string;
    }
  | { op: "clear_dex_record" }
  | { op: "add_dex_presence"; catalog_card_id: string; dex_variant_raw: string; quantity: number }
  /** Take `by` off a removal memory, deleting it at zero (0022). A key with no memory is a no-op. */
  | { op: "shrink_removed_presence"; catalog_card_id: string; dex_variant_raw: string; by: number }
  | { op: "assert_presence_counts"; keys?: PresenceKeyRef[]; all?: boolean }
  /**
   * THE FILE TOTAL (0024): the record plus the queue must still add up to the file. Emitted last by the
   * writers that add to the record (manual match, stand-in, Retry). No header yet: it passes.
   */
  | { op: "assert_file_total" }
  /**
   * UIL-087's slot invariant at the database (0028): every named slot, every slot a named copy points at or is
   * named by, and every `filled` slot with no copy must hold together (a filled slot names exactly one shelved
   * copy that points back, in the line's binder, back half; an unfilled slot has no copy pointing at it), and a
   * named or checked slot's line reads `complete` only when every one of its slots is filled.
   * `applyWriteOps` appends it last to every payload that touches a copy or a slot — callers never emit it.
   */
  | { op: "assert_line_slots"; slot_ids: string[]; copy_ids: string[]; line_ids: string[] }
  /**
   * A user-created STAND-IN catalog card (0015, UIL-060 Half 1): a row of her own for a card TCGdex
   * lacks, in the `user:` id namespace with `source = 'user'`. Emitted FIRST by lib/sync/exec.ts
   * `manualMatchStandIn`, in the same transaction as the match that points at it, so a stand-in never
   * exists without its match. `image_url` is always null (CardFace falls back).
   */
  | {
      op: "insert_catalog_stand_in";
      tcgdex_id: string;
      name: string;
      set_id: string | null;
      set_name: string | null;
      local_id: string | null;
      dex_id?: number[];
      types?: string[];
      stage?: string | null;
      card_class?: "standard" | "specialty";
    };

/** The full atomic write set for one commit. `ops` apply in order; groups resync last. */
export interface WritePayload {
  ops: WriteOp[];
  /** Presence groups whose `desired_count` is recomputed (post-apply live copy count). */
  resyncGroupIds?: string[];
}

/**
 * The slots and copies a write set touches, for the slot check (0028, UIL-117 PR 1). A copy counts if any op
 * creates, patches or deletes it, or names it as a slot's card; a slot counts if any op creates or patches it, or a
 * copy is pointed at it. Deliberately wide: a copy that moves binder can break its slot's rule without naming the
 * slot, so every touched copy's slot is checked, not only the slots the writer thought about.
 */
export function touchedLineState(ops: readonly WriteOp[]): {
  slotIds: string[];
  copyIds: string[];
  lineIds: string[];
} {
  const slots = new Set<string>();
  const copies = new Set<string>();
  const lines = new Set<string>();
  for (const o of ops) {
    switch (o.op) {
      case "insert_copy":
        copies.add(o.id);
        if (o.line_slot_id) slots.add(o.line_slot_id);
        break;
      case "update_copy":
        copies.add(o.id);
        if (o.patch.line_slot_id) slots.add(o.patch.line_slot_id);
        break;
      case "delete_copy":
        copies.add(o.id);
        break;
      case "insert_slot":
        slots.add(o.id);
        if (o.copy_id) copies.add(o.copy_id);
        break;
      case "update_slot":
        slots.add(o.id);
        if (o.patch.copy_id) copies.add(o.patch.copy_id);
        break;
      case "insert_line":
      case "update_line":
        lines.add(o.id);
        break;
      // Named so the slot check runs after a delete too. A deleted line drops out of the check's joins, so naming
      // it is harmless; what the check then proves is that the write left no half-written slot anywhere.
      case "delete_line":
        lines.add(o.line_id);
        break;
      // 0030 (UIL-121): a block or a wish is part of what a stage choice requires, so writing one checks that stage.
      case "insert_binder_block":
        if (o.line_id) lines.add(o.line_id);
        if (o.line_slot_id) slots.add(o.line_slot_id);
        if (o.copy_id) copies.add(o.copy_id);
        break;
      case "delete_binder_block":
        lines.add(o.line_id);
        break;
      case "upsert_wishlist_for_slot":
      case "resolve_wishlist_for_slot":
        slots.add(o.line_slot_id);
        break;
    }
  }
  return { slotIds: [...slots], copyIds: [...copies], lineIds: [...lines] };
}

/** The write set with the slot check appended LAST when it touches a copy or a slot (and not already present). */
export function withLineSlotCheck(ops: readonly WriteOp[]): WriteOp[] {
  if (ops.some((o) => o.op === "assert_line_slots")) return [...ops];
  const { slotIds, copyIds, lineIds } = touchedLineState(ops);
  if (slotIds.length === 0 && copyIds.length === 0 && lineIds.length === 0) return [...ops];
  return [
    ...ops,
    { op: "assert_line_slots", slot_ids: slotIds, copy_ids: copyIds, line_ids: lineIds },
  ];
}

/**
 * The copies whose binder this write set SETS (UIL-127a/b): every insert (a new copy's binder is set by creating it),
 * and every update whose patch carries `binder_id`. Only these are checked for "shelved with no binder", so a card left binderless by a deleted
 * binder is never refused for being touched and stays movable (the Tech Lead's C3).
 */
export function copiesWhoseBinderIsSet(ops: readonly WriteOp[]): string[] {
  const ids = new Set<string>();
  for (const o of ops) {
    if (o.op === "insert_copy") ids.add(o.id);
    else if (o.op === "update_copy" && "binder_id" in o.patch) ids.add(o.id);
  }
  return [...ids];
}

/** The write set with the copy-binder check appended LAST when it sets any copy's binder (and not already present). */
export function withCopyBinderCheck(ops: readonly WriteOp[]): WriteOp[] {
  if (ops.some((o) => o.op === "assert_copy_binders")) return [...ops];
  const copyIds = copiesWhoseBinderIsSet(ops);
  if (copyIds.length === 0) return [...ops];
  return [...ops, { op: "assert_copy_binders", copy_ids: copyIds }];
}

/**
 * Apply a write set atomically via the `apply_write_ops` RPC. Throws on any DB error — the whole set
 * has already rolled back server-side, so the caller never has to compensate.
 */
export async function applyWriteOps(db: DbClient, payload: WritePayload): Promise<void> {
  const body = {
    ops: withCopyBinderCheck(withLineSlotCheck(payload.ops)),
    resync_group_ids: payload.resyncGroupIds ?? [],
  };
  const { error } = await db.rpc("apply_write_ops", { payload: body as unknown as Json });
  if (error) throw error;
}
