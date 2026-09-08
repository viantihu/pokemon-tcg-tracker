/**
 * Client/server shared view-models for the Sync screen (dev-spec §5 M9; sync-ui-spec §A.9, §B.6).
 * Plain serializable types only — no server imports — so the client component can hold them. The
 * richer engine types (SyncPreview, SyncPlanBundle) come from `@/lib/sync` via `import type`.
 */
import type { SyncCounts } from "@/lib/sync";

/** One unresolved-queue entry, flattened for the queue list + detail (sync-ui-spec §A.3). */
export interface QueueEntryView {
  id: string;
  dexId: string;
  dexName: string;
  dexSetName: string;
  dexSeries: string;
  dexNumber: string;
  dexVariantRaw: string;
  quantity: number;
  locale: string;
  reason: "UNKNOWN_SET" | "UNKNOWN_CARD";
  status: "WAITING" | "RESOLVED" | "DISMISSED";
  firstSeenSync: string;
  lastRetrySync: string | null;
  retryCount: number;
  manualMatchId: string | null;
}

/** The queue + undo status the screen loads on mount and after every mutation (sync-ui-spec §A.9). */
export interface SyncState {
  waiting: { unknownSet: QueueEntryView[]; unknownCard: QueueEntryView[] };
  dismissed: QueueEntryView[];
  counts: { waiting: number; dismissed: number };
  undo: { available: boolean; createdAt: string | null; summary: SyncCounts | null };
}

/** Result of an apply (fast-path or gated) — carries the fast-path notification text. */
export interface ApplyOutcome {
  ok: true;
  added: number;
  removed: number;
  variantChanges: number;
  waiting: number;
  fastPath: boolean;
  notification: string;
}

export type ActionError = { ok: false; error: string };
