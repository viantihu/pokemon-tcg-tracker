/**
 * Collections write logic — public surface (UIL-014, UIL-038, UIL-048).
 *
 * Removing a card from a collection is a MOVE plus a chase-list edit, applied as one transaction.
 * Logging a card must never create a second physical copy for one already owned. Creating/editing a
 * collection can be a draft, still missing a name or a binder. The pure op-building and the guards
 * that keep all three paths from stranding, duplicating, or losing owned state live here; the read
 * model stays in app/(ui)/coll/actions.ts. Import from here.
 */

export * from "./browse";
export * from "./log";
export * from "./remove";
export * from "./save";
