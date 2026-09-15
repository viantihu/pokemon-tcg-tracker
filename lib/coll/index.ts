/**
 * Collections write logic — public surface (UIL-014, UIL-048).
 *
 * Removing a card from a collection is a MOVE plus a chase-list edit, applied as one transaction.
 * Logging a card must never create a second physical copy for one already owned. The pure op-building
 * and the guards that keep both paths from stranding or duplicating owned copies live here; the read
 * model stays in app/(ui)/coll/actions.ts. Import from here.
 */

export * from "./log";
export * from "./remove";
