/**
 * "She wants this card for a collection": the ONE wishlist row shape both ways of adding a card she does
 * not own write (UIL-098 part 1, #319; UIL-101). Logging a single card (`applyCollectionLog`) and the
 * search grid's bulk add (`applyBulkAddTargets`) both build it here, so the two cannot drift.
 *
 * The shape is the one the Collections "Wishlist" button already writes (`wishlistCollectionCard`): no line
 * slot, the collection's binder as `held_for_binder_id`, and `will_live_in_specialty`. A collection want is
 * exactly what `wishlist_item.line_slot_id` was left nullable for, so no new table, and it is what every
 * "wishlisted?" reader already recognises: the hub's `wished` and Lookup's WISHLISTED fact both match an
 * open row on `chosen_catalog_card_id`.
 */

import { wishlistItemRepo, type DbClient, type Row, type WriteOp } from "@/lib/repo";

export function collectionWishOp(
  card: Row<"catalog_card">,
  /** The collection's binder, or null for a draft that has none yet: a wish needs no binder to exist. */
  binderId: string | null,
): Extract<WriteOp, { op: "insert_wishlist" }> {
  return {
    op: "insert_wishlist",
    line_slot_id: null,
    required_dex_id: card.dex_id?.[0] ?? null,
    required_type: card.types?.[0] ?? null,
    required_stage: card.stage,
    chosen_catalog_card_id: card.tcgdex_id,
    alternate_catalog_card_ids: [],
    held_for_binder_id: binderId,
    will_live_in_specialty: true,
  };
}

/**
 * The cards she already has an open wish for, so a card she is already chasing is not wished for twice.
 *
 * READ-THEN-WRITE, not server-side: the one open-row uniqueness the schema enforces (0021) is per line
 * SLOT, and a collection want has none. Two adds of the same card racing each other could therefore leave
 * two wish rows for it. Both read as one "wished", so the cost of that race is a duplicate row, never a
 * wrong answer (the trade #319 accepted).
 */
export async function openWishedCardIds(db: DbClient): Promise<Set<string>> {
  const open = await wishlistItemRepo.listOpen(db);
  return new Set(
    open.map((w) => w.chosen_catalog_card_id).filter((id): id is string => id !== null),
  );
}
