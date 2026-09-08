/**
 * Collections + the placement picker they feed (dev-spec §5 M8; system-design §3, §4).
 *
 * COLLS is the single source of truth: the same `collection` rows this screen edits are what the
 * cascade reads for the collection-claim step and what the placement picker offers. So creating a
 * collection here must make it appear as a placement target immediately — that's what
 * `placementPickerOptions` guarantees, and what the M8 acceptance test pins.
 *
 * Pure/I/O-free. The finite/open toggle lives on the collection's own `mode` column (migration
 * 0005: `text not null default 'open' check (mode in ('finite','open'))`); `status` is back to its
 * real active/archived meaning. Anything but "finite" reads as OPEN (defensive against null/legacy).
 */

export type CollectionMode = "finite" | "open";

/** Read the finite/open toggle off a collection's `mode` column. Anything but "finite" is OPEN. */
export function collectionMode(mode: string | null | undefined): CollectionMode {
  return mode === "finite" ? "finite" : "open";
}

/** Progress of a finite collection — the set list she chases. */
export interface FiniteProgress {
  owned: number;
  total: number;
  pct: number;
  needed: number;
}

/** owned / total and the wishlist gap for a finite collection. */
export function finiteProgress(total: number, owned: number): FiniteProgress {
  const clampedOwned = Math.max(0, Math.min(owned, total));
  const pct = total > 0 ? Math.round((clampedOwned / total) * 100) : 0;
  return { owned: clampedOwned, total, pct, needed: Math.max(0, total - clampedOwned) };
}

export interface PlacementBinderOption {
  binderId: string;
  binderName: string;
  type: "general" | "specialty";
  /** Collections that currently live in this binder (specialty binders hold collections). */
  collections: { id: string; name: string }[];
}

interface BinderLike {
  id: string;
  name: string;
  type: string;
}

interface CollectionLike {
  id: string;
  name: string;
  current_binder_ids: string[];
}

/**
 * The intake placement picker's options: every binder, each specialty binder carrying the
 * collections that live in it. A collection created in Settings/Collections (bound to a binder via
 * `current_binder_ids`) surfaces here on the very next read — no extra wiring, because this reads the
 * same rows the collection was saved into.
 */
export function placementPickerOptions(
  binders: readonly BinderLike[],
  collections: readonly CollectionLike[],
): PlacementBinderOption[] {
  return binders.map((b) => ({
    binderId: b.id,
    binderName: b.name,
    type: b.type === "specialty" ? "specialty" : "general",
    collections: collections
      .filter((c) => c.current_binder_ids.includes(b.id))
      .map((c) => ({ id: c.id, name: c.name })),
  }));
}

/** Every collection offered as a claim target across all binders (flat), for a quick "does X exist". */
export function placementCollections(
  collections: readonly CollectionLike[],
): { id: string; name: string }[] {
  return collections.map((c) => ({ id: c.id, name: c.name }));
}
