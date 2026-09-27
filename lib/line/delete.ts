/**
 * Deleting a line (UIL-118). Karvi: "I need the ability to delete lines. I accidentally added cards in the wrong
 * place. I moved the cards, but the lines still created placeholders. I want to get rid of them, and users should be
 * able to as well."
 *
 * WHAT GOES. A line that holds NO card: its slots (all empty), its wishes (the cards it was waiting for, which come
 * off her wishlist; resolved rows go too, since the line was a mistake), and the line. Decision history keeps its
 * label and loses the link. One `apply_write_ops` call, the `delete_line` op (migration 0029).
 *
 * WHAT IS REFUSED, in her words (the Senior BA's rulings), before anything is written:
 *   - a line that still holds cards: move them out first (a "where do they go" picker is a later item);
 *   - a line with a block in her binder: remove its block first (a physical-world question);
 *   - a line that is already gone.
 * The database refuses the first two again inside the write, so a stale tab cannot delete a line that holds a card.
 *
 * Fresh state every time: the counts she confirms are read when she asks, not taken from the page.
 */

import { errorMessage } from "@/lib/errors";
import { applyWriteOps, evolutionLineRepo, lineSlotRepo, type DbClient } from "@/lib/repo";

export const DELETE_LINE = {
  holdsCards: (n: number) =>
    `This line holds ${n} card${n === 1 ? "" : "s"}. Move ${n === 1 ? "it" : "them"} out first, then delete the line.`,
  hasBlock: "This line has a block in your binder. Remove its block first, then delete the line.",
  gone: "That line was already deleted. Reload the Lines page.",
} as const;

/** What a delete removes, for the confirm she reads. */
export interface LineDeletion {
  lineId: string;
  /** Its slots, every one empty. */
  emptySlots: number;
  /** Cards on her wishlist that this line was waiting for (open wishes). */
  openWishes: number;
}

export type LineDeletionCheck = { ok: true; deletion: LineDeletion } | { ok: false; error: string };

/** What deleting this line would remove, or why it cannot be deleted yet. Reads only. */
export async function checkLineDeletion(db: DbClient, lineId: string): Promise<LineDeletionCheck> {
  const line = await evolutionLineRepo.getByPk(db, lineId);
  if (!line) return { ok: false, error: DELETE_LINE.gone };
  const slots = await lineSlotRepo.listByLine(db, lineId);
  const slotIds = slots.map((s) => s.id);

  // A card is a copy the line holds: named by a filled slot, or pointing at one of its slots. Counted once each.
  const cards = new Set(
    slots.flatMap((s) => (s.state === "filled" && s.copy_id ? [s.copy_id] : [])),
  );
  if (slotIds.length > 0) {
    for (const id of await idsWhere(db, "copy", "line_slot_id", slotIds)) cards.add(id);
  }
  const filledWithNoCopy = slots.some((s) => s.state === "filled" && !s.copy_id);
  if (cards.size > 0 || filledWithNoCopy) {
    return { ok: false, error: DELETE_LINE.holdsCards(Math.max(cards.size, 1)) };
  }
  if ((await idsWhere(db, "binder_block", "line_id", [lineId])).length > 0) {
    return { ok: false, error: DELETE_LINE.hasBlock };
  }

  const openWishes = slotIds.length > 0 ? await countOpenWishes(db, slotIds) : 0;
  return { ok: true, deletion: { lineId, emptySlots: slots.length, openWishes } };
}

/** Delete a line that holds no card, in one write; refused, with nothing written, when it cannot go. */
export async function deleteLine(db: DbClient, lineId: string): Promise<LineDeletionCheck> {
  const check = await checkLineDeletion(db, lineId);
  if (!check.ok) return check;
  try {
    await applyWriteOps(db, { ops: [{ op: "delete_line", line_id: lineId }] });
  } catch (err) {
    // The database refused it: the line changed between her two taps (a card went into it from another tab, or
    // another tab deleted it). Nothing was written; say why in her words, from the state as it is now.
    if (/delete_line (refused|found no such line)/.test(errorMessage(err))) {
      const now = await checkLineDeletion(db, lineId);
      if (!now.ok) return now;
    }
    throw err;
  }
  return check;
}

/** Ids of the rows of `table` whose `column` is one of `values`. */
async function idsWhere(
  db: DbClient,
  table: "copy" | "binder_block",
  column: "line_slot_id" | "line_id",
  values: string[],
): Promise<string[]> {
  const { data, error } = await db.from(table).select("id").in(column, values);
  if (error) throw error;
  return (data ?? []).map((r: { id: string }) => r.id);
}

async function countOpenWishes(db: DbClient, slotIds: string[]): Promise<number> {
  const { count, error } = await db
    .from("wishlist_item")
    .select("id", { count: "exact", head: true })
    .in("line_slot_id", slotIds)
    .is("resolved_at", null);
  if (error) throw error;
  return count ?? 0;
}
