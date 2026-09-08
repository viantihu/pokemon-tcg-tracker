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
  placementDecisionRepo,
  typeColorMapRepo,
  wishlistItemRepo,
  type Row,
} from "@/lib/repo";
import { band } from "@/lib/engine";
import { getOwnerContext, toCatalogCard } from "@/lib/plan";
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
      catalogCardRepo.list(db),
      copyRepo.listShelved(db),
      wishlistItemRepo.listOpen(db),
      lineSlotRepo.list(db),
      evolutionLineRepo.list(db),
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
  // the collection lives in).
  const ownedByBinder = new Map<string, Set<string>>();
  for (const c of shelved) {
    if (!c.binder_id) continue;
    const set = ownedByBinder.get(c.binder_id) ?? new Set<string>();
    set.add(c.catalog_card_id);
    ownedByBinder.set(c.binder_id, set);
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
        const owned = (col.current_binder_ids ?? []).some((bid) =>
          ownedByBinder.get(bid)?.has(r.tcgdex_id),
        );
        return {
          tcgdexId: r.tcgdex_id,
          name: r.name,
          setName: r.set_name,
          localId: r.local_id,
          bandKey: bandKeyForCard(r),
          imageUrl: r.image_url,
          owned,
          wished: wishedCatalogIds.has(r.tcgdex_id),
        };
      });
    return {
      id: col.id,
      name: col.name,
      mode: collectionMode(col.status),
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
  };
}

/**
 * Create or update a collection. A new binder (`binderId === "__new"`) is created as a specialty
 * binder first, so the collection — and its binder — surface in the binder list and placement picker
 * immediately (COLLS is the single source of truth).
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

    const patch = {
      name,
      status: input.mode,
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
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Flip a collection between FINITE (a chased set list) and OPEN (a running count). */
export async function setCollectionMode(id: string, mode: "finite" | "open"): Promise<SaveResult> {
  try {
    const { db } = await getOwnerContext();
    await collectionRepo.update(db, id, { status: mode });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function deleteCollection(id: string): Promise<SaveResult> {
  try {
    const { db } = await getOwnerContext();
    await collectionRepo.remove(db, id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Log a card into a collection — a PLACEMENT, not a tally. Writes a real Copy shelved in the
 * collection's (specialty) binder, records membership on the collection, and writes the audit row.
 */
export async function logCardIntoCollection(
  collectionId: string,
  tcgdexId: string,
): Promise<SaveResult> {
  try {
    const { db, ownerId } = await getOwnerContext();
    const col = await collectionRepo.getByPk(db, collectionId);
    if (!col) return { ok: false, error: "Collection not found." };
    const binderId = (col.current_binder_ids ?? [])[0];
    if (!binderId) return { ok: false, error: "This collection has no binder yet." };

    const copy = await copyRepo.insert(db, {
      owner_id: ownerId,
      catalog_card_id: tcgdexId,
      variant: "normal",
      role: "shelved",
      binder_id: binderId,
      binder_half: null, // specialty binder is a single section
      color_band: null,
      acquired_at: new Date().toISOString(),
    });

    const targets = col.target_catalog_card_ids ?? [];
    if (!targets.includes(tcgdexId)) {
      await collectionRepo.update(db, collectionId, {
        target_catalog_card_ids: [...targets, tcgdexId],
      });
    }

    await placementDecisionRepo.insert(db, {
      owner_id: ownerId,
      copy_id: copy.id,
      decision: "collection-log",
      reason: `Logged into ${col.name}`,
      resolved_by: "user",
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
