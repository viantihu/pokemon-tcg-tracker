"use server";

/**
 * Server actions for the Sync screen (dev-spec §5 M9; sync-ui-spec §A + §B). Thin callers of the
 * M4/M9 sync engine (`@/lib/sync`): parse+reconcile a preview, apply (fast-path or gated) with the
 * single undo snapshot, undo, retry the unresolved queue, and the manual-match / dismiss actions.
 *
 * All DB access is owner-scoped through the auth seam (`await getOwnerContext()` — RLS on
 * `auth.uid()`; see lib/plan/session.ts). The client never touches TCGdex; the manual-match picker
 * searches the LOCAL mirror via the shared `lookupCatalog` action.
 */

import { getOwnerContext } from "@/lib/plan";
import {
  aliasKey,
  dismissEntry,
  entryAliasKey,
  executeApply,
  executeUndo,
  fastPathNotification,
  forgetSetAlias,
  manualMatch,
  reparkCandidates,
  runSyncPipeline,
  undismissEntry,
  type SyncOverrides,
  type SyncPlanBundle,
  type SyncPreview,
} from "@/lib/sync";
import {
  applyWriteOps,
  lastSyncSnapshotRepo,
  setAliasRepo,
  unresolvedEntryRepo,
  type DbClient,
  type Row,
} from "@/lib/repo";
import type { AppliedSnapshot } from "@/lib/sync";
import { errorMessage } from "@/lib/errors";
import { lookupCatalog } from "../plan/actions";
import type { LookupCard } from "../plan/plan-types";
import type {
  ActionError,
  ApplyOutcome,
  LearnedAliasView,
  QueueEntryView,
  SyncState,
} from "./sync-types";

type PreviewOk = { ok: true; preview: SyncPreview; bundle: SyncPlanBundle };

/** Parse + reconcile an uploaded Dex CSV into a preview + apply bundle. Mutates nothing (B.6). */
export async function previewSync(formData: FormData): Promise<PreviewOk | ActionError> {
  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false, error: "Point at your Dex export CSV first." };
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength === 0) return { ok: false, error: "That file is empty." };
    const { db } = await getOwnerContext();
    const { bundle, preview } = await runSyncPipeline(db, bytes);
    return { ok: true, preview, bundle };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * Apply a plan bundle (fast-path auto-apply or a confirmed gated preview). Writes the single undo
 * snapshot and returns the fast-path notification text (B.1, B.4).
 */
export async function applySync(
  bundle: SyncPlanBundle,
  overrides?: SyncOverrides,
): Promise<ApplyOutcome | ActionError> {
  try {
    const { db } = await getOwnerContext();
    const r = await executeApply(db, bundle, overrides);
    return {
      ok: true,
      added: r.added,
      removed: r.removed,
      variantChanges: r.variantChanges,
      waiting: r.waiting,
      fastPath: r.fastPath,
      notification: fastPathNotification(r.added, r.waiting),
    };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Undo the most-recent sync — restores exactly the pre-apply state (B.5). */
export async function undoLastSync(): Promise<{ ok: true } | ActionError> {
  try {
    const { db } = await getOwnerContext();
    await executeUndo(db);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * Retry the unresolved queue against the refreshed catalog + learned aliases (A.5). Promotes every
 * WAITING entry that now resolves as an ADDED (fast-path) and applies.
 *
 * ALSO STAMPS THE ATTEMPT ON THE ENTRIES THAT DID NOT RESOLVE (UIL-046). The self-heal itself always
 * worked — an entry that becomes resolvable is promoted on this path and on a full import — but nothing
 * ever recorded a retry against a row that stayed waiting. So the queue told her "self-heals when the
 * catalog catches up" while showing every waiting row as never retried, forever. The promise was kept
 * and the evidence of it was missing, which from her side is indistinguishable from a dead feature.
 *
 * `last_retry_sync` and `retry_count` already existed on the table and were already surfaced by
 * `toEntryView` — they were simply never written on this path. No migration.
 *
 * Stamped even when `promoted === 0`, which is the whole point: that is exactly the case that used to
 * return without recording anything. One `apply_write_ops` call, so the sweep is atomic with itself.
 */
export async function retryUnresolvedNow(): Promise<
  { ok: true; promoted: number; applied: boolean; stamped: number } | ActionError
> {
  try {
    const { db } = await getOwnerContext();
    const { bundle } = await runSyncPipeline(db, null);
    const promoted = bundle.queue.archiveEntryIds.length;

    // Every WAITING row this sweep looked at and did NOT promote. Read before the apply, because
    // applying archives the promoted ones and would leave nothing to distinguish them by.
    const promotedIds = new Set(bundle.queue.archiveEntryIds);
    const stillWaiting = (await unresolvedEntryRepo.listWaiting(db)).filter(
      (e) => !promotedIds.has(e.id),
    );

    if (promoted > 0) await executeApply(db, bundle);

    const stamped = await stampRetrySweep(db, stillWaiting);
    return { ok: true, promoted, applied: promoted > 0, stamped };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * Record that a retry sweep examined these entries and none of them resolved (UIL-046).
 *
 * Deliberately a separate write from the apply above rather than folded into its payload: a stamp is
 * telemetry, and it must not be able to fail a promotion that genuinely succeeded, nor be rolled back by
 * one. The reverse also holds — if the stamp fails, the promotion still stands.
 */
async function stampRetrySweep(db: DbClient, entries: Row<"unresolved_entry">[]): Promise<number> {
  if (entries.length === 0) return 0;
  const now = new Date().toISOString();
  await applyWriteOps(db, {
    ops: entries.map((e) => ({
      op: "update_unresolved_entry" as const,
      id: e.id,
      patch: { last_retry_sync: now, retry_count: e.retry_count + 1 },
    })),
  });
  return entries.length;
}

function toEntryView(e: Row<"unresolved_entry">): QueueEntryView {
  return {
    id: e.id,
    dexId: e.dex_id,
    dexName: e.dex_name ?? "",
    dexSetName: e.dex_set_name ?? "",
    dexSeries: e.dex_series ?? "",
    dexNumber: e.dex_number ?? "",
    dexVariantRaw: e.dex_variant_raw,
    quantity: e.quantity,
    locale: e.locale ?? "",
    reason: e.reason === "UNKNOWN_SET" ? "UNKNOWN_SET" : "UNKNOWN_CARD",
    status:
      e.status === "DISMISSED" ? "DISMISSED" : e.status === "RESOLVED" ? "RESOLVED" : "WAITING",
    firstSeenSync: e.first_seen_sync,
    lastRetrySync: e.last_retry_sync,
    retryCount: e.retry_count,
    manualMatchId: e.manual_match_id,
    aliasKey: entryAliasKey(e),
  };
}

/**
 * Every learned alias with what forgetting it would do (UIL-047 C3). `reparks` is computed by the same
 * function the forget action uses to build its write set, so the number the panel warns with is the
 * number the action will change. The Dex set name comes from any queue entry (any status) carrying the
 * code — the alias row itself stores only the code.
 */
function toAliasViews(
  aliases: Row<"set_alias">[],
  entries: Row<"unresolved_entry">[],
): LearnedAliasView[] {
  const dexSetNameByKey = new Map<string, string>();
  for (const e of entries) {
    const k = entryAliasKey(e);
    if (e.dex_set_name && !dexSetNameByKey.has(k)) dexSetNameByKey.set(k, e.dex_set_name);
  }
  const rank = (a: LearnedAliasView) => (a.source === "manual" ? 0 : 1);
  return aliases
    .map((a) => {
      const alias = { locale: a.locale, dexCode: a.dex_code };
      return {
        locale: a.locale,
        dexCode: a.dex_code,
        tcgdexSetId: a.tcgdex_set_id,
        source: a.source === "name-resolved" ? ("name-resolved" as const) : ("manual" as const),
        createdAt: a.created_at,
        dexSetName: dexSetNameByKey.get(aliasKey(a.locale, a.dex_code)) ?? null,
        reparks: reparkCandidates(entries, alias).length,
      };
    })
    .sort((x, y) => rank(x) - rank(y) || y.createdAt.localeCompare(x.createdAt));
}

/**
 * Load the queue (grouped by reason + dismissed), the learned aliases, and the undo status for the
 * screen (A.9, B.5; UIL-047 C3).
 */
export async function loadSyncState(): Promise<SyncState> {
  const { db } = await getOwnerContext();
  const [entries, snapshots, aliases] = await Promise.all([
    unresolvedEntryRepo.list(db),
    lastSyncSnapshotRepo.list(db),
    setAliasRepo.list(db),
  ]);

  const waiting = entries.filter((e) => e.status === "WAITING").map(toEntryView);
  const dismissed = entries.filter((e) => e.status === "DISMISSED").map(toEntryView);

  const snap = snapshots[0]?.snapshot as unknown as AppliedSnapshot | undefined;
  return {
    waiting: {
      unknownSet: waiting.filter((e) => e.reason === "UNKNOWN_SET"),
      unknownCard: waiting.filter((e) => e.reason === "UNKNOWN_CARD"),
    },
    dismissed,
    counts: { waiting: waiting.length, dismissed: dismissed.length },
    undo: {
      available: snapshots.length > 0,
      createdAt: snap?.createdAt ?? null,
      summary: snap?.counts ?? null,
    },
    aliases: toAliasViews(aliases, entries),
  };
}

/**
 * Forget a learned set alias (UIL-047 C3, second half). One transaction: the alias row goes, and the
 * set's WAITING "needs your match" entries go back to "waiting on catalog". Re-teaching is the existing
 * path — match any card from that set by hand.
 */
export async function forgetSetAliasAction(
  locale: string,
  dexCode: string,
): Promise<{ ok: true; reparked: number } | ActionError> {
  try {
    const { db } = await getOwnerContext();
    const r = await forgetSetAlias(db, locale, dexCode);
    return { ok: true, reparked: r.reparked };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Manual-match an entry to a catalog card; learns the set alias when the set was unknown (A.8). */
export async function manualMatchEntry(
  entryId: string,
  tcgdexId: string,
): Promise<{ ok: true; drainedSet: boolean } | ActionError> {
  try {
    const { db } = await getOwnerContext();
    const r = await manualMatch(db, entryId, tcgdexId);
    return { ok: true, drainedSet: r.learnedAlias !== null };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function dismissEntryAction(entryId: string): Promise<{ ok: true } | ActionError> {
  try {
    const { db } = await getOwnerContext();
    await dismissEntry(db, entryId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function undismissEntryAction(entryId: string): Promise<{ ok: true } | ActionError> {
  try {
    const { db } = await getOwnerContext();
    await undismissEntry(db, entryId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Catalog type-ahead for the manual-match picker — reuses the intake mirror search (M6). */
export async function searchCatalog(query: string): Promise<LookupCard[]> {
  return lookupCatalog(query);
}
