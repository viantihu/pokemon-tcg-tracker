/**
 * Collections write logic — public surface (UIL-014).
 *
 * Removing a card from a collection is a MOVE plus a chase-list edit, applied as one transaction.
 * The pure op-building and the guard that keeps the chase-list editor from stranding owned copies
 * live here; the read model stays in app/(ui)/coll/actions.ts. Import from here.
 */

export * from "./remove";
