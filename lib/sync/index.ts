/**
 * Sync engine public surface (dev-spec §5 M4 + M9). M4 shipped the frozen reconciliation core
 * (csv / resolve / catalog-lookup / diff / reconcile); M9 adds the apply / undo / preview layers and
 * the I/O pipeline + executor that wrap them into the user-facing sync flow. Import from here.
 */
export * from "./types";
export * from "./reconcile";
export { presenceKey } from "./diff";
export * from "./apply";
export * from "./removal-source";
export * from "./removal-answers";
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
  manualMatchStandIn,
  restoreWithheldForEntry,
  restoreRemovedCard,
  MATCH_REFUSED,
  RESTORE_REFUSED,
  RESTORE_REMOVED_REFUSED,
  knownSetIdForEntry,
  newStandInId,
  isStandInId,
  STAND_IN_ID_PREFIX,
  StandInTwinError,
  findStandInTwin,
  forgetSetAlias,
  dismissEntry,
  undismissEntry,
  type ApplyResult,
  type UndoResult,
  type ManualMatchResult,
  type RestoreWithheldResult,
  type WithheldForRemoval,
  type StandInInput,
  type StandInMatchResult,
  type ForgetAliasResult,
} from "./exec";
export * from "./alias";
export * from "./stand-in-swap";
