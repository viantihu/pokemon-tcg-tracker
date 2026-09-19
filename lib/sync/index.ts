/**
 * Sync engine public surface (dev-spec §5 M4 + M9). M4 shipped the frozen reconciliation core
 * (csv / resolve / catalog-lookup / diff / reconcile); M9 adds the apply / undo / preview layers and
 * the I/O pipeline + executor that wrap them into the user-facing sync flow. Import from here.
 */
export * from "./types";
export * from "./reconcile";
export { presenceKey } from "./diff";
export * from "./apply";
export * from "./undo";
export * from "./preview";
export {
  runSyncPipeline,
  loadCurrentGroups,
  type SyncMode,
  type SyncPlanBundle,
  type SyncRun,
} from "./pipeline";
export {
  executeApply,
  executeUndo,
  manualMatch,
  forgetSetAlias,
  dismissEntry,
  undismissEntry,
  type ApplyResult,
  type UndoResult,
  type ManualMatchResult,
  type ForgetAliasResult,
} from "./exec";
export * from "./alias";
