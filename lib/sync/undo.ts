/**
 * Last-sync undo snapshot + its pure inversion (docs/sync-ui-spec.md §B.4–§B.5). PURE — no I/O.
 *
 * `AppliedSnapshot` is the single serialized pre-apply state written before each apply (overwritten
 * every sync — last-sync-only undo). It captures EXACTLY what the apply touched: the copies it
 * created, the full prior rows of the copies it retired (so they come back with their placement),
 * the line slots it freed, the variant flips it made, and every queue mutation. `invertSnapshot`
 * turns that record into the concrete set of restore operations the executor runs — one action
 * reverts the whole most-recent sync (B.5). The executor (lib/sync/exec.ts) captures live rows into
 * this shape and, on undo, runs the ops; the inversion itself stays pure and unit-testable.
 */

/** Full copy row, re-insertable verbatim (same id) to restore a retired copy with its placement. */
export interface SnapshotCopy {
  id: string;
  owner_id: string;
  catalog_card_id: string;
  variant: string;
  dex_variant_raw: string | null;
  presence_group_id: string | null;
  haul_id: string | null;
  acquired_at: string | null;
  role: string;
  binder_id: string | null;
  binder_half: string | null;
  color_band: string | null;
  line_slot_id: string | null;
  created_at: string;
}

/** A line slot's fill state before a retire freed it (state → placeholder, copy_id → null). */
export interface SnapshotSlot {
  id: string;
  state: string;
  copy_id: string | null;
}

/** A copy's identity fields before a variant migration flipped them. */
export interface SnapshotVariantPrior {
  copyId: string;
  variant: string;
  dexVariantRaw: string | null;
  presenceGroupId: string | null;
}

/** Full unresolved-queue entry row, re-insertable verbatim (for an A.7-dropped entry). */
export interface SnapshotEntry {
  id: string;
  owner_id: string;
  dex_id: string;
  dex_set_name: string | null;
  dex_series: string | null;
  dex_number: string | null;
  dex_name: string | null;
  dex_variant_raw: string;
  quantity: number;
  locale: string | null;
  reason: string;
  status: string;
  first_seen_sync: string;
  last_retry_sync: string | null;
  retry_count: number;
  manual_match_id: string | null;
}

/** The mutable fields of a queue entry, before a dedupe-update or a promotion changed them. */
export interface SnapshotEntryPrior {
  id: string;
  status: string;
  quantity: number;
  retry_count: number;
  last_retry_sync: string | null;
  reason: string;
  manual_match_id: string | null;
}

export interface SyncCounts {
  creates: number;
  retires: number;
  variantUpdates: number;
  /** Copies whose stored flag was corrected (UIL-102). Absent on a snapshot written before it. */
  flagFixes?: number;
  parks: number;
  drops: number;
  promotions: number;
  dedupeUpdates: number;
  unchanged: number;
}

/** The Dex record as it stood before a sync (UIL-100): what Undo puts back. */
export interface PriorDexRecord {
  rows: { catalog_card_id: string; dex_variant_raw: string; quantity: number }[];
  fileTotal: number;
  rowCount: number;
  importedAt: string;
}

export interface AppliedSnapshot {
  version: 1;
  /**
   * A digest of the plan this apply applied (UIL-099 E5). Lets a refused bundle be told "already applied"
   * only when it is this same preview. Optional: snapshots written before E5 carry none, and read as "some
   * other plan", which errs toward the safe "import again" message.
   */
  planDigest?: string;
  createdAt: string;
  fastPath: boolean;
  counts: SyncCounts;
  /** Copies created this sync — deleted on undo. */
  createdCopyIds: string[];
  /**
   * The (card, Dex variant) of each created copy, parallel to `createdCopyIds` (UIL-100). Lets Undo take
   * back a removal memory she recorded against a card this sync created: the card goes with the Undo, so
   * the memory must too, or the next import would subtract a removal from a card she still owns. Optional:
   * snapshots written before 0022 carry none, and Undo then leaves memories exactly as it always did.
   */
  createdCopyKeys?: { catalog_card_id: string; dex_variant_raw: string }[];
  /**
   * The Dex record this sync REPLACED or added to (UIL-100), restored verbatim on undo. `null`: there was
   * no record before this sync (her first recorded import), so Undo clears it. Absent: written before 0022,
   * when no record existed, so Undo leaves the record alone.
   */
  priorDexRecord?: PriorDexRecord | null;
  /** Copies retired this sync — re-inserted verbatim on undo. */
  retiredCopies: SnapshotCopy[];
  /** Line slots freed by a retire — restored to their filled state on undo. */
  slotReverts: SnapshotSlot[];
  /** Copies whose variant migrated — reverted to their prior identity on undo. */
  variantReverts: SnapshotVariantPrior[];
  /** Presence groups whose copy count moved — desired_count resynced on undo. */
  touchedGroupIds: string[];
  queue: {
    /** New WAITING entries inserted this sync — deleted on undo. */
    parkedIds: string[];
    /** Entries silently dropped (A.7) this sync — re-inserted verbatim on undo. */
    droppedEntries: SnapshotEntry[];
    /** Entries dedupe-updated in place — restored to their prior values on undo. */
    updatedPrior: SnapshotEntryPrior[];
    /** Entries promoted (auto/CSV/manual) to RESOLVED — restored to their prior status on undo. */
    archivedPrior: SnapshotEntryPrior[];
  };
}

/** The concrete restore operations `executeUndo` runs. Every field mirrors one snapshot section. */
export interface UndoOps {
  deleteCopyIds: string[];
  reinsertCopies: SnapshotCopy[];
  restoreSlots: SnapshotSlot[];
  revertVariants: SnapshotVariantPrior[];
  deleteEntryIds: string[];
  reinsertEntries: SnapshotEntry[];
  restoreEntries: SnapshotEntryPrior[];
  resyncGroupIds: string[];
}

/**
 * Invert an applied snapshot into its restore operations (PURE). Deterministic and total: every
 * mutation the apply recorded has exactly one inverse here, so running these ops returns the app to
 * its pre-apply state (sync-ui-spec §B.5).
 */
export function invertSnapshot(s: AppliedSnapshot): UndoOps {
  return {
    // Created copies are removed; retired copies come back with their old placement.
    deleteCopyIds: [...s.createdCopyIds],
    reinsertCopies: [...s.retiredCopies],
    // Freed line slots return to their filled state.
    restoreSlots: [...s.slotReverts],
    // Variant migrations revert to the prior variant/identity.
    revertVariants: [...s.variantReverts],
    // Queue: new parks removed, dropped entries restored, in-place changes rolled back.
    deleteEntryIds: [...s.queue.parkedIds],
    reinsertEntries: [...s.queue.droppedEntries],
    restoreEntries: [...s.queue.updatedPrior, ...s.queue.archivedPrior],
    resyncGroupIds: [...s.touchedGroupIds],
  };
}
