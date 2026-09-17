/**
 * Client/server shared shapes for the Collections + Wishlist hub (dev-spec §5 M8). No directive —
 * serializable data only, imported by both the server actions and the client screen.
 */

import type { MoveOptions } from "@/lib/line/types";
import type { CollectionMode, WishlistBinderGroup, WishlistEntry } from "@/lib/surfaces";

/** One catalog card in a collection's list, with whether she owns it in the collection's binder. */
export interface CollectionCardView {
  tcgdexId: string;
  name: string;
  setName: string | null;
  localId: string | null;
  bandKey: string;
  imageUrl: string | null;
  owned: boolean;
  /** True when this needed card already sits on the wishlist (a finite gap she is chasing). */
  wished: boolean;
  /**
   * Every shelved copy of this card sitting in one of the collection's binders — the physical cards a
   * removal has to re-home (UIL-014). Empty means the target is a gap she is still chasing.
   * Display/affordance only: the removal action re-reads them server-side and never trusts these ids.
   */
  copyIds: string[];
}

/** A collection rendered on the Collections screen. */
export interface CollectionView {
  id: string;
  name: string;
  mode: CollectionMode;
  binderIds: string[];
  binderNames: string[];
  cards: CollectionCardView[];
  ownedCount: number;
  totalCount: number;
  /**
   * Missing a name or a binder — a draft the autosave flow (UIL-038) created but she hasn't finished
   * naming/homing yet. Shown as a visible "Draft" marker rather than left to look like a collection
   * that just doesn't work: confusing state is what pushed her to destructive workarounds before
   * (the pre-UIL-027 haul flow).
   */
  incomplete: boolean;
}

/** A specialty binder offered in the create/edit + log pickers. */
export interface SpecialtyBinderOption {
  id: string;
  name: string;
}

/** Everything the hub renders on load. */
export interface CollHubData {
  collections: CollectionView[];
  specialtyBinders: SpecialtyBinderOption[];
  wishlist: {
    groups: WishlistBinderGroup[];
    entries: WishlistEntry[];
  };
  /**
   * Picker options for the shared `MoveOverlay`, so removing a card can offer her a new home
   * (UIL-014). Built from rows this load already fetches — no extra queries.
   */
  moveOptions: MoveOptions;
}

/** Create/edit payload. `binderId === "__new"` creates a specialty binder named `newBinderName`. */
export interface CollectionInput {
  id?: string | null;
  name: string;
  mode: CollectionMode;
  binderId: string;
  newBinderName?: string;
  targetTcgdexIds: string[];
}

export type SaveResult = { ok: true } | { ok: false; error: string };

/**
 * `saveCollection`'s result — carries the id so the caller can keep autosaving into a row it just
 * created (UIL-038), rather than waiting on a full `loadCollHub` refresh to learn it.
 */
export type SaveCollectionResult = { ok: true; id: string } | { ok: false; error: string };
