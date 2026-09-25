/**
 * Sync executor (docs/sync-ui-spec.md §A.5, §A.8, §B.4–§B.5). I/O — applies a plan bundle, writes the
 * single undo snapshot, reverses it, and runs the queue's manual-match / dismiss actions.
 *
 * ATOMICITY (M10, same boundary as lib/plan/commit.ts): each of apply / undo / manual-match reads the
 * current rows it needs, computes a fully-resolved ORDERED write set (with client-generated UUIDs so
 * cross-references resolve before insert), and applies the whole set in ONE transaction via the
 * `apply_write_ops` RPC (migration 0006). This replaces the earlier compensating-rollback interim — a
 * failure now leaves ZERO rows. All access is owner-scoped (RLS `auth.uid()`, SECURITY INVOKER RPC).
 * The undo snapshot (B.4) remains the user-facing, durable equivalent and is itself written atomically.
 */
import type { DbClient, Json, Row, WriteOp } from "@/lib/repo";
import {
  applyWriteOps,
  catalogCardRepo,
  copyRepo,
  dexImportRepo,
  dexPresenceRepo,
  lastSyncSnapshotRepo,
  evolutionLineRepo,
  lineSlotRepo,
  presenceGroupRepo,
  removedPresenceRepo,
  setAliasRepo,
  unresolvedEntryRepo,
} from "@/lib/repo";
import { releaseSlotOps } from "@/lib/line/move";
import { parseDexId, resolveDexId } from "./resolve";
import { localeOfId, normalizeLocale } from "@/lib/catalog/locale";
import { entryAsDexRow, loadAliasMap } from "./pipeline";
import { buildForgetAliasOps, type LearnedAlias } from "./alias";
import { applyOverrides, type SyncOverrides } from "./apply";
import { dexQuantity } from "./reconcile";
import type { SyncPlanBundle } from "./pipeline";
import { CountMismatchError, parseCountRefusal, type CardLabel } from "./count-check";
import type { PresenceKeyRef } from "@/lib/repo/write-ops";
import {
  assertFreshBase,
  derivedUuid,
  latestSnapshot,
  planDigest,
  refusalAfterRace,
  snapshotIdForBase,
  tombstoneIdFor,
  undoableSnapshot,
  type SnapshotTombstone,
} from "./apply-guard";
import {
  invertSnapshot,
  type AppliedSnapshot,
  type SnapshotCopy,
  type SnapshotEntry,
  type SnapshotEntryPrior,
  type SnapshotSlot,
  type SnapshotVariantPrior,
  type PriorDexRecord,
} from "./undo";

export interface ApplyResult {
  snapshotId: string;
  added: number;
  removed: number;
  variantChanges: number;
  waiting: number;
  fastPath: boolean;
}

const nowIso = () => new Date().toISOString();

/** Full copy row → the re-insertable snapshot shape (verbatim). */
function toSnapshotCopy(c: Row<"copy">): SnapshotCopy {
  return {
    id: c.id,
    owner_id: c.owner_id,
    catalog_card_id: c.catalog_card_id,
    variant: c.variant,
    dex_variant_raw: c.dex_variant_raw,
    presence_group_id: c.presence_group_id,
    haul_id: c.haul_id,
    acquired_at: c.acquired_at,
    role: c.role,
    binder_id: c.binder_id,
    binder_half: c.binder_half,
    color_band: c.color_band,
    line_slot_id: c.line_slot_id,
    created_at: c.created_at,
  };
}

function toSnapshotEntry(e: Row<"unresolved_entry">): SnapshotEntry {
  return {
    id: e.id,
    owner_id: e.owner_id,
    dex_id: e.dex_id,
    dex_set_name: e.dex_set_name,
    dex_series: e.dex_series,
    dex_number: e.dex_number,
    dex_name: e.dex_name,
    dex_variant_raw: e.dex_variant_raw,
    quantity: e.quantity,
    locale: e.locale,
    reason: e.reason,
    status: e.status,
    first_seen_sync: e.first_seen_sync,
    last_retry_sync: e.last_retry_sync,
    retry_count: e.retry_count,
    manual_match_id: e.manual_match_id,
  };
}

function toEntryPrior(e: Row<"unresolved_entry">): SnapshotEntryPrior {
  return {
    id: e.id,
    status: e.status,
    quantity: e.quantity,
    retry_count: e.retry_count,
    last_retry_sync: e.last_retry_sync,
    reason: e.reason,
    manual_match_id: e.manual_match_id,
  };
}

/** A retired copy (snapshot shape) → the op that reinserts it verbatim, id + placement preserved. */
function reinsertCopyOp(c: SnapshotCopy): WriteOp {
  return {
    op: "insert_copy",
    id: c.id,
    catalog_card_id: c.catalog_card_id,
    variant: c.variant,
    dex_variant_raw: c.dex_variant_raw,
    presence_group_id: c.presence_group_id,
    haul_id: c.haul_id,
    acquired_at: c.acquired_at,
    role: c.role,
    binder_id: c.binder_id,
    binder_half: c.binder_half,
    color_band: c.color_band,
    line_slot_id: c.line_slot_id,
    created_at: c.created_at,
  };
}

/** A dropped queue entry (snapshot shape) → the op that reinserts it verbatim. */
function reinsertEntryOp(e: SnapshotEntry): WriteOp {
  return {
    op: "insert_unresolved_entry",
    id: e.id,
    dex_id: e.dex_id,
    dex_set_name: e.dex_set_name,
    dex_series: e.dex_series,
    dex_number: e.dex_number,
    dex_name: e.dex_name,
    dex_variant_raw: e.dex_variant_raw,
    quantity: e.quantity,
    locale: e.locale,
    reason: e.reason,
    status: e.status,
    first_seen_sync: e.first_seen_sync,
    last_retry_sync: e.last_retry_sync,
    retry_count: e.retry_count,
    manual_match_id: e.manual_match_id,
  };
}

/* ------------------------------ the Dex record (UIL-100) ------------------------------ */

/** The Dex record as it stands now — what an Undo of the sync about to run would put back. */
async function readDexRecord(db: DbClient): Promise<PriorDexRecord | null> {
  const header = await dexImportRepo.get(db);
  if (!header) return null;
  const rows = await dexPresenceRepo.listAll(db);
  return {
    rows: rows.map((r) => ({
      catalog_card_id: r.catalog_card_id,
      dex_variant_raw: r.dex_variant_raw,
      quantity: r.quantity,
    })),
    fileTotal: header.file_total,
    rowCount: header.row_count,
    importedAt: header.imported_at,
  };
}

/** The op that puts a prior record back: replace it, or clear it when there was none before. */
function restoreDexRecordOp(prior: PriorDexRecord | null): WriteOp {
  return prior
    ? {
        op: "replace_dex_record",
        rows: prior.rows,
        file_total: prior.fileTotal,
        row_count: prior.rowCount,
        imported_at: prior.importedAt,
      }
    : { op: "clear_dex_record" };
}

/**
 * If `err` is the count check refusing this write (UIL-100), the same refusal in her words — cards named
 * from the catalog, extra or missing, and what to do next. Otherwise null, and the caller rethrows `err`.
 */
async function asCountRefusal(
  db: DbClient,
  err: unknown,
  nextStep: string,
): Promise<CountMismatchError | null> {
  const parsed = parseCountRefusal(err);
  if (!parsed) return null;
  const labels = new Map<string, CardLabel>();
  for (const k of parsed.keys.slice(0, 10)) {
    const card = await catalogCardRepo.getByPk(db, k.catalog_card_id);
    if (card)
      labels.set(k.catalog_card_id, {
        name: card.name,
        setName: card.set_name,
        localId: card.local_id,
      });
  }
  return new CountMismatchError(parsed.keys, parsed.total, labels, nextStep);
}

const NEXT_STEP = {
  import:
    "Your collection is exactly as it was. Import the file again; if the same cards are named, that is a " +
    "bug to report (UIL-100) — nothing has been changed.",
  retry:
    "Nothing was saved, and the waiting cards are still waiting. Match them by hand from the list below, " +
    "or report this (UIL-100).",
  match:
    "Nothing was saved. The app already holds more of this card than your Dex file lists, so this match " +
    "would count one twice. Import your Dex file again first: the preview lists the extra copy and takes " +
    "it out when you apply. Then match. (Do not remove a copy yourself — removing records it as traded away.)",

  undo: "Undo was not applied: your collection is as it was before you pressed it. Report this (UIL-100).",
  restore:
    "Nothing was added back. Import your Dex file again first: the preview shows what does not add up. " +
    "Then add it back. (UIL-099)",
} as const;

/**
 * Apply a plan bundle: fold in the preview overrides, then build + apply (in one transaction) the
 * copy/placement/queue writes and the single undo snapshot (B.4).
 */
export async function executeApply(
  db: DbClient,
  bundle: SyncPlanBundle,
  /**
   * Who is applying — keys the no-snapshot-yet case of the apply-once guard (UIL-099 E5; see
   * `snapshotIdForBase`). REQUIRED (the Tech Lead's N1): a default would let a new server caller silently
   * share one first-import key across owners.
   */
  ownerScope: string,
  overrides?: SyncOverrides,
): Promise<ApplyResult> {
  /**
   * ONE PREVIEW, APPLIED ONCE (UIL-099 E5). Refused before anything is built or written when the collection
   * has moved on since this bundle's preview — most often because this very preview was already applied
   * from another tab, a double click or a retry. The race two simultaneous applies would still win against
   * this read is closed by the snapshot's derived primary key below.
   */
  const priorSnapshots = await lastSyncSnapshotRepo.list(db);
  const digest = planDigest(bundle);
  assertFreshBase(bundle.baseSnapshotId, latestSnapshot(priorSnapshots), ownerScope, digest);

  const plan = applyOverrides(bundle.plan, bundle.current, overrides);
  const now = nowIso();

  const ops: WriteOp[] = [];
  const groupCache = new Map<string, string>();
  const touchedGroupIds = new Set<string>();

  const createdCopyIds: string[] = [];
  const createdCopyKeys: { catalog_card_id: string; dex_variant_raw: string }[] = [];
  const retiredCopies: SnapshotCopy[] = [];
  const slotReverts: SnapshotSlot[] = [];
  const variantReverts: SnapshotVariantPrior[] = [];
  const q = {
    parkedIds: [] as string[],
    droppedEntries: [] as SnapshotEntry[],
    updatedPrior: [] as SnapshotEntryPrior[],
    archivedPrior: [] as SnapshotEntryPrior[],
  };

  /** Find or create the presence group for a key; cache within the pass; track created for undo. */
  async function ensureGroup(catalogCardId: string, dexVariantRaw: string): Promise<string> {
    const k = `${catalogCardId} ${dexVariantRaw}`;
    const cached = groupCache.get(k);
    if (cached) return cached;
    const existing = await presenceGroupRepo.findByKey(db, catalogCardId, dexVariantRaw);
    if (existing) {
      groupCache.set(k, existing.id);
      touchedGroupIds.add(existing.id);
      return existing.id;
    }
    const id = crypto.randomUUID();
    ops.push({
      op: "insert_presence_group",
      id,
      catalog_card_id: catalogCardId,
      dex_variant_raw: dexVariantRaw,
      desired_count: 0,
    });
    touchedGroupIds.add(id);
    groupCache.set(k, id);
    return id;
  }

  // 1. Archive WAITING entries whose cards now resolve (promotions — their copies come from creates).
  for (const id of bundle.queue.archiveEntryIds) {
    const e = await unresolvedEntryRepo.getByPk(db, id);
    if (!e) continue;
    q.archivedPrior.push(toEntryPrior(e));
    ops.push({
      op: "update_unresolved_entry",
      id,
      patch: { status: "RESOLVED", last_retry_sync: now },
    });
  }

  // 2. Variant migrations first — carry placement across (sync-arch §1.7 step 5).
  for (const vu of plan.variantUpdates) {
    const copy = await copyRepo.getByPk(db, vu.copyId);
    if (!copy) continue;
    variantReverts.push({
      copyId: copy.id,
      variant: copy.variant,
      dexVariantRaw: copy.dex_variant_raw,
      presenceGroupId: copy.presence_group_id,
    });
    if (copy.presence_group_id) touchedGroupIds.add(copy.presence_group_id);
    const toGroup = await ensureGroup(vu.catalogCardId, vu.toVariantRaw);
    ops.push({
      op: "update_copy",
      id: copy.id,
      patch: {
        variant: vu.toVariant,
        dex_variant_raw: vu.toVariantRaw,
        presence_group_id: toGroup,
      },
    });
  }

  // 3. Adds — create unplaced copies for the routing cascade (B.6 places them later).
  for (const c of plan.creates) {
    const groupId = await ensureGroup(c.catalogCardId, c.dexVariantRaw);
    const id = crypto.randomUUID();
    ops.push({
      op: "insert_copy",
      id,
      catalog_card_id: c.catalogCardId,
      variant: c.variant,
      dex_variant_raw: c.dexVariantRaw,
      presence_group_id: groupId,
      // UIL-088: `'haul'`, not `'bulk'`. An import has not PLACED this card anywhere — the bulk box is a
      // real place she chooses, and calling this "bulk" was the conflation that let the engine read an
      // unplaced copy as "already placed" (UIL-087's cause (a)).
      role: "haul",
      acquired_at: now,
    });
    createdCopyIds.push(id);
    createdCopyKeys.push({ catalog_card_id: c.catalogCardId, dex_variant_raw: c.dexVariantRaw });
  }

  // 4. Retires — release placement under the removal rule (§1.6). Blocks are NEVER auto-reverted.
  for (const r of plan.retires) {
    const copy = await copyRepo.getByPk(db, r.copyId);
    if (!copy) continue;
    retiredCopies.push(toSnapshotCopy(copy));
    if (copy.presence_group_id) touchedGroupIds.add(copy.presence_group_id);

    if (copy.line_slot_id) {
      const slot = await lineSlotRepo.getByPk(db, copy.line_slot_id);
      if (slot) {
        slotReverts.push({ id: slot.id, state: slot.state, copy_id: slot.copy_id });
        // Through the ONE slot-release path (UIL-062), not an inline update_slot: a slot the export
        // vacates is as new a situation as one a move vacates, so UIL-078's "already answered" marker
        // must be cleared here too or the slot would never ask again. No line demotion is requested —
        // a sync retire has never demoted a `complete` line, and this change does not start to.
        ops.push(...releaseSlotOps(slot.id, null));
      }
    }
    ops.push({ op: "delete_copy", id: copy.id });
  }

  // 5. Park CSV rows still unresolved — deduped on (dex_id, dex_variant_raw) (A.6).
  const liveWaiting = await unresolvedEntryRepo.listWaiting(db);
  const waitingByKey = new Map(liveWaiting.map((e) => [`${e.dex_id} ${e.dex_variant_raw}`, e]));
  for (const p of bundle.queue.parks) {
    const prior = waitingByKey.get(`${p.dexId} ${p.dexVariantRaw}`);
    if (prior) {
      q.updatedPrior.push(toEntryPrior(prior));
      ops.push({
        op: "update_unresolved_entry",
        id: prior.id,
        patch: {
          quantity: p.quantity,
          reason: p.reason,
          retry_count: prior.retry_count + 1,
          last_retry_sync: now,
        },
      });
    } else {
      const id = crypto.randomUUID();
      ops.push({
        op: "insert_unresolved_entry",
        id,
        dex_id: p.dexId,
        dex_set_name: p.dexSetName,
        dex_series: p.dexSeries,
        dex_number: p.dexNumber,
        dex_name: p.dexName,
        dex_variant_raw: p.dexVariantRaw,
        quantity: p.quantity,
        locale: p.locale,
        reason: p.reason,
        status: "WAITING",
      });
      q.parkedIds.push(id);
    }
  }

  // 6. Drop WAITING entries the export no longer contains — silent, never placed (A.7).
  for (const id of bundle.queue.dropEntryIds) {
    const e = await unresolvedEntryRepo.getByPk(db, id);
    if (!e) continue;
    q.droppedEntries.push(toSnapshotEntry(e));
    ops.push({ op: "delete_unresolved_entry", id });
  }

  /**
   * 7a. The Dex record (UIL-100), in THIS transaction so it can never disagree with the copies it describes.
   *     An import replaces it with what the file says; a retry adds the rows it promotes (only once an import
   *     has recorded a file — before that there is nothing to add to). The record as it stood goes into the
   *     undo snapshot, so an Undo puts it back exactly.
   *     A bundle with no `dexRecord` was previewed before 0022 deployed: it writes no record, and no check
   *     runs for it, exactly as before.
   */
  const priorDexRecord =
    bundle.dexRecord || bundle.dexAdds?.length ? await readDexRecord(db) : undefined;
  const dexAdds = priorDexRecord ? (bundle.dexAdds ?? []) : [];
  if (bundle.dexRecord) {
    ops.push({
      op: "replace_dex_record",
      rows: bundle.dexRecord.rows,
      file_total: bundle.dexRecord.fileTotal,
      row_count: bundle.dexRecord.rowCount,
      imported_at: now,
    });
  }
  for (const a of dexAdds) ops.push({ op: "add_dex_presence", ...a });
  const recordTouched = Boolean(bundle.dexRecord) || dexAdds.length > 0;

  // 7. Write the single undo snapshot LAST (overwrite-per-owner) as part of the same transaction.
  const fastPath = plan.retires.length === 0 && plan.variantUpdates.length === 0;
  const snapshot: AppliedSnapshot = {
    version: 1,
    // What this apply applied, so a later refusal can tell "this same preview, again" from "a different file"
    // (UIL-099 E5, the Tech Lead's M1).
    planDigest: digest,
    createdAt: now,
    fastPath,
    counts: bundle.counts,
    createdCopyIds,
    createdCopyKeys,
    retiredCopies,
    slotReverts,
    variantReverts,
    touchedGroupIds: [...touchedGroupIds],
    queue: q,
    // Absent unless this sync wrote the record: an Undo then leaves the record exactly alone.
    ...(recordTouched ? { priorDexRecord: priorDexRecord ?? null } : {}),
  };
  // 7b. Forget the removal memories this export no longer contradicts (UIL-089). Dex has stopped listing
  //     these keys, so the disagreement each row recorded is over; keeping them would suppress a genuine
  //     future re-acquisition forever. In THIS transaction, so a half-applied import cannot forget half a
  //     memory. Empty on a retry import by construction — `reconcile` only populates it for a full export.
  for (const f of plan.forgetRemoved) {
    ops.push({
      op: "forget_removed_presence",
      catalog_card_id: f.catalogCardId,
      dex_variant_raw: f.dexVariantRaw,
    });
  }

  for (const pr of priorSnapshots) ops.push({ op: "delete_snapshot", id: pr.id });
  // DERIVED, not random (UIL-099 E5): two applies of the same base insert the SAME id, so the second fails on
  // the primary key inside its own transaction and nothing it wrote survives. See lib/sync/apply-guard.ts.
  const snapshotId = snapshotIdForBase(bundle.baseSnapshotId, ownerScope);
  ops.push({ op: "insert_snapshot", id: snapshotId, snapshot: snapshot as unknown as Json });

  /**
   * 7c. THE CHECK, LAST (UIL-100): the collection must add up to the Dex file. An import checks EVERY key —
   *     it has just reconciled every key to the file, so any disagreement left is this import's own. A retry
   *     checks the keys it promoted. Refused: nothing above survives, and she is told which cards and why.
   */
  if (bundle.dexRecord) ops.push({ op: "assert_presence_counts", all: true });
  else if (dexAdds.length > 0) {
    ops.push({
      op: "assert_presence_counts",
      keys: dexAdds.map((a) => ({
        catalog_card_id: a.catalog_card_id,
        dex_variant_raw: a.dex_variant_raw,
      })),
    });
  }

  // 8. Touched groups' desired_count is recomputed by the RPC after all copy writes (§C).
  try {
    await applyWriteOps(db, { ops, resyncGroupIds: [...touchedGroupIds] });
  } catch (err) {
    // Did a racing apply of THIS base commit first? This transaction has rolled back whole either way; the
    // question is only what to tell her. Asked of the database, not of the error: which constraint fires
    // first depends on the plan — a racing apply that creates a new presence group collides on that
    // group's unique key before it ever reaches the snapshot insert — so matching an error message would
    // answer correctly only for some imports.
    const refusal = refusalAfterRace(
      latestSnapshot(await lastSyncSnapshotRepo.list(db)),
      snapshotId,
      digest,
    );
    if (refusal) throw refusal;
    const countRefusal = await asCountRefusal(db, err, NEXT_STEP[bundle.mode]);
    if (countRefusal) throw countRefusal;
    throw err;
  }

  return {
    snapshotId,
    added: plan.creates.length,
    removed: plan.retires.length,
    variantChanges: plan.variantUpdates.length,
    waiting: bundle.queue.stillWaiting,
    fastPath,
  };
}

export interface UndoResult {
  restoredCopies: number;
  removedCopies: number;
  revertedVariants: number;
}

/**
 * Undo the most-recent sync (B.5): one action restores the whole `AppliedSnapshot`, applied in one
 * transaction. Available until the next apply overwrites the snapshot; a pure local restore.
 */
export async function executeUndo(db: DbClient): Promise<UndoResult> {
  // A tombstone is what an Undo leaves behind: that sync has already been undone (UIL-099 E5).
  const latest = undoableSnapshot(await lastSyncSnapshotRepo.list(db));
  if (!latest) throw new Error("Nothing to undo — the last sync's undo point is gone.");
  const snap = latest.snapshot as unknown as AppliedSnapshot;
  const undo = invertSnapshot(snap);

  /**
   * KARVI'S RULING (UIL-100, condition 2 — option A', "Remove them, remember matches"): Undo takes back
   * EVERYTHING that import added, INCLUDING the cards she matched by hand after it, and REMEMBERS her
   * matches, so importing the same file again puts them straight back with no re-matching (UIL-082's path).
   *
   * Before this, a card matched by hand after an import SURVIVED its Undo: a manual match writes no snapshot,
   * so its copies were not in `createdCopyIds`, while the entry that justified them — parked by the import —
   * was deleted with it. The copy was left an orphan; the re-import re-parked the row with no memory of the
   * match; re-matching added a second copy on top. A double, from Undo alone.
   *
   * WHICH ENTRIES: those this import parked or dedupe-updated (the only ones that could be WAITING for her to
   * match after it) that are now RESOLVED to a card she chose. They STAY resolved, with their match.
   * WHICH COPIES: in that match's presence group, created after this sync (the snapshot row's own
   * `created_at` — the database's clock, the same one that stamped the copies) and not by it. Nothing but a
   * manual match, a stand-in match or "add it back" creates a grouped copy between syncs, and each of those
   * is a hand match of one of these entries.
   */
  const syncedAt = new Date(latest.created_at).getTime();
  const createdByThisSync = new Set(snap.createdCopyIds);
  const priorStatus = new Map(snap.queue.updatedPrior.map((p) => [p.id, p.status]));
  const keptMatches: Row<"unresolved_entry">[] = [];
  for (const id of [...snap.queue.parkedIds, ...priorStatus.keys()]) {
    const e = await unresolvedEntryRepo.getByPk(db, id);
    if (!e || e.status !== "RESOLVED" || !e.manual_match_id) continue;
    if (priorStatus.has(id) && priorStatus.get(id) === "RESOLVED") continue; // already matched before it
    keptMatches.push(e);
  }
  const keptMatchIds = new Set(keptMatches.map((e) => e.id));
  const handMatchedCopyIds: string[] = [];
  const handMatchedGroupIds = new Set<string>();
  const seenCopy = new Set<string>();
  for (const e of keptMatches) {
    const group = await presenceGroupRepo.findByKey(
      db,
      e.manual_match_id as string,
      e.dex_variant_raw,
    );
    if (!group) continue;
    for (const c of await copyRepo.listByPresenceGroup(db, group.id)) {
      if (createdByThisSync.has(c.id) || seenCopy.has(c.id)) continue;
      if (new Date(c.created_at).getTime() <= syncedAt) continue; // there before this sync: not a hand match of it
      seenCopy.add(c.id);
      handMatchedCopyIds.push(c.id);
      handMatchedGroupIds.add(group.id);
    }
  }

  const ops: WriteOp[] = [];

  // Restore queue first (no FK dependence on copies).
  for (const e of undo.reinsertEntries) ops.push(reinsertEntryOp(e));
  for (const p of undo.restoreEntries) {
    // A match she made after this sync is REMEMBERED (A'): the entry keeps RESOLVED and its manual match;
    // every other field goes back to what it was.
    const keep = keptMatchIds.has(p.id);
    ops.push({
      op: "update_unresolved_entry",
      id: p.id,
      patch: {
        ...(keep ? {} : { status: p.status, manual_match_id: p.manual_match_id }),
        quantity: p.quantity,
        retry_count: p.retry_count,
        last_retry_sync: p.last_retry_sync,
        reason: p.reason,
      },
    });
  }
  for (const id of undo.deleteEntryIds) {
    if (keptMatchIds.has(id)) continue; // A': this import parked it, she matched it — keep the match
    ops.push({ op: "delete_unresolved_entry", id });
  }

  // Bring retired copies back (with placement), then re-point their freed slots.
  for (const c of undo.reinsertCopies) ops.push(reinsertCopyOp(c));
  for (const s of undo.restoreSlots) {
    ops.push({ op: "update_slot", id: s.id, patch: { state: s.state, copy_id: s.copy_id } });
  }
  // Revert variant migrations.
  for (const v of undo.revertVariants) {
    ops.push({
      op: "update_copy",
      id: v.copyId,
      patch: {
        variant: v.variant,
        dex_variant_raw: v.dexVariantRaw,
        presence_group_id: v.presenceGroupId,
      },
    });
  }
  /**
   * Remove the copies the sync created — RELEASING any line slot they have since been shelved into
   * (UIL-087's latent shape).
   *
   * `line_slot.copy_id` is `on delete set null`, so a bare delete frees the POINTER and leaves
   * `state = 'filled'`: a slot holding nothing, which nothing detects — migration 0010's one-time
   * repair explicitly required `copy_id is not null`, so this shape was never in its predicate. It is
   * reachable because a sync-created copy starts unplaced and she can shelve it into a line from the
   * Haul Plan (UIL-003's whole flow) before undoing that sync.
   *
   * The retire path above already does this through the same shared emitter; only this one was bare.
   * It DOES request the demotion, unlike the retire path: a `complete` line is not complete once a
   * stage empties, and every non-sync release (`applyMove`, the collection removal, the Haul Plan
   * override) demotes. The retire path's `null` is documented as a deliberate choice and is left alone
   * rather than changed here under a different entry.
   */
  /**
   * A removal she made against a card THIS sync created goes with the Undo too (UIL-100): the card is being
   * taken back anyway, and a memory left behind would make the next import subtract it from a card she
   * still owns. Created copies that no longer exist are those she removed (or merged) since; the memory on
   * their key shrinks by that many, never below zero. Needs the created copies' keys, which snapshots record
   * from 0022 on; an older snapshot leaves memories exactly as Undo always did.
   */
  if (snap.createdCopyKeys && snap.createdCopyKeys.length === snap.createdCopyIds.length) {
    const goneByKey = new Map<string, PresenceKeyRef & { n: number }>();
    for (const [i, id] of snap.createdCopyIds.entries()) {
      if (await copyRepo.getByPk(db, id)) continue;
      const k = snap.createdCopyKeys[i];
      const kk = `${k.catalog_card_id}\u0000${k.dex_variant_raw}`;
      const cur = goneByKey.get(kk) ?? { ...k, n: 0 };
      cur.n += 1;
      goneByKey.set(kk, cur);
    }
    if (goneByKey.size > 0) {
      const memories = new Map(
        (await removedPresenceRepo.listAll(db)).map((m) => [
          `${m.catalog_card_id}\u0000${m.dex_variant_raw}`,
          m.count,
        ]),
      );
      for (const [kk, g] of goneByKey) {
        const held = memories.get(kk) ?? 0;
        const by = Math.min(held, g.n);
        if (by > 0) {
          ops.push({
            op: "shrink_removed_presence",
            catalog_card_id: g.catalog_card_id,
            dex_variant_raw: g.dex_variant_raw,
            by,
          });
        }
      }
    }
  }

  for (const id of [...undo.deleteCopyIds, ...handMatchedCopyIds]) {
    const copy = await copyRepo.getByPk(db, id);
    if (copy?.line_slot_id) {
      const slot = await lineSlotRepo.getByPk(db, copy.line_slot_id);
      // Positive match only: a crossed pointer must not evict a card that never moved (UIL-062).
      if (slot && slot.copy_id === id) {
        const line = await evolutionLineRepo.getByPk(db, slot.line_id);
        ops.push(...releaseSlotOps(slot.id, line?.status === "complete" ? line.id : null));
      }
    }
    ops.push({ op: "delete_copy", id });
  }

  /**
   * Undo consumes the snapshot and leaves a TOMBSTONE in its place, never nothing (UIL-099 E5, the Tech
   * Lead's B1). With no row at all the collection's freshness key would be null — the same as "never synced"
   * — and a stale tab's preview from before her first import would pass and apply again on top of it. The
   * tombstone is the new base, so that preview is refused as stale while a FRESH preview (whose base is the
   * tombstone) applies normally. Its id is derived from the snapshot it replaces, so a double-clicked Undo
   * collides on it and rolls back whole.
   */
  const tombstoneId = tombstoneIdFor(latest.id);
  const tombstone: SnapshotTombstone = {
    version: 1,
    tombstone: true,
    undoneSnapshotId: latest.id,
    createdAt: nowIso(),
  };
  ops.push({ op: "delete_snapshot", id: latest.id });
  ops.push({ op: "insert_snapshot", id: tombstoneId, snapshot: tombstone as unknown as Json });

  /**
   * The Dex record goes back to what it was before this sync (UIL-100), then THE CHECK runs over every key
   * either record names — every key this Undo could have moved. An Undo of her first recorded import clears
   * the record; the check then has no header and passes. A snapshot from before 0022 wrote no record, so its
   * Undo leaves the record alone and checks nothing, as before.
   */
  if (snap.priorDexRecord !== undefined) {
    const current = (await dexPresenceRepo.listAll(db)).map((r) => ({
      catalog_card_id: r.catalog_card_id,
      dex_variant_raw: r.dex_variant_raw,
    }));
    ops.push(restoreDexRecordOp(snap.priorDexRecord));
    const keys = new Map<string, PresenceKeyRef>();
    for (const k of [...current, ...(snap.priorDexRecord?.rows ?? [])]) {
      keys.set(`${k.catalog_card_id}\u0000${k.dex_variant_raw}`, {
        catalog_card_id: k.catalog_card_id,
        dex_variant_raw: k.dex_variant_raw,
      });
    }
    if (keys.size > 0) ops.push({ op: "assert_presence_counts", keys: [...keys.values()] });
  }

  try {
    await applyWriteOps(db, {
      ops,
      resyncGroupIds: [...new Set([...undo.resyncGroupIds, ...handMatchedGroupIds])],
    });
  } catch (err) {
    // A racing Undo of this same snapshot committed first (a double click): this one rolled back whole.
    const now = latestSnapshot(await lastSyncSnapshotRepo.list(db));
    if (now?.id === tombstoneId) throw new Error("That sync has already been undone.");
    const countRefusal = await asCountRefusal(db, err, NEXT_STEP.undo);
    if (countRefusal) throw countRefusal;
    throw err;
  }

  return {
    restoredCopies: undo.reinsertCopies.length,
    removedCopies: undo.deleteCopyIds.length + handMatchedCopyIds.length,
    revertedVariants: undo.revertVariants.length,
  };
}

export interface ManualMatchResult {
  learnedAlias: { locale: string; dexCode: string; tcgdexSetId: string } | null;
  /**
   * Set when the match was pinned but NO alias was learned because it would have crossed locales
   * (UIL-047 C3). Non-null is not a failure — the card is matched — but she needs telling, or "one match
   * drains the set" silently does not happen and looks like the retry being broken.
   */
  aliasSkippedReason?: string | null;
  created: number;
  /**
   * Copies the match did NOT create because she had removed that many of this card while Dex still
   * listed it (UIL-099 E2). Null when nothing was held back. The Sync page names them and offers
   * `restoreWithheldForEntry`; a notice, not a failure: the row IS matched.
   */
  withheld?: WithheldForRemoval | null;
  /**
   * True when this row was already matched to this card, so NOTHING was written: a second press, a second
   * tab, or a retry after a lost response. Reported as success, because the match did land.
   */
  alreadyMatched?: boolean;
}

/** What a manual match held back, keyed exactly like `removed_presence` (UIL-099 E2). */
export interface WithheldForRemoval {
  count: number;
  catalogCardId: string;
  dexVariantRaw: string;
}

/** Why a Match press on an already-resolved row is refused (UIL-099). Exported so tests and screen agree. */
export const MATCH_REFUSED = {
  /** Resolved to a DIFFERENT card: matching again would add this row's cards a second time. */
  matchedElsewhere: (cardId: string) =>
    `This row is already matched to ${cardId}. Matching it again would add its cards a second time. ` +
    `Reload the Sync page to see it.`,
  /** Resolved by an import (a Retry, or a learned set), which already created its copies. */
  resolvedByImport:
    "An import already resolved this row and added its cards, so matching it would add them a second " +
    "time. Reload the Sync page to see it.",
} as const;

/**
 * WHAT ONE PRESENCE KEY HOLDS, for the two writes that change it by hand (UIL-099 E1/E2 on UIL-100's
 * record): whether a Dex import has been RECORDED (the `dex_import` header — one read, never inferred from
 * the key, because a key Dex never listed reads record 0 in an armed collection), what the record says for
 * this key BEFORE removals, what she removed, and the copies its presence group holds now.
 */
async function keyState(
  db: DbClient,
  catalogCardId: string,
  dexVariantRaw: string,
  groupId: string | null,
): Promise<{ armed: boolean; record: number; removed: number; current: number }> {
  const [header, record, memory, copies] = await Promise.all([
    dexImportRepo.get(db),
    dexPresenceRepo.findByKey(db, catalogCardId, dexVariantRaw),
    removedPresenceRepo.findByKey(db, catalogCardId, dexVariantRaw),
    groupId ? copyRepo.listByPresenceGroup(db, groupId) : Promise.resolve([]),
  ]);
  return {
    armed: header !== null,
    record: record?.quantity ?? 0,
    removed: memory?.count ?? 0,
    current: copies.length,
  };
}

/**
 * The copy ids a manual match writes: DERIVED from the entry, not random (UIL-099; the E5 pattern). Two
 * presses of one match that both pass the status check build the SAME ids, so the second transaction
 * collides on the primary key instead of inserting the row's cards twice. `retry_count` is bumped by the
 * match itself, so a row that is ever legitimately matched again derives new ids.
 */
function matchCopyId(entry: Row<"unresolved_entry">, i: number): string {
  return derivedUuid(`match:${entry.id}:${entry.retry_count}:${i}`);
}

/**
 * THE STATUS CHECK a Match press makes before building anything (UIL-099, found while building E2).
 * `manualMatch` never looked: a second press on a RESOLVED row re-inserted its whole quantity, the E5
 * doubling on the Sync page's other write. A row already matched to the SAME card gets this no-op result;
 * a row resolved any other way is refused by `refuseResolved`.
 */
function alreadyMatchedResult(): ManualMatchResult {
  return {
    learnedAlias: null,
    aliasSkippedReason: null,
    created: 0,
    withheld: null,
    alreadyMatched: true,
  };
}

function refuseResolved(entry: Row<"unresolved_entry">): never {
  throw new Error(
    entry.manual_match_id
      ? MATCH_REFUSED.matchedElsewhere(entry.manual_match_id)
      : MATCH_REFUSED.resolvedByImport,
  );
}

/**
 * What a stand-in needs from her (UIL-060 Half 1). Everything the entry already carries (name, set
 * name, collector number, the set id when an alias resolved it) is prefilled by the form; the one thing
 * the export cannot supply is what KIND of card it is, because without a type and stage the engine
 * classifies a card as a Trainer and bands it White (lib/plan/adapt.ts).
 */
export interface StandInInput {
  name: string;
  setName: string | null;
  /** The TCGdex set id when the entry's set is known (UNKNOWN_CARD); null for UNKNOWN_SET. */
  setId: string | null;
  localId: string | null;
  kind:
    | { kind: "pokemon"; type: string; stage: "Basic" | "Stage1" | "Stage2"; dexId?: number | null }
    | { kind: "trainer" }
    | { kind: "energy" };
  cardClass?: "standard" | "specialty";
}

/** The id namespace a stand-in lives in; the schema check in 0015 ties it to `source = 'user'`. */
export const STAND_IN_ID_PREFIX = "user:";
export function newStandInId(): string {
  return `${STAND_IN_ID_PREFIX}${crypto.randomUUID()}`;
}
export function isStandInId(tcgdexId: string): boolean {
  return tcgdexId.startsWith(STAND_IN_ID_PREFIX);
}

/**
 * Thrown instead of creating a second stand-in for the same card (Karvi's refusal rule: name the
 * condition, show the remedy). The remedy is to match to `twin` instead; the caller offers it.
 */
export class StandInTwinError extends Error {
  constructor(public readonly twin: Row<"catalog_card">) {
    super(
      `A stand-in for "${twin.name}"${twin.set_name ? ` in ${twin.set_name}` : ""}` +
        `${twin.local_id ? ` · ${twin.local_id}` : ""} already exists. Match this entry to it instead ` +
        `of creating a twin.`,
    );
    this.name = "StandInTwinError";
  }
}

const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();

/**
 * The ops that pin ONE entry to ONE catalog id — alias (when the set was unknown and the target has a
 * set), presence group, N bulk copies, entry RESOLVED — shared by the real-card match and the stand-in
 * match so the two can never drift.
 */
async function matchOps(
  db: DbClient,
  entry: Row<"unresolved_entry">,
  target: { tcgdexId: string; setId: string | null },
  now: string,
): Promise<{ ops: WriteOp[]; groupId: string; result: ManualMatchResult }> {
  const ops: WriteOp[] = [];

  /**
   * Learn the set alias when the set itself was unknown — BUT NEVER ACROSS LOCALES (UIL-047 C3).
   *
   * The manual match itself is her explicit decision about ONE row and is always honoured. The alias is
   * the app GENERALISING that decision to every future row of the same set, and generalising it across
   * languages is what turns one uncertain match into a permanent stream of confident wrong ones.
   *
   * Why a non-English entry can never learn a correct alias today: `catalog_card` has no `locale`
   * column and the mirror is English-only, so every card she is offered in the picker IS an English
   * printing. Learning `ja:<jp code> → <english set>` therefore points a Japanese set code at an English
   * set by construction, and every later Japanese row of that set then resolves to whichever English
   * card happens to share the collector number — a wrong MATCH, not a miss, which is far worse because
   * nothing flags it.
   *
   * This has already happened on her data: `ja:m6 → swshp` is live, taught because TCGdex has no Battle
   * Academy set to point at. It fails safe only by luck — `swshp` does not happen to contain that card
   * number. And with no delete path for `set_alias` anywhere, one uncertain match is permanent.
   *
   * Correct under BOTH open answers to the product question this issue is blocked on. If a Japanese
   * printing is a distinct card, the alias is simply wrong. If it is the same card in another language,
   * a set-code alias is still the wrong mechanism — matching would go through locale-aware lookup, not
   * by pointing one locale's set code at another's set id. So the guard needs no decision from her.
   */
  let learnedAlias: ManualMatchResult["learnedAlias"] = null;
  let aliasSkippedReason: string | null = null;
  if (entry.reason === "UNKNOWN_SET") {
    const locale = normalizeLocale(entry.locale);
    const targetLocale = localeOfId(target.tcgdexId);
    const { rawCode } = parseDexId(entry.dex_id);
    if (locale !== targetLocale) {
      // UIL-047 C3, refined for 0016 (Senior BA): the guard is a locale MISMATCH, not "non-English".
      // A Japanese entry matched to a Japanese printing learns its set like English does; matched to
      // an English printing it still does not, because that cross-locale alias is exactly the
      // confident-wrong-match hazard C3 closed and a Japanese mirror does not remove it.
      aliasSkippedReason =
        `This card is pinned, but the set was not learned: the entry is ${locale} and the card you ` +
        `matched is an ${targetLocale} printing, so remembering this set would make every other ` +
        `${locale} card from it match an ${targetLocale} card with the same number. Those rows stay ` +
        `in the queue; match one to a ${locale} printing to teach the set.`;
    } else if (rawCode && target.setId) {
      ops.push({
        op: "upsert_set_alias",
        locale,
        dex_code: rawCode,
        tcgdex_set_id: target.setId,
        source: "manual",
      });
      learnedAlias = { locale, dexCode: rawCode, tcgdexSetId: target.setId };
    }
  }

  // Promote as ADDED: unplaced copies for the routing cascade. Identity pin, not a placement.
  const groupExisting = await presenceGroupRepo.findByKey(
    db,
    target.tcgdexId,
    entry.dex_variant_raw,
  );
  let groupId: string;
  if (groupExisting) {
    groupId = groupExisting.id;
  } else {
    groupId = crypto.randomUUID();
    ops.push({
      op: "insert_presence_group",
      id: groupId,
      catalog_card_id: target.tcgdexId,
      dex_variant_raw: entry.dex_variant_raw,
      desired_count: 0,
    });
  }

  /**
   * HOW MANY COPIES (UIL-099 E2). The row's quantity as presence counts it (`dexQuantity`, the import's own
   * normaliser), so a match and the next import of the same row cannot count it two ways. The quantity is
   * already at least 1 here: `parseQuantity` reads a blank or 0 cell as one copy before a row parks.
   *
   * MINUS what she removed of this key (E2). `removed_presence` is what stops an import handing back a card
   * she removed while Dex still lists it (UIL-089), and a manual match is an import of one row that never
   * read it, so matching a row for a card she had traded away silently re-created it. The memory itself is
   * left alone: the next import subtracts it from the same key again, so the two agree, and
   * `restoreWithheldForEntry` is the visible way to take a removal back.
   *
   * THE DIFFERENCE, NOT THE QUANTITY (E1). Once an import is recorded, the key must end holding what Dex
   * lists for it — the record plus this row — minus what she removed: max(0, record + qty − removed). The
   * match inserts only what is missing from that, so a second Dex row onto a key that already has copies
   * adds up instead of stacking, and a removal already spent against another row's copies is not spent
   * again. `withheld` is what the removal kept back, the part of `qty` not inserted. Before any import is
   * recorded there is nothing to be exact against, and the match withholds up to `removed` of its own rows.
   *
   * ONLY ON A KEY THAT ADDS UP BEFORE THE MATCH. A key already holding more or fewer copies than Dex lists
   * minus removals is not repaired silently by a match that happens to touch it: the match inserts as the
   * unrecorded rule would, and UIL-100's check refuses it with the re-import remedy, because a disagreement
   * is surfaced and repaired through an import she previews, never absorbed (the Tech Lead's design).
   */
  const qty = dexQuantity(entry.quantity);
  const matchedKey = { catalog_card_id: target.tcgdexId, dex_variant_raw: entry.dex_variant_raw };
  const k = await keyState(db, target.tcgdexId, entry.dex_variant_raw, groupExisting?.id ?? null);
  const addsUp = k.current === Math.max(0, k.record - k.removed);
  const created =
    k.armed && addsUp
      ? Math.max(0, Math.max(0, k.record + qty - k.removed) - k.current)
      : qty - Math.min(qty, k.removed);
  const withheld = qty - created;
  for (let i = 0; i < created; i++) {
    ops.push({
      op: "insert_copy",
      id: matchCopyId(entry, i),
      catalog_card_id: target.tcgdexId,
      variant: "normal",
      dex_variant_raw: entry.dex_variant_raw,
      presence_group_id: groupId,
      // A manual or stand-in match identifies the card; it does not place it (UIL-088).
      role: "haul",
      acquired_at: now,
    });
  }

  ops.push({
    op: "update_unresolved_entry",
    id: entry.id,
    patch: {
      status: "RESOLVED",
      manual_match_id: target.tcgdexId,
      last_retry_sync: now,
      retry_count: entry.retry_count + 1,
    },
  });

  /**
   * UIL-100: the matched Dex row moves from "waiting" into the Dex record, and THE CHECK runs on this card
   * last, in the same transaction. The record takes the row's Dex quantity, never the copies inserted: the
   * check compares copies with what Dex SAID, minus what she removed, which is what `created` produces.
   * If the card already disagrees with Dex (a copy she already holds), the match is refused and says so.
   */
  ops.push({ op: "add_dex_presence", ...matchedKey, quantity: qty });
  ops.push({ op: "assert_presence_counts", keys: [matchedKey] });

  return {
    ops,
    groupId,
    result: {
      learnedAlias,
      aliasSkippedReason,
      created,
      withheld:
        withheld > 0
          ? {
              count: withheld,
              catalogCardId: target.tcgdexId,
              dexVariantRaw: entry.dex_variant_raw,
            }
          : null,
    },
  };
}

/**
 * Manual-match a stubborn entry to a catalog card (A.8). Pins the identity (never a placement),
 * creates the unplaced copies, marks the entry RESOLVED, and — when the miss was UNKNOWN_SET —
 * learns the `(locale, dexCode) → tcgdexSetId` alias so the rest of that set drains on the next
 * retry ("one match drains the set"). Applied in one transaction.
 *
 * APPLIED ONCE (UIL-099). A row already matched to this card writes nothing and says so; a row resolved any
 * other way is refused (`alreadyMatched`). Two presses that race past that check collide on the derived copy
 * ids, or on presence_group's unique key when both would create the group, and the loser re-reads the row to
 * tell "the other press landed" from a real failure — never the error text (#325's lesson).
 */
export async function manualMatch(
  db: DbClient,
  entryId: string,
  tcgdexId: string,
): Promise<ManualMatchResult> {
  const entry = await unresolvedEntryRepo.getByPk(db, entryId);
  if (!entry) throw new Error("Unresolved entry not found.");
  const card = await catalogCardRepo.getByPk(db, tcgdexId);
  if (!card) throw new Error("Catalog card not found.");
  if (entry.status === "RESOLVED") {
    if (entry.manual_match_id === tcgdexId) return alreadyMatchedResult();
    refuseResolved(entry);
  }

  const { ops, groupId, result } = await matchOps(
    db,
    entry,
    { tcgdexId, setId: card.set_id },
    nowIso(),
  );
  try {
    await applyWriteOps(db, { ops, resyncGroupIds: [groupId] });
  } catch (err) {
    // A press that raced this one and landed first is success, not a failure (#325's lesson: re-read the
    // row, never the error text). Only then is it the count check refusing, or a real failure.
    const now = await unresolvedEntryRepo.getByPk(db, entryId);
    if (now?.status === "RESOLVED" && now.manual_match_id === tcgdexId)
      return alreadyMatchedResult();
    throw (await asCountRefusal(db, err, NEXT_STEP.match)) ?? err;
  }
  return result;
}

export interface RestoreWithheldResult {
  /** Copies added back to her haul. */
  restored: number;
  /** True when this row's held-back cards were already added back, so nothing was written. */
  alreadyRestored?: boolean;
}

/** Why "Add it back" is refused (UIL-099 E2). */
export const RESTORE_REFUSED = {
  notMatched:
    "This row is not matched to a card, so there is nothing to add back. Reload the Sync page.",
} as const;

/** Derived like `matchCopyId`, so a double-pressed "Add it back" collides instead of adding twice. */
function restoreCopyId(entry: Row<"unresolved_entry">, i: number): string {
  return derivedUuid(`restore:${entry.id}:${entry.retry_count}:${i}`);
}

/**
 * "Add it back" (UIL-099 E2): the cards a manual match held back because she had removed them, returned to
 * her haul, with the removal memory shrunk by the same number in the SAME transaction. Afterwards the key
 * holds what Dex lists, and the next import agrees, because it subtracts the smaller memory.
 *
 * Recomputed here rather than trusted from the screen: at most the row's own quantity, and at most what the
 * memory still holds.
 *
 * ONCE per match. The copies are written at ids derived from the entry, so a second press — sequential or
 * racing — finds (or collides with) the first press's copy and reports `alreadyRestored` instead of adding
 * more, which matters most when she removed more of this card than this row lists.
 */
export async function restoreWithheldForEntry(
  db: DbClient,
  entryId: string,
): Promise<RestoreWithheldResult> {
  const entry = await unresolvedEntryRepo.getByPk(db, entryId);
  if (!entry || entry.status !== "RESOLVED" || !entry.manual_match_id) {
    throw new Error(RESTORE_REFUSED.notMatched);
  }
  const catalogCardId = entry.manual_match_id;
  const dexVariantRaw = entry.dex_variant_raw;
  const firstId = restoreCopyId(entry, 0);
  if (await copyRepo.getByPk(db, firstId)) return { restored: 0, alreadyRestored: true };

  const group = await presenceGroupRepo.findByKey(db, catalogCardId, dexVariantRaw);
  if (!group) throw new Error(RESTORE_REFUSED.notMatched);
  const k = await keyState(db, catalogCardId, dexVariantRaw, group.id);
  const restore = Math.min(dexQuantity(entry.quantity), k.removed);
  if (restore === 0) return { restored: 0 };
  /**
   * What the memory must shrink to so the key adds up afterwards. Recorded: the key will hold
   * current + restore copies against a record that lists `record`, so the memory is whatever of the record
   * is still NOT held — which can be less than `removed − restore`, because a memory may exceed what Dex now
   * lists (the import never shrinks one while Dex still names the key). Not recorded — or a key that does
   * not add up before, which the check then refuses rather than this absorbing — by what came back.
   */
  const addsUp = k.current === Math.max(0, k.record - k.removed);
  const newMemory =
    k.armed && addsUp ? Math.max(0, k.record - (k.current + restore)) : k.removed - restore;
  const shrinkBy = k.removed - newMemory;

  const now = nowIso();
  const ops: WriteOp[] = [];
  for (let i = 0; i < restore; i++) {
    ops.push({
      op: "insert_copy",
      id: restoreCopyId(entry, i),
      catalog_card_id: catalogCardId,
      variant: "normal",
      dex_variant_raw: dexVariantRaw,
      presence_group_id: group.id,
      role: "haul",
      acquired_at: now,
    });
  }
  // Column-computed (0022's `shrink_removed_presence`): the row is deleted when the shrink takes it to
  // zero or below, since the table refuses a count below 1.
  if (shrinkBy > 0) {
    ops.push({
      op: "shrink_removed_presence",
      catalog_card_id: catalogCardId,
      dex_variant_raw: dexVariantRaw,
      by: shrinkBy,
    });
  }
  // THE CHECK, last (UIL-100): a no-op until an import is recorded.
  ops.push({
    op: "assert_presence_counts",
    keys: [{ catalog_card_id: catalogCardId, dex_variant_raw: dexVariantRaw }],
  });
  try {
    await applyWriteOps(db, { ops, resyncGroupIds: [group.id] });
  } catch (err) {
    if (await copyRepo.getByPk(db, firstId)) return { restored: 0, alreadyRestored: true };
    throw (await asCountRefusal(db, err, NEXT_STEP.restore)) ?? err;
  }
  return { restored: restore };
}

/**
 * The TCGdex set id a stand-in for `entry` should carry, or null. The form prefills it rather than asking:
 * the resolver already knows the set for an UNKNOWN_CARD entry (a passthrough code the mirror has, or a
 * learned alias); for an UNKNOWN_SET entry nothing is known and null is the honest answer. "Known" means
 * the mirror actually holds cards of that set, not merely that a code parsed.
 */
export async function knownSetIdForEntry(
  db: DbClient,
  entry: Row<"unresolved_entry">,
): Promise<string | null> {
  const aliasMap = await loadAliasMap(db);
  const resolved = resolveDexId(entryAsDexRow(entry), aliasMap);
  if (!resolved.setId) return null;
  return (await catalogCardRepo.setExists(db, resolved.setId)) ? resolved.setId : null;
}

export interface StandInMatchResult extends ManualMatchResult {
  /** The id the stand-in was created under (`user:<uuid>`). */
  standInId: string;
}

/**
 * Create a STAND-IN catalog card for a card TCGdex lacks and match the entry to it, in ONE transaction
 * (UIL-060 Half 1). The stand-in is the first op; if anything after it fails, it never existed. A twin
 * (a stand-in she already made with the same name, set and number) is refused with the existing one
 * offered instead — see `StandInTwinError`.
 */
export async function manualMatchStandIn(
  db: DbClient,
  entryId: string,
  input: StandInInput,
): Promise<StandInMatchResult> {
  const entry = await unresolvedEntryRepo.getByPk(db, entryId);
  if (!entry) throw new Error("Unresolved entry not found.");
  if (!input.name.trim()) throw new Error("A stand-in needs a name.");

  const twin = (await catalogCardRepo.listStandIns(db)).find(
    (c) =>
      norm(c.name) === norm(input.name) &&
      norm(c.set_name) === norm(input.setName) &&
      norm(c.local_id) === norm(input.localId),
  );
  // Applied once, like `manualMatch` (UIL-099): a second press on a row already matched to THIS stand-in is
  // that match landing, not a twin; any other resolution is refused before a second stand-in is made.
  if (entry.status === "RESOLVED") {
    if (twin && entry.manual_match_id === twin.tcgdex_id) {
      return { ...alreadyMatchedResult(), standInId: twin.tcgdex_id };
    }
    refuseResolved(entry);
  }
  if (twin) throw new StandInTwinError(twin);

  const standInId = newStandInId();
  const k = input.kind;
  const ops: WriteOp[] = [
    {
      op: "insert_catalog_stand_in",
      tcgdex_id: standInId,
      name: input.name.trim(),
      set_id: input.setId,
      set_name: input.setName,
      local_id: input.localId,
      dex_id: k.kind === "pokemon" && k.dexId ? [k.dexId] : [],
      types: k.kind === "pokemon" ? [k.type] : [],
      stage: k.kind === "pokemon" ? k.stage : null,
      card_class: input.cardClass ?? "standard",
    },
  ];
  const match = await matchOps(db, entry, { tcgdexId: standInId, setId: input.setId }, nowIso());
  ops.push(...match.ops);
  try {
    await applyWriteOps(db, { ops, resyncGroupIds: [match.groupId] });
  } catch (err) {
    // A racing second press: its stand-in rolled back with the rest of its transaction, so the row's
    // match is the one that landed. Re-read, as `manualMatch` does; then the count check; then rethrow.
    const now = await unresolvedEntryRepo.getByPk(db, entryId);
    if (now?.status === "RESOLVED" && now.manual_match_id && isStandInId(now.manual_match_id)) {
      return { ...alreadyMatchedResult(), standInId: now.manual_match_id };
    }
    throw (await asCountRefusal(db, err, NEXT_STEP.match)) ?? err;
  }
  return { ...match.result, standInId };
}

export interface ForgetAliasResult {
  alias: LearnedAlias;
  /** WAITING entries moved from UNKNOWN_CARD back to UNKNOWN_SET in the same transaction. */
  reparked: number;
}

/**
 * Forget a learned set alias (UIL-047 C3, second half) — the inverse of the alias `manualMatch` learns.
 * Drops the `(locale, dexCode)` row and, in the SAME transaction, re-parks the set's WAITING
 * UNKNOWN_CARD entries as UNKNOWN_SET: without the alias their set is not known, so "needs your match"
 * would be a false promise (migration 0014's header). Copies and RESOLVED entries are untouched — a card
 * she matched by hand is a card she identified; the alias was only that match's side effect. The
 * decision of what to re-park lives in lib/sync/alias.ts; this is the I/O around it.
 */
export async function forgetSetAlias(
  db: DbClient,
  locale: string,
  dexCode: string,
): Promise<ForgetAliasResult> {
  const row = await setAliasRepo.getByCode(db, locale, dexCode);
  if (!row) throw new Error("That set alias is already gone.");
  const alias: LearnedAlias = {
    locale: row.locale,
    dexCode: row.dex_code,
    tcgdexSetId: row.tcgdex_set_id,
  };
  const waiting = await unresolvedEntryRepo.listWaiting(db);
  const ops = buildForgetAliasOps(alias, waiting);
  await applyWriteOps(db, { ops });
  return { alias, reparked: ops.length - 1 };
}

/** Dismiss a WAITING entry — excluded from auto-retry, kept so a re-export doesn't re-park it (A.4). */
export async function dismissEntry(db: DbClient, entryId: string): Promise<void> {
  await unresolvedEntryRepo.update(db, entryId, { status: "DISMISSED" });
}

/** Un-dismiss — back to WAITING and the auto-retry sweep (A.4). */
export async function undismissEntry(db: DbClient, entryId: string): Promise<void> {
  await unresolvedEntryRepo.update(db, entryId, { status: "WAITING" });
}
