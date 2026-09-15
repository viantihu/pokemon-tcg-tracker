"use server";

/**
 * Server actions for the Collections + Wishlist hub (dev-spec §5 M8; system-design §7D, §3, §4).
 *
 * COLLS is the single source of truth: create/edit/delete write the `collection` rows the cascade's
 * collection-claim reads and the placement picker offers. Saving a collection into a new binder
 * creates that (specialty) binder first, so it appears in the binder list and the picker at once.
 * "Log a card" is a PLACEMENT (a real Copy + audit row + membership), never a blind tally.
 *
 * All catalog access is server-side (client never hits TCGdex). Owner/session via the M6 seam.
 */

import {
  binderRepo,
  catalogCardRepo,
  collectionRepo,
  colorBandRepo,
  copyRepo,
  evolutionLineRepo,
  lineSlotRepo,
  typeColorMapRepo,
  wishlistItemRepo,
  type Row,
} from "@/lib/repo";
import { band } from "@/lib/engine";
import { getOwnerContext, toCatalogCard } from "@/lib/plan";
import { errorMessage } from "@/lib/errors";
import {
  applyCollectionLog,
  applyCollectionRemoval,
  blockedBinderRebind,
  blockedBinderRebindMessage,
  blockedTargetDrops,
  blockedTargetDropsMessage,
} from "@/lib/coll";
import { buildMoveOptions, type MoveDestination, type MoveNameLookups } from "@/lib/line";
import {
  collectionMode,
  groupWishlist,
  type WishlistCard,
  type WishlistEntry,
} from "@/lib/surfaces";
import { lookupCatalog } from "../plan/actions";
import type {
  CollHubData,
  CollectionCardView,
  CollectionInput,
  CollectionView,
  SaveResult,
} from "./coll-types";
import type { LookupCard } from "../plan/plan-types";

/** Catalog type-ahead — reuses the plan intake's mirror search (M6). */
export async function searchCatalog(query: string): Promise<LookupCard[]> {
  return lookupCatalog(query);
}

function toWishlistCard(row: Row<"catalog_card">): WishlistCard {
  return {
    tcgdexId: row.tcgdex_id,
    name: row.name,
    setName: row.set_name,
    setSeries: row.set_series,
    localId: row.local_id,
    rarity: row.rarity,
    illustrator: row.illustrator,
    priceMarket: row.price_market,
  };
}

/** Load everything the hub renders: collections (with derived ownership) + the grouped wishlist. */
export async function loadCollHub(): Promise<CollHubData> {
  const { db } = await getOwnerContext();
  const [collections, binders, cards, shelved, openWishlist, slots, lines, bands, typeMapRows] =
    await Promise.all([
      collectionRepo.list(db),
      binderRepo.list(db),
      catalogCardRepo.listAll(db),
      copyRepo.listShelved(db),
      wishlistItemRepo.listOpen(db),
      lineSlotRepo.listAll(db),
      evolutionLineRepo.listAll(db),
      colorBandRepo.listOrdered(db),
      typeColorMapRepo.list(db),
    ]);

  const cardById = new Map(cards.map((c) => [c.tcgdex_id, c]));
  const binderNameById = new Map(binders.map((b) => [b.id, b.name]));
  const bandDisplayByKey = new Map(bands.map((b) => [b.band, b.display_name]));
  const typeColorMap: Record<string, string> = {};
  for (const t of typeMapRows) typeColorMap[t.card_type] = t.band;
  // A collection card's band is cosmetic here — derived from its type through the live map.
  const bandKeyForCard = (row: Row<"catalog_card">): string =>
    band(toCatalogCard(row), typeColorMap) ?? "white";

  // What she owns, per binder (a target card is "owned" if a shelved copy of it sits in a binder
  // the collection lives in). Keeps the copy ids, not just the catalog id: removing a card from a
  // collection re-homes those physical copies, so the view has to know they exist (UIL-014).
  const ownedByBinder = new Map<string, Map<string, string[]>>();
  for (const c of shelved) {
    if (!c.binder_id) continue;
    const byCard = ownedByBinder.get(c.binder_id) ?? new Map<string, string[]>();
    byCard.set(c.catalog_card_id, [...(byCard.get(c.catalog_card_id) ?? []), c.id]);
    ownedByBinder.set(c.binder_id, byCard);
  }

  const wishedCatalogIds = new Set<string>();
  for (const w of openWishlist) {
    if (w.chosen_catalog_card_id) wishedCatalogIds.add(w.chosen_catalog_card_id);
  }

  const collectionViews: CollectionView[] = collections.map((col) => {
    const targets = col.target_catalog_card_ids ?? [];
    const cardsView: CollectionCardView[] = targets
      .map((id) => cardById.get(id))
      .filter((r): r is Row<"catalog_card"> => !!r)
      .map((r) => {
        const copyIds = (col.current_binder_ids ?? []).flatMap(
          (bid) => ownedByBinder.get(bid)?.get(r.tcgdex_id) ?? [],
        );
        return {
          tcgdexId: r.tcgdex_id,
          name: r.name,
          setName: r.set_name,
          localId: r.local_id,
          bandKey: bandKeyForCard(r),
          imageUrl: r.image_url,
          owned: copyIds.length > 0,
          wished: wishedCatalogIds.has(r.tcgdex_id),
          copyIds,
        };
      });
    return {
      id: col.id,
      name: col.name,
      mode: collectionMode(col.mode),
      binderIds: col.current_binder_ids ?? [],
      binderNames: (col.current_binder_ids ?? []).map((bid) => binderNameById.get(bid) ?? bid),
      cards: cardsView,
      ownedCount: cardsView.filter((c) => c.owned).length,
      totalCount: cardsView.length,
    };
  });

  // Wishlist entries: join each open item to its line + binder + chosen/alternate catalog cards.
  const slotById = new Map(slots.map((s) => [s.id, s]));
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const nameByDexId = new Map<number, string>();
  for (const c of cards) {
    const d = c.dex_id?.[0];
    if (d != null && !nameByDexId.has(d)) nameByDexId.set(d, c.name);
  }

  const entries: WishlistEntry[] = openWishlist.map((w) => {
    const slot = w.line_slot_id ? slotById.get(w.line_slot_id) : undefined;
    const line = slot ? lineById.get(slot.line_id) : undefined;
    const bandKey = line?.color_band ?? null;
    const binderId = line?.binder_id ?? w.held_for_binder_id ?? null;
    const chosenRow = w.chosen_catalog_card_id ? cardById.get(w.chosen_catalog_card_id) : undefined;
    return {
      id: w.id,
      requiredDexId: w.required_dex_id,
      requiredType: w.required_type,
      requiredStage: w.required_stage,
      bandKey,
      bandDisplay: bandKey ? (bandDisplayByKey.get(bandKey) ?? bandKey) : null,
      speciesName: w.required_dex_id != null ? (nameByDexId.get(w.required_dex_id) ?? null) : null,
      lineId: line?.id ?? null,
      lineLabel: line
        ? `${nameByDexId.get(line.root_dex_id) ?? "Line"} line`
        : w.required_dex_id != null
          ? `${nameByDexId.get(w.required_dex_id) ?? "Line"} line`
          : null,
      binderId,
      binderName: binderId ? (binderNameById.get(binderId) ?? null) : null,
      willLiveInSpecialty: w.will_live_in_specialty,
      chosen: chosenRow ? toWishlistCard(chosenRow) : null,
      alternates: (w.alternate_catalog_card_ids ?? [])
        .map((id) => cardById.get(id))
        .filter((r): r is Row<"catalog_card"> => !!r)
        .map(toWishlistCard),
    };
  });

  return {
    collections: collectionViews,
    specialtyBinders: binders
      .filter((b) => b.type === "specialty")
      .map((b) => ({ id: b.id, name: b.name })),
    wishlist: { groups: groupWishlist(entries), entries },
    // The same picker the line strip and the plan spotlight use, built from rows already in hand.
    moveOptions: buildMoveOptions(binders, collections, bands),
  };
}

/**
 * Create or update a collection. A new binder (`binderId === "__new"`) is created as a specialty
 * binder first, so the collection — and its binder — surface in the binder list and placement picker
 * immediately (COLLS is the single source of truth).
 *
 * REFUSES a save that drops a target she still owns in the collection's binder (UIL-014 defect 2), or
 * that rebinds to a different specialty binder while owned copies are still shelved in the old one
 * (UIL-040) — same orphan class, `target_catalog_card_ids` and `current_binder_ids` are the two halves
 * of how membership is derived, and either one changing out from under a shelved copy strands it.
 * Removing an owned card is a move; it goes through `removeCardFromCollection`. Dropping an un-owned
 * target — a gap she has stopped chasing — strands nothing and is still allowed.
 */
export async function saveCollection(input: CollectionInput): Promise<SaveResult> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "A collection needs a name." };
  try {
    const { db, ownerId } = await getOwnerContext();

    let binderId = input.binderId;
    if (binderId === "__new") {
      const bn = (input.newBinderName ?? "").trim();
      if (!bn) return { ok: false, error: "Name the new binder." };
      const created = await binderRepo.insert(db, {
        owner_id: ownerId,
        name: bn,
        type: "specialty",
        pages: 20,
        pockets_per_page: 9,
        is_active: false,
      });
      binderId = created.id;
    }

    if (input.id) {
      const existing = await collectionRepo.getByPk(db, input.id);
      if (!existing) return { ok: false, error: "That collection no longer exists." };

      const blocked = await blockedTargetDrops(db, existing, input.targetTcgdexIds);
      if (blocked.length > 0) return { ok: false, error: blockedTargetDropsMessage(blocked) };

      const blockedBinder = await blockedBinderRebind(db, existing, [binderId]);
      if (blockedBinder.length > 0) {
        return { ok: false, error: blockedBinderRebindMessage(blockedBinder) };
      }
    }

    const patch = {
      name,
      mode: input.mode,
      current_binder_ids: [binderId],
      target_catalog_card_ids: input.targetTcgdexIds,
    };

    if (input.id) {
      await collectionRepo.update(db, input.id, patch);
    } else {
      await collectionRepo.insert(db, { owner_id: ownerId, definition_type: "curated", ...patch });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Flip a collection between FINITE (a chased set list) and OPEN (a running count). */
export async function setCollectionMode(id: string, mode: "finite" | "open"): Promise<SaveResult> {
  try {
    const { db } = await getOwnerContext();
    await collectionRepo.update(db, id, { mode });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function deleteCollection(id: string): Promise<SaveResult> {
  try {
    const { db } = await getOwnerContext();
    await collectionRepo.remove(db, id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * Log a card into a collection — a PLACEMENT, not a tally. Thin `getOwnerContext()` wrapper; the
 * testable core (and the UIL-048 guard against creating a second physical copy for a card already
 * owned) lives in `applyCollectionLog`.
 */
export async function logCardIntoCollection(
  collectionId: string,
  tcgdexId: string,
): Promise<SaveResult> {
  try {
    const { db, ownerId } = await getOwnerContext();
    const res = await applyCollectionLog(db, ownerId, collectionId, tcgdexId);
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * Remove a card from a collection (UIL-014) — a MOVE, not a delete.
 *
 * `copy` has no `collection_id`, so there is no field to clear: the physical copies shelved in the
 * collection's binder are re-homed to the destination she picked AND the card comes off the chase
 * list, in ONE transaction (`lib/coll/remove.ts` → `apply_write_ops`). Half of that is corrupt data,
 * so it is never allowed to half-apply.
 *
 * Only the collection, the catalog id and the destination cross the wire; which copies exist, which
 * line slots they fill and which lines that demotes are all re-derived from fresh state server-side.
 */
export async function removeCardFromCollection(
  collectionId: string,
  tcgdexId: string,
  destination: MoveDestination,
): Promise<SaveResult> {
  try {
    const { db } = await getOwnerContext();
    const [binders, collections, bands] = await Promise.all([
      binderRepo.list(db),
      collectionRepo.list(db),
      colorBandRepo.listOrdered(db),
    ]);
    const names: MoveNameLookups = {
      binderName: (id) => (id && binders.find((b) => b.id === id)?.name) || "Binder",
      collectionName: (id) => collections.find((c) => c.id === id)?.name ?? null,
      bandDisplay: (key) => bands.find((b) => b.band === key)?.display_name ?? key,
    };
    await applyCollectionRemoval(db, { collectionId, tcgdexId, destination }, names);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Add a finite collection's needed card to the wishlist (its chosen target is the card itself). */
export async function wishlistCollectionCard(
  collectionId: string,
  tcgdexId: string,
): Promise<SaveResult> {
  try {
    const { db, ownerId } = await getOwnerContext();
    const [col, card] = await Promise.all([
      collectionRepo.getByPk(db, collectionId),
      catalogCardRepo.getByPk(db, tcgdexId),
    ]);
    if (!col || !card) return { ok: false, error: "Card or collection not found." };

    await wishlistItemRepo.insert(db, {
      owner_id: ownerId,
      line_slot_id: null,
      required_dex_id: card.dex_id?.[0] ?? null,
      required_type: card.types?.[0] ?? null,
      required_stage: card.stage,
      chosen_catalog_card_id: tcgdexId,
      alternate_catalog_card_ids: [],
      held_for_binder_id: (col.current_binder_ids ?? [])[0] ?? null,
      will_live_in_specialty: true,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
