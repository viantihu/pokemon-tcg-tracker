/**
 * Sync executor (docs/sync-ui-spec.md §A.5, §A.8, §B.4–§B.5). I/O — applies a plan bundle, writes the
 * single undo snapshot, reverses it, and runs the queue's manual-match / dismiss actions. All writes
 * go through `lib/repo` under the RLS-scoped client the caller supplies (owner is `auth.uid()`).
 *
 * ATOMICITY (same seam as lib/plan/commit.ts): supabase-js has no cross-statement transaction and the
 * migrations dir is frozen, so a true all-or-nothing apply would need a Postgres RPC in a later
 * migration. Until then, writes run in dependency order and ANY failure triggers a compensating
 * rollback (reverse the writes already made) before rethrowing — a half-applied sync is never left
 * behind. FLAGGED as a seam. The undo snapshot (B.4) is the user-facing, durable equivalent.
 */
import type { DbClient, Insert, Json, Row } from "@/lib/repo";
import {
  catalogCardRepo,
  copyRepo,
  lastSyncSnapshotRepo,
  lineSlotRepo,
  presenceGroupRepo,
  setAliasRepo,
  unresolvedEntryRepo,
} from "@/lib/repo";
import { parseDexId } from "./resolve";
import { applyOverrides, type SyncOverrides } from "./apply";
import type { SyncPlanBundle } from "./pipeline";
import {
  invertSnapshot,
  type AppliedSnapshot,
  type SnapshotCopy,
  type SnapshotEntry,
  type SnapshotEntryPrior,
  type SnapshotSlot,
  type SnapshotVariantPrior,
} from "./undo";

/** Undo stack for the compensating rollback. Run in reverse on failure (mirrors commit.ts). */
class Rollback {
  private steps: Array<() => Promise<void>> = [];
  add(step: () => Promise<void>) {
    this.steps.push(step);
  }
  async run() {
    for (const step of this.steps.reverse()) {
      try {
        await step();
      } catch {
        // Best-effort: keep unwinding even if one compensation fails.
      }
    }
  }
}

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

/**
 * Apply a plan bundle: fold in the preview overrides, mutate copies/placement/queue in dependency
 * order under a compensating rollback, then write the single undo snapshot (B.4).
 */
export async function executeApply(
  db: DbClient,
  bundle: SyncPlanBundle,
  overrides?: SyncOverrides,
): Promise<ApplyResult> {
  const plan = applyOverrides(bundle.plan, bundle.current, overrides);

  const rb = new Rollback();
  const groupCache = new Map<string, string>();
  const touchedGroupIds = new Set<string>();

  const createdCopyIds: string[] = [];
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
    const row = await presenceGroupRepo.insert(db, {
      catalog_card_id: catalogCardId,
      dex_variant_raw: dexVariantRaw,
      desired_count: 0,
    });
    rb.add(() => presenceGroupRepo.remove(db, row.id));
    touchedGroupIds.add(row.id);
    groupCache.set(k, row.id);
    return row.id;
  }

  try {
    // 1. Archive WAITING entries whose cards now resolve (promotions — their copies come from creates).
    for (const id of bundle.queue.archiveEntryIds) {
      const e = await unresolvedEntryRepo.getByPk(db, id);
      if (!e) continue;
      q.archivedPrior.push(toEntryPrior(e));
      await unresolvedEntryRepo.update(db, id, { status: "RESOLVED", last_retry_sync: nowIso() });
      rb.add(async () => {
        await unresolvedEntryRepo.update(db, id, {
          status: e.status,
          last_retry_sync: e.last_retry_sync,
        });
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
      await copyRepo.update(db, copy.id, {
        variant: vu.toVariant,
        dex_variant_raw: vu.toVariantRaw,
        presence_group_id: toGroup,
      });
      rb.add(async () => {
        await copyRepo.update(db, copy.id, {
          variant: copy.variant,
          dex_variant_raw: copy.dex_variant_raw,
          presence_group_id: copy.presence_group_id,
        });
      });
    }

    // 3. Adds — create unplaced copies for the routing cascade (B.6 places them later).
    for (const c of plan.creates) {
      const groupId = await ensureGroup(c.catalogCardId, c.dexVariantRaw);
      const copy = await copyRepo.insert(db, {
        catalog_card_id: c.catalogCardId,
        variant: c.variant,
        dex_variant_raw: c.dexVariantRaw,
        presence_group_id: groupId,
        role: "bulk", // unplaced: not shelved anywhere until the cascade routes it
        acquired_at: nowIso(),
      });
      createdCopyIds.push(copy.id);
      rb.add(() => copyRepo.remove(db, copy.id));
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
          await lineSlotRepo.update(db, slot.id, { state: "placeholder", copy_id: null });
          rb.add(async () => {
            await lineSlotRepo.update(db, slot.id, { state: slot.state, copy_id: slot.copy_id });
          });
        }
      }
      await copyRepo.remove(db, copy.id);
      rb.add(async () => {
        await copyRepo.insert(db, toReinsert(copy));
      });
    }

    // 5. Park CSV rows still unresolved — deduped on (dex_id, dex_variant_raw) (A.6).
    const liveWaiting = await unresolvedEntryRepo.listWaiting(db);
    const waitingByKey = new Map(liveWaiting.map((e) => [`${e.dex_id} ${e.dex_variant_raw}`, e]));
    for (const p of bundle.queue.parks) {
      const prior = waitingByKey.get(`${p.dexId} ${p.dexVariantRaw}`);
      if (prior) {
        q.updatedPrior.push(toEntryPrior(prior));
        await unresolvedEntryRepo.update(db, prior.id, {
          quantity: p.quantity,
          reason: p.reason,
          retry_count: prior.retry_count + 1,
          last_retry_sync: nowIso(),
        });
        rb.add(async () => {
          await unresolvedEntryRepo.update(db, prior.id, {
            quantity: prior.quantity,
            reason: prior.reason,
            retry_count: prior.retry_count,
            last_retry_sync: prior.last_retry_sync,
          });
        });
      } else {
        const inserted = await unresolvedEntryRepo.insert(db, {
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
        q.parkedIds.push(inserted.id);
        rb.add(() => unresolvedEntryRepo.remove(db, inserted.id));
      }
    }

    // 6. Drop WAITING entries the export no longer contains — silent, never placed (A.7).
    for (const id of bundle.queue.dropEntryIds) {
      const e = await unresolvedEntryRepo.getByPk(db, id);
      if (!e) continue;
      q.droppedEntries.push(toSnapshotEntry(e));
      await unresolvedEntryRepo.remove(db, id);
      rb.add(async () => {
        await unresolvedEntryRepo.insert(db, toSnapshotEntry(e) as Insert<"unresolved_entry">);
      });
    }

    // 7. Resync each touched group's desired_count so the UI's counts stay honest (§C).
    for (const groupId of touchedGroupIds) await resyncGroupCount(db, groupId);

    // 8. Write the single undo snapshot LAST (overwrite-per-owner). If this throws, rb unwinds.
    const snapshot: AppliedSnapshot = {
      version: 1,
      createdAt: nowIso(),
      fastPath: plan.retires.length === 0 && plan.variantUpdates.length === 0,
      counts: bundle.counts,
      createdCopyIds,
      retiredCopies,
      slotReverts,
      variantReverts,
      touchedGroupIds: [...touchedGroupIds],
      queue: q,
    };
    const prior = await lastSyncSnapshotRepo.list(db);
    for (const p of prior) await lastSyncSnapshotRepo.remove(db, p.id);
    const row = await lastSyncSnapshotRepo.insert(db, { snapshot: snapshot as unknown as Json });

    return {
      snapshotId: row.id,
      added: plan.creates.length,
      removed: plan.retires.length,
      variantChanges: plan.variantUpdates.length,
      waiting: bundle.queue.stillWaiting,
      fastPath: snapshot.fastPath,
    };
  } catch (err) {
    await rb.run();
    throw err;
  }
}

/** Re-insert a copy verbatim (same id + placement) — used by rollback and by undo. */
function toReinsert(c: Row<"copy"> | SnapshotCopy) {
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

/** Set a presence group's desired_count to its live copy count (best-effort, non-fatal). */
async function resyncGroupCount(db: DbClient, groupId: string): Promise<void> {
  try {
    const copies = await copyRepo.listByPresenceGroup(db, groupId);
    await presenceGroupRepo.update(db, groupId, { desired_count: copies.length });
  } catch {
    // desired_count is a display convenience (§C); a resync miss must not fail the apply.
  }
}

export interface UndoResult {
  restoredCopies: number;
  removedCopies: number;
  revertedVariants: number;
}

/**
 * Undo the most-recent sync (B.5): one action restores the whole `AppliedSnapshot`. Available until
 * the next apply overwrites the snapshot; a pure local restore that never re-contacts Dex.
 */
export async function executeUndo(db: DbClient): Promise<UndoResult> {
  const snapshots = await lastSyncSnapshotRepo.list(db);
  if (snapshots.length === 0) {
    throw new Error("Nothing to undo — the last sync's undo point is gone.");
  }
  const snap = snapshots[0].snapshot as unknown as AppliedSnapshot;
  const ops = invertSnapshot(snap);

  const rb = new Rollback();
  try {
    // Restore queue first (no FK dependence on copies).
    for (const e of ops.reinsertEntries) {
      await unresolvedEntryRepo.insert(db, e as Insert<"unresolved_entry">);
      rb.add(() => unresolvedEntryRepo.remove(db, e.id));
    }
    for (const p of ops.restoreEntries) {
      await unresolvedEntryRepo.update(db, p.id, {
        status: p.status,
        quantity: p.quantity,
        retry_count: p.retry_count,
        last_retry_sync: p.last_retry_sync,
        reason: p.reason,
        manual_match_id: p.manual_match_id,
      });
    }
    for (const id of ops.deleteEntryIds) await unresolvedEntryRepo.remove(db, id);

    // Bring retired copies back (with placement), then re-point their freed slots.
    for (const c of ops.reinsertCopies) {
      await copyRepo.insert(db, toReinsert(c) as Insert<"copy">);
      rb.add(() => copyRepo.remove(db, c.id));
    }
    for (const s of ops.restoreSlots) {
      await lineSlotRepo.update(db, s.id, { state: s.state, copy_id: s.copy_id });
    }
    // Revert variant migrations.
    for (const v of ops.revertVariants) {
      await copyRepo.update(db, v.copyId, {
        variant: v.variant,
        dex_variant_raw: v.dexVariantRaw,
        presence_group_id: v.presenceGroupId,
      });
    }
    // Remove the copies the sync created.
    for (const id of ops.deleteCopyIds) await copyRepo.remove(db, id);

    for (const groupId of ops.resyncGroupIds) await resyncGroupCount(db, groupId);

    // Undo consumed the snapshot: the undo point is now gone.
    await lastSyncSnapshotRepo.remove(db, snapshots[0].id);

    return {
      restoredCopies: ops.reinsertCopies.length,
      removedCopies: ops.deleteCopyIds.length,
      revertedVariants: ops.revertVariants.length,
    };
  } catch (err) {
    await rb.run();
    throw err;
  }
}

export interface ManualMatchResult {
  learnedAlias: { locale: string; dexCode: string; tcgdexSetId: string } | null;
  created: number;
}

/**
 * Manual-match a stubborn entry to a catalog card (A.8). Pins the identity (never a placement),
 * creates the unplaced copies, marks the entry RESOLVED, and — when the miss was UNKNOWN_SET —
 * learns the `(locale, dexCode) → tcgdexSetId` alias so the rest of that set drains on the next
 * retry ("one match drains the set").
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

  const rb = new Rollback();
  try {
    // Learn the set alias when the set itself was unknown.
    let learnedAlias: ManualMatchResult["learnedAlias"] = null;
    if (entry.reason === "UNKNOWN_SET") {
      const locale = entry.locale === "ja" || entry.locale === "Japanese" ? "ja" : "en";
      const { rawCode } = parseDexId(entry.dex_id);
      if (rawCode && card.set_id) {
        await setAliasRepo.upsert(db, {
          locale,
          dex_code: rawCode,
          tcgdex_set_id: card.set_id,
          source: "manual",
        });
        learnedAlias = { locale, dexCode: rawCode, tcgdexSetId: card.set_id };
      }
    }

    // Promote as ADDED: unplaced copies for the routing cascade. Identity pin, not a placement.
    const groupExisting = await presenceGroupRepo.findByKey(db, tcgdexId, entry.dex_variant_raw);
    let groupId: string;
    if (groupExisting) {
      groupId = groupExisting.id;
    } else {
      const g = await presenceGroupRepo.insert(db, {
        catalog_card_id: tcgdexId,
        dex_variant_raw: entry.dex_variant_raw,
        desired_count: 0,
      });
      groupId = g.id;
      rb.add(() => presenceGroupRepo.remove(db, g.id));
    }

    const qty = Math.max(1, entry.quantity);
    for (let i = 0; i < qty; i++) {
      const copy = await copyRepo.insert(db, {
        catalog_card_id: tcgdexId,
        variant: "normal",
        dex_variant_raw: entry.dex_variant_raw,
        presence_group_id: groupId,
        role: "bulk",
        acquired_at: nowIso(),
      });
      rb.add(() => copyRepo.remove(db, copy.id));
    }
    await resyncGroupCount(db, groupId);

    await unresolvedEntryRepo.update(db, entryId, {
      status: "RESOLVED",
      manual_match_id: tcgdexId,
      last_retry_sync: nowIso(),
      retry_count: entry.retry_count + 1,
    });

    return { learnedAlias, created: qty };
  } catch (err) {
    await rb.run();
    throw err;
  }
}

/** Dismiss a WAITING entry — excluded from auto-retry, kept so a re-export doesn't re-park it (A.4). */
export async function dismissEntry(db: DbClient, entryId: string): Promise<void> {
  await unresolvedEntryRepo.update(db, entryId, { status: "DISMISSED" });
}

/** Un-dismiss — back to WAITING and the auto-retry sweep (A.4). */
export async function undismissEntry(db: DbClient, entryId: string): Promise<void> {
  await unresolvedEntryRepo.update(db, entryId, { status: "WAITING" });
}
