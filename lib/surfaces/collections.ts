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

/**
 * What a collection's list holds (UIL-113), by the ONE predicate both modes use: a card is IN the collection
 * when it is on the list AND a shelved copy of it sits in one of the collection's binders (`owned`). A finite
 * collection shows that as "owned / total"; an open one shows it as "in the binder". The rest of the list
 * splits by whether she holds the card anywhere at all (`held`): a card she has in a haul or another binder is
 * hers but not shelved here yet; a card she holds nowhere is on the list and not in her collection, which is
 * what a Testing wipe leaves behind (it deletes copies and keeps lists).
 */
export interface CollectionTally {
  inBinder: number;
  notShelvedHere: number;
  notInCollection: number;
  total: number;
}

export function collectionTally(
  cards: readonly { owned: boolean; held: boolean }[],
): CollectionTally {
  let inBinder = 0;
  let notShelvedHere = 0;
  let notInCollection = 0;
  for (const c of cards) {
    if (c.owned) inBinder++;
    else if (c.held) notShelvedHere++;
    else notInCollection++;
  }
  return { inBinder, notShelvedHere, notInCollection, total: cards.length };
}

/** An open collection's count, in her words: what is in it first, then what is only on its list. */
export function openCollectionSummary(t: CollectionTally): string {
  const parts = [`${t.inBinder} in the binder`];
  if (t.notShelvedHere > 0) parts.push(`${t.notShelvedHere} not shelved here yet`);
  if (t.notInCollection > 0) parts.push(`${t.notInCollection} not in your collection`);
  return parts.join(" · ");
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
