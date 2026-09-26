/**
 * Copy-level actions that belong to no one surface (UIL-089).
 *
 * "Remove this copy" is about a physical card, not about a collection, a line or a haul — so it lives
 * here rather than growing a mode flag on lib/coll's collection-scoped removal.
 */
export * from "./remove";
