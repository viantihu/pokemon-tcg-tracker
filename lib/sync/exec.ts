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
  lastSyncSnapshotRepo,
  lineSlotRepo,
  presenceGroupRepo,
  setAliasRepo,
  unresolvedEntryRepo,
} from "@/lib/repo";
import { releaseSlotOps } from "@/lib/line/move";
import { parseDexId } from "./resolve";
import { buildForgetAliasOps, type LearnedAlias } from "./alias";
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

/**
 * Apply a plan bundle: fold in the preview overrides, then build + apply (in one transaction) the
 * copy/placement/queue writes and the single undo snapshot (B.4).
 */
export async function executeApply(
  db: DbClient,
  bundle: SyncPlanBundle,
  overrides?: SyncOverrides,
): Promise<ApplyResult> {
  const plan = applyOverrides(bundle.plan, bundle.current, overrides);
  const now = nowIso();

  const ops: WriteOp[] = [];
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
      role: "bulk", // unplaced: not shelved anywhere until the cascade routes it
      acquired_at: now,
    });
    createdCopyIds.push(id);
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

  // 7. Write the single undo snapshot LAST (overwrite-per-owner) as part of the same transaction.
  const fastPath = plan.retires.length === 0 && plan.variantUpdates.length === 0;
  const snapshot: AppliedSnapshot = {
    version: 1,
    createdAt: now,
    fastPath,
    counts: bundle.counts,
    createdCopyIds,
    retiredCopies,
    slotReverts,
    variantReverts,
    touchedGroupIds: [...touchedGroupIds],
    queue: q,
  };
  const prior = await lastSyncSnapshotRepo.list(db);
  for (const pr of prior) ops.push({ op: "delete_snapshot", id: pr.id });
  const snapshotId = crypto.randomUUID();
  ops.push({ op: "insert_snapshot", id: snapshotId, snapshot: snapshot as unknown as Json });

  // 8. Touched groups' desired_count is recomputed by the RPC after all copy writes (§C).
  await applyWriteOps(db, { ops, resyncGroupIds: [...touchedGroupIds] });

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
  const snapshots = await lastSyncSnapshotRepo.list(db);
  if (snapshots.length === 0) {
    throw new Error("Nothing to undo — the last sync's undo point is gone.");
  }
  const snap = snapshots[0].snapshot as unknown as AppliedSnapshot;
  const undo = invertSnapshot(snap);

  const ops: WriteOp[] = [];

  // Restore queue first (no FK dependence on copies).
  for (const e of undo.reinsertEntries) ops.push(reinsertEntryOp(e));
  for (const p of undo.restoreEntries) {
    ops.push({
      op: "update_unresolved_entry",
      id: p.id,
      patch: {
        status: p.status,
        quantity: p.quantity,
        retry_count: p.retry_count,
        last_retry_sync: p.last_retry_sync,
        reason: p.reason,
        manual_match_id: p.manual_match_id,
      },
    });
  }
  for (const id of undo.deleteEntryIds) ops.push({ op: "delete_unresolved_entry", id });

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
  // Remove the copies the sync created.
  for (const id of undo.deleteCopyIds) ops.push({ op: "delete_copy", id });

  // Undo consumed the snapshot: the undo point is now gone.
  ops.push({ op: "delete_snapshot", id: snapshots[0].id });

  await applyWriteOps(db, { ops, resyncGroupIds: undo.resyncGroupIds });

  return {
    restoredCopies: undo.reinsertCopies.length,
    removedCopies: undo.deleteCopyIds.length,
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
}

/**
 * Manual-match a stubborn entry to a catalog card (A.8). Pins the identity (never a placement),
 * creates the unplaced copies, marks the entry RESOLVED, and — when the miss was UNKNOWN_SET —
 * learns the `(locale, dexCode) → tcgdexSetId` alias so the rest of that set drains on the next
 * retry ("one match drains the set"). Applied in one transaction.
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

  const now = nowIso();
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
    const locale = entry.locale === "ja" || entry.locale === "Japanese" ? "ja" : "en";
    const { rawCode } = parseDexId(entry.dex_id);
    if (locale !== "en") {
      aliasSkippedReason =
        `This card is pinned, but the set was not learned: the entry is ${locale} and the catalog ` +
        `holds only English printings, so remembering this set would make every other ${locale} card ` +
        `from it match an English card with the same number. Those rows stay in the queue instead.`;
    } else if (rawCode && card.set_id) {
      ops.push({
        op: "upsert_set_alias",
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
    groupId = crypto.randomUUID();
    ops.push({
      op: "insert_presence_group",
      id: groupId,
      catalog_card_id: tcgdexId,
      dex_variant_raw: entry.dex_variant_raw,
      desired_count: 0,
    });
  }

  const qty = Math.max(1, entry.quantity);
  for (let i = 0; i < qty; i++) {
    ops.push({
      op: "insert_copy",
      id: crypto.randomUUID(),
      catalog_card_id: tcgdexId,
      variant: "normal",
      dex_variant_raw: entry.dex_variant_raw,
      presence_group_id: groupId,
      role: "bulk",
      acquired_at: now,
    });
  }

  ops.push({
    op: "update_unresolved_entry",
    id: entryId,
    patch: {
      status: "RESOLVED",
      manual_match_id: tcgdexId,
      last_retry_sync: now,
      retry_count: entry.retry_count + 1,
    },
  });

  await applyWriteOps(db, { ops, resyncGroupIds: [groupId] });

  return { learnedAlias, aliasSkippedReason, created: qty };
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
