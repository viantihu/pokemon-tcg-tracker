/**
 * "Replace this card" on the Lines page (UIL-117 PR 3, mockup v3 section 5): the copies she already owns that could
 * take a filled slot's place. Same species as the slot (the rule the swap itself checks), not the card there now,
 * and not already in a line (moving one out of another line is that line's Move, not a swap here). Each says where
 * it is now, in her words, so the pick reads like the Move sheet's "NOW · …".
 *
 * Fresh state, read only. The swap re-checks everything at write time (`buildLineChoiceOps`).
 */

import {
  binderRepo,
  bulkUnitRepo,
  catalogCardRepo,
  colorBandRepo,
  copyRepo,
  lineSlotRepo,
  type DbClient,
  type Row,
} from "@/lib/repo";
import { IN_THE_HAUL } from "./popup";
import type { CardIdentity } from "./types";

export interface ReplaceCandidate {
  copyId: string;
  card: CardIdentity;
  /** "KB-001 · Front · Red", "Bulk box", "Specialty A". */
  where: string;
}

export type ReplaceCandidates =
  { ok: true; slotCardName: string; candidates: ReplaceCandidate[] } | { ok: false; error: string };

export async function listReplaceCandidates(
  db: DbClient,
  slotId: string,
): Promise<ReplaceCandidates> {
  const slot = await lineSlotRepo.getByPk(db, slotId);
  if (!slot || slot.state !== "filled" || !slot.copy_id) {
    return { ok: false, error: "That slot is no longer filled — reload the Lines page." };
  }
  const occupant = await copyRepo.getByPk(db, slot.copy_id);
  const slotCardId = slot.target_catalog_card_id ?? occupant?.catalog_card_id ?? null;
  const [slotCard] = slotCardId ? await catalogCardRepo.listByIds(db, [slotCardId]) : [];
  if (!slotCard) return { ok: false, error: "That slot's card is missing from the catalog." };

  // Every printing of the slot's species, in either language (UIL-090), then her copies of them.
  const printings = new Map<string, Row<"catalog_card">>();
  for (const dex of slotCard.dex_id ?? []) {
    for (const p of await catalogCardRepo.findByDexId(db, dex)) printings.set(p.tcgdex_id, p);
  }
  const [copies, binders, bands, boxes] = await Promise.all([
    copyRepo.list(db),
    binderRepo.list(db),
    colorBandRepo.listOrdered(db),
    bulkUnitRepo.listOrdered(db),
  ]);
  /** UIL-130: her boxes by id, for where a bulk card is now. */
  const boxName = new Map(boxes.map((u) => [u.id, u.name]));
  const binderName = new Map(binders.map((b) => [b.id, b.name]));
  const bandDisplay = new Map(bands.map((b) => [b.band, b.display_name]));
  const whereIs = (c: Row<"copy">): string => {
    if (c.role === "haul") return IN_THE_HAUL;
    if (c.role === "bulk" || !c.binder_id)
      return (c.bulk_unit_id && boxName.get(c.bulk_unit_id)) || "Bulk box";
    const half = c.binder_half === "back" ? "Back" : c.binder_half === "front" ? "Front" : null;
    return [
      binderName.get(c.binder_id) ?? "A binder",
      half,
      c.color_band ? (bandDisplay.get(c.color_band) ?? c.color_band) : null,
    ]
      .filter(Boolean)
      .join(" · ");
  };

  const candidates = copies
    .filter(
      (c) =>
        c.id !== slot.copy_id &&
        !c.line_slot_id &&
        (c.role === "shelved" || c.role === "bulk") &&
        printings.has(c.catalog_card_id),
    )
    .map((c): ReplaceCandidate => {
      const p = printings.get(c.catalog_card_id)!;
      return {
        copyId: c.id,
        card: {
          tcgdexId: p.tcgdex_id,
          name: p.name,
          setId: p.set_id,
          setName: p.set_name ?? null,
          localId: p.local_id,
          setCardCountOfficial: p.set_card_count_official ?? null,
          imageUrl: p.image_url,
          bandKey: c.color_band ?? "",
        },
        where: whereIs(c),
      };
    })
    // Front-half cards first (the usual upgrade source), then the bulk box, then anywhere else.
    .sort(
      (a, b) =>
        rank(a.where) - rank(b.where) ||
        a.card.name.localeCompare(b.card.name) ||
        a.copyId.localeCompare(b.copyId),
    );
  return { ok: true, slotCardName: slotCard.name, candidates };
}

function rank(where: string): number {
  if (where.includes(" · Front")) return 0;
  if (where === "Bulk box") return 1;
  return 2;
}
