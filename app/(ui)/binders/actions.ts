"use server";

/**
 * Server action for the Capacity review (dev-spec §5 M8; system-design §7E).
 *
 * Reads the derived `binder_section` view and classifies each section (fullness, room for a new
 * line) via the pure `lib/surfaces/capacity` helpers. Read-only.
 */

import { getOwnerContext } from "@/lib/plan";
import { bandPosition } from "@/lib/engine";
import { binderRepo, binderSectionRepo, catalogCardRepo, copyRepo } from "@/lib/repo";
import { fullness, hasRoomForLine, type SectionView } from "@/lib/surfaces";
import type { BinderCardTile, CapacityData, CapacitySection } from "./binders-types";

export async function loadCapacity(): Promise<CapacityData> {
  const { db } = await getOwnerContext();
  const [rows, binders] = await Promise.all([binderSectionRepo.list(db), binderRepo.list(db)]);

  const binderById = new Map(binders.map((b) => [b.id, b]));

  // Coalesce the view's nullable columns to numbers and drop any orphaned section.
  const views: (SectionView & { binderName: string; binderType: "general" | "specialty" })[] = [];
  for (const r of rows) {
    if (!r.binder_id || !r.half) continue;
    const b = binderById.get(r.binder_id);
    views.push({
      binderId: r.binder_id,
      half: r.half,
      capacity: r.capacity ?? 0,
      shelvedCount: r.shelved_count ?? 0,
      blockPockets: r.block_pockets ?? 0,
      openPlaceholders: r.open_placeholders ?? 0,
      freePockets: r.free_pockets ?? 0,
      binderName: b?.name ?? r.binder_id,
      binderType: b?.type === "specialty" ? "specialty" : "general",
    });
  }

  // Order: binder creation order, then front → back → single.
  const halfOrder: Record<string, number> = { front: 0, back: 1, single: 2 };
  const binderOrder = new Map(binders.map((b, i) => [b.id, i]));
  views.sort(
    (a, b) =>
      (binderOrder.get(a.binderId) ?? 0) - (binderOrder.get(b.binderId) ?? 0) ||
      (halfOrder[a.half] ?? 9) - (halfOrder[b.half] ?? 9),
  );

  const sections: CapacitySection[] = views.map((v) => ({
    binderId: v.binderId,
    binderName: v.binderName,
    binderType: v.binderType,
    half: v.half,
    capacity: v.capacity,
    shelvedCount: v.shelvedCount,
    blockPockets: v.blockPockets,
    openPlaceholders: v.openPlaceholders,
    freePockets: v.freePockets,
    fullness: fullness(v),
  }));

  const roomForLine = views
    .filter((v) => hasRoomForLine(v))
    .sort((a, b) => b.freePockets - a.freePockets || a.binderId.localeCompare(b.binderId))
    .map((v) => ({ binderId: v.binderId, binderName: v.binderName, freePockets: v.freePockets }));

  return { sections, roomForLine };
}

/**
 * Every shelved card in ONE binder, both halves unioned into a single list (UIL-055) — she is
 * objecting to front/back reading as two binders in this VIEW, not to the underlying model, which
 * still needs the half for pocket classification. Sorted the way the binder actually sits: front
 * before back, then rainbow band order within a half, then name.
 *
 * Reads via `copyRepo.listShelvedInSection`, one query per section of THIS binder, rather than
 * `listShelved`'s single unpaged "every shelved copy in the collection" select — that read is capped
 * at Supabase's 1000-row default, and unlike `browse()`'s pagination (a partial page that says so),
 * a silent cap here would drop cards from a binder with no error: she opens it, doesn't see a card
 * she owns, and reads that as having lost it — UIL-031's failure shape, and the one this screen exists
 * to prevent, not a performance footnote to accept. One binder's one section is bounded by physical
 * pocket capacity regardless of how large the collection overall grows, so this has no such ceiling.
 * Queried for all three sections unconditionally (a specialty binder's front/back come back empty, a
 * general binder's single section comes back empty) rather than branching on the binder's type first —
 * one extra empty, indexed query is cheaper than a second round trip to look the type up.
 */
export async function loadBinderCards(binderId: string): Promise<BinderCardTile[]> {
  const { db } = await getOwnerContext();
  const [front, back, single] = await Promise.all([
    copyRepo.listShelvedInSection(db, binderId, "front"),
    copyRepo.listShelvedInSection(db, binderId, "back"),
    copyRepo.listShelvedInSection(db, binderId, null),
  ]);
  const inBinder = [...front, ...back, ...single];
  if (inBinder.length === 0) return [];

  const cardIds = [...new Set(inBinder.map((c) => c.catalog_card_id))];
  const cards = await catalogCardRepo.listByIds(db, cardIds);
  const cardById = new Map(cards.map((c) => [c.tcgdex_id, c]));

  const halfOrder: Record<string, number> = { front: 0, back: 1, single: 2 };
  return inBinder
    .map((c) => {
      const card = cardById.get(c.catalog_card_id);
      return {
        copyId: c.id,
        tcgdexId: c.catalog_card_id,
        name: card?.name ?? c.catalog_card_id,
        localId: card?.local_id ?? null,
        imageUrl: card?.image_url ?? null,
        half: c.binder_half ?? "single",
        bandKey: c.color_band,
      };
    })
    .sort(
      (a, b) =>
        (halfOrder[a.half] ?? 9) - (halfOrder[b.half] ?? 9) ||
        bandPosition(a.bandKey ?? "") - bandPosition(b.bandKey ?? "") ||
        a.name.localeCompare(b.name),
    );
}
