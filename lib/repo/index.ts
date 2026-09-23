/**
 * Typed data-access layer (dev-spec §5 M1). One module per aggregate; callers pass a `DbClient`.
 * Import repos from here rather than reaching into `db.from(...)` anywhere else.
 */
export type { DbClient, TableName, ViewName, Row, Insert, Update, ViewRow } from "./base";
export { createRepo } from "./base";
export type { Database, Json } from "./database.types";
export { applyWriteOps } from "./write-ops";
export type {
  WriteOp,
  WritePayload,
  CopyPatch,
  SlotPatch,
  LinePatch,
  EntryPatch,
} from "./write-ops";

export { catalogCardRepo } from "./catalog-card";
export { copyRepo, removedPresenceRepo } from "./copy";
export { binderRepo } from "./binder";
export { binderSectionRepo } from "./binder-section";
export { collectionRepo } from "./collection";
export { evolutionLineRepo } from "./evolution-line";
export { lineSlotRepo } from "./line-slot";
export { wishlistItemRepo } from "./wishlist-item";
export { binderBlockRepo } from "./binder-block";
export { haulRepo } from "./haul";
export { placementDecisionRepo } from "./placement-decision";
export { colorBandRepo, typeColorMapRepo } from "./config";
export { presenceGroupRepo, unresolvedEntryRepo, lastSyncSnapshotRepo, setAliasRepo } from "./sync";
