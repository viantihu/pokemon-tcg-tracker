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
  dismissEntry,
  executeApply,
  executeUndo,
  fastPathNotification,
  manualMatch,
  runSyncPipeline,
  undismissEntry,
  type SyncOverrides,
  type SyncPlanBundle,
  type SyncPreview,
} from "@/lib/sync";
import { lastSyncSnapshotRepo, unresolvedEntryRepo, type Row } from "@/lib/repo";
import type { AppliedSnapshot } from "@/lib/sync";
import { lookupCatalog } from "../plan/actions";
import type { LookupCard } from "../plan/plan-types";
import type { ActionError, ApplyOutcome, QueueEntryView, SyncState } from "./sync-types";

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
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Undo the most-recent sync — restores exactly the pre-apply state (B.5). */
export async function undoLastSync(): Promise<{ ok: true } | ActionError> {
  try {
    const { db } = await getOwnerContext();
    await executeUndo(db);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Retry the unresolved queue against the refreshed catalog + learned aliases (A.5). Promotes every
 * WAITING entry that now resolves as an ADDED (fast-path) and applies. A no-op when nothing resolves.
 */
export async function retryUnresolvedNow(): Promise<
  { ok: true; promoted: number; applied: boolean } | ActionError
> {
  try {
    const { db } = await getOwnerContext();
    const { bundle } = await runSyncPipeline(db, null);
    const promoted = bundle.queue.archiveEntryIds.length;
    if (promoted === 0) return { ok: true, promoted: 0, applied: false };
    await executeApply(db, bundle);
    return { ok: true, promoted, applied: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
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
  };
}

/** Load the queue (grouped by reason + dismissed) and the undo status for the screen (A.9, B.5). */
export async function loadSyncState(): Promise<SyncState> {
  const { db } = await getOwnerContext();
  const [entries, snapshots] = await Promise.all([
    unresolvedEntryRepo.list(db),
    lastSyncSnapshotRepo.list(db),
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
  };
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
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function dismissEntryAction(entryId: string): Promise<{ ok: true } | ActionError> {
  try {
    const { db } = await getOwnerContext();
    await dismissEntry(db, entryId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function undismissEntryAction(entryId: string): Promise<{ ok: true } | ActionError> {
  try {
    const { db } = await getOwnerContext();
    await undismissEntry(db, entryId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Catalog type-ahead for the manual-match picker — reuses the intake mirror search (M6). */
export async function searchCatalog(query: string): Promise<LookupCard[]> {
  return lookupCatalog(query);
}
