"use server";

/**
 * Server actions for the Lookup screen (dev-spec §5 M8; system-design §7C).
 *
 * Type-ahead reuses the plan screen's mirror search (M6). `lookupAnswer` loads the shared plan
 * context (M6 `loadPlanContext`) + open wishlist items, then hands the joins to the PURE
 * `buildLookupAnswer` (lib/surfaces). The client never touches the DB or TCGdex.
 */

import { band } from "@/lib/engine";
import { getOwnerContext, loadPlanContext } from "@/lib/plan";
import { catalogCardRepo, wishlistItemRepo } from "@/lib/repo";
import {
  buildLookupAnswer,
  type LookupAnswer,
  type LookupCopy,
  type LookupLineRef,
} from "@/lib/surfaces";
import { lookupCatalog } from "../plan/actions";
import type { LookupCard } from "../plan/plan-types";

/** Type-ahead against the local mirror — the same server search the plan intake uses. */
export async function searchCatalog(query: string): Promise<LookupCard[]> {
  return lookupCatalog(query);
}

/** Assemble the show-floor answer for one printing, or null if it is not in the mirror. */
export async function lookupAnswer(tcgdexId: string): Promise<LookupAnswer | null> {
  const { db } = await getOwnerContext();
  const [row, pc, openWishlist] = await Promise.all([
    catalogCardRepo.getByPk(db, tcgdexId),
    loadPlanContext(db),
    wishlistItemRepo.listOpen(db),
  ]);
  if (!row) return null;

  const engineCard = pc.catalogById.get(tcgdexId);
  if (!engineCard) return null;

  const bandKey = band(engineCard, pc.ctx.typeColorMap);
  const bandDisplay = pc.lookups.bandDisplayByKey.get(bandKey) ?? bandKey;
  const dexId = engineCard.dexId[0] ?? null;

  // Species name for a line label: any catalog card sharing the line's root dexId.
  const nameByDexId = new Map<number, string>();
  for (const c of pc.catalogById.values()) {
    const d = c.dexId[0];
    if (d != null && !nameByDexId.has(d)) nameByDexId.set(d, c.name);
  }
  const lineLabel = (rootDexId: number) => `${nameByDexId.get(rootDexId) ?? "Line"} line`;

  // Physical copies of THIS printing (all roles).
  const copies: LookupCopy[] = pc.ctx.owned
    .filter((o) => o.card.tcgdexId === tcgdexId)
    .map((o) => ({
      role: o.role,
      binderId: o.binderId,
      binderName: o.binderId ? (pc.lookups.binderNameById.get(o.binderId) ?? null) : null,
      binderHalf: o.binderHalf,
      bandDisplay: o.colorBand
        ? (pc.lookups.bandDisplayByKey.get(o.colorBand) ?? o.colorBand)
        : null,
      lineSlotId: o.lineSlotId,
    }));

  const toLineRef = (
    lineId: string,
    rootDexId: number,
    stage: string | null,
    status: string,
  ): LookupLineRef => ({
    lineId,
    lineLabel: lineLabel(rootDexId),
    stage,
    status: (status as LookupLineRef["status"]) ?? "open",
  });

  // Is one of her copies already sitting in a line?
  const slotIds = new Set(copies.map((c) => c.lineSlotId).filter((s): s is string => !!s));
  let ownedInLine: LookupLineRef | null = null;
  for (const line of pc.ctx.lines) {
    const slot = line.slots.find((s) => s.copyId && slotIds.has(s.id));
    if (slot) {
      ownedInLine = toLineRef(line.id, line.rootDexId, slot.stage, line.status);
      break;
    }
  }

  // Would this species+colour fill an OPEN placeholder somewhere?
  let completesLine: LookupLineRef | null = null;
  if (!ownedInLine && dexId != null) {
    for (const line of pc.ctx.lines) {
      if (line.colorBand !== bandKey) continue;
      const slot = line.slots.find((s) => s.state === "placeholder" && s.dexId === dexId);
      if (slot) {
        completesLine = toLineRef(line.id, line.rootDexId, slot.stage, line.status);
        break;
      }
    }
  }

  // Wishlist: chosen/alternate target, or the species is required by an open gap.
  const wished = openWishlist.find(
    (w) =>
      w.chosen_catalog_card_id === tcgdexId ||
      w.alternate_catalog_card_ids.includes(tcgdexId) ||
      (dexId != null && w.required_dex_id === dexId),
  );
  const wishlist = {
    wished: !!wished,
    willLiveInSpecialty: wished?.will_live_in_specialty ?? false,
    detail: wished
      ? wished.chosen_catalog_card_id === tcgdexId && row.price_market != null
        ? `$${row.price_market.toFixed(2)} · chosen target`
        : wished.will_live_in_specialty
          ? "Would go to the specialty binder."
          : "On the hunt to fill a gap."
      : null,
  };

  const collections = pc.ctx.collections
    .filter((c) => c.targetCatalogCardIds.includes(tcgdexId))
    .map((c) => ({ id: c.id, name: c.name }));

  return buildLookupAnswer({
    card: {
      tcgdexId: row.tcgdex_id,
      name: row.name,
      setName: row.set_name,
      localId: row.local_id,
      rarity: row.rarity,
      types: row.types ?? [],
      stage: row.stage,
      cardClass: row.card_class === "specialty" ? "specialty" : "standard",
      imageUrl: row.image_url,
    },
    bandKey,
    bandDisplay,
    orderedBandKeys: pc.orderedBandKeys,
    copies,
    ownedInLine,
    completesLine,
    wishlist,
    collections,
  });
}
