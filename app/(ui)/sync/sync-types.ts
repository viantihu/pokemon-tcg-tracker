import type { StandInInput } from "@/lib/sync";
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
  /**
   * `${locale}:${dexCode}` — the key this entry's set resolves through (lib/sync/alias.ts). Lets the
   * queue say WHICH learned alias a "needs your match" entry owes its known set to (UIL-047 C3).
   */
  aliasKey: string;
}

/** One learned `set_alias` row plus what forgetting it would do (UIL-047 C3, second half). */
export interface LearnedAliasView {
  locale: string;
  dexCode: string;
  tcgdexSetId: string;
  /** `manual` = she taught it by matching a card; `name-resolved` = the import matched the set name. */
  source: "manual" | "name-resolved";
  createdAt: string;
  /** The Dex export's own name for the set, from any queue entry carrying the code; null if none does. */
  dexSetName: string | null;
  /** WAITING entries that read "needs your match" only because of this alias; forgetting re-parks them. */
  reparks: number;
}

/** The queue + undo status the screen loads on mount and after every mutation (sync-ui-spec §A.9). */
import type { CountCheckView } from "@/lib/sync/count-check";

export interface SyncState {
  waiting: { unknownSet: QueueEntryView[]; unknownCard: QueueEntryView[] };
  /** Every card type the band map knows (type_color_map.card_type), for the stand-in form (UIL-060). */
  cardTypes: string[];
  dismissed: QueueEntryView[];
  counts: { waiting: number; dismissed: number };
  undo: { available: boolean; createdAt: string | null; summary: SyncCounts | null };
  /** Every learned alias, hers first (manual before name-resolved), newest first within each. */
  aliases: LearnedAliasView[];
  /** UIL-100: does the collection add up to her last Dex file, and which cards do not. */
  countCheck: CountCheckView;
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

/** What the stand-in form sends (UIL-060 Half 1). The set id is derived server-side, never typed. */
export type StandInFormInput = Omit<StandInInput, "setId">;

/** The stand-in action's answer: created and matched, a twin to match instead, or a plain failure. */
export type StandInOutcome =
  | { ok: true; standInId: string }
  | {
      ok: false;
      twin: { tcgdexId: string; name: string; setName: string | null; localId: string | null };
      error: string;
    }
  | ActionError;
