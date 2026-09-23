/**
 * Copy-level actions that belong to no one surface (UIL-089).
 *
 * "Remove this copy" and "these two records are one card" are about a physical card, not about a
 * collection, a line or a haul — so they live here rather than growing a mode flag on lib/coll's
 * collection-scoped removal.
 */
export * from "./remove";
