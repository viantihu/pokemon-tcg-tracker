"use server";

/**
 * Server action for the Capacity review (dev-spec §5 M8; system-design §7E).
 *
 * Reads the derived `binder_section` view and classifies each section (fullness, room for a new
 * line) via the pure `lib/surfaces/capacity` helpers. Read-only.
 */

import { getOwnerContext } from "@/lib/plan";
import { binderRepo, binderSectionRepo } from "@/lib/repo";
import { fullness, hasRoomForLine, type SectionView } from "@/lib/surfaces";
import type { CapacityData, CapacitySection } from "./binders-types";

export async function loadCapacity(): Promise<CapacityData> {
  const { db } = getOwnerContext();
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
