/**
 * Her bulk boxes as the Haul Plan reads them (UIL-130). Pure.
 *
 * Karvi, 2026-09-29: a box with a card limit that is full takes no more ("Stop it, ask for another"); an untracked
 * box is never full. So where the plan sends a card to bulk on its own (a plain duplicate, a holo's displaced normal),
 * it names her default box when it has room, else her first box (in her order) that has room. When none has room it
 * names none, and the database refuses the write in her words, so she is asked rather than a box overfilled.
 */
import type { Row } from "@/lib/repo";

export interface BulkUnitView {
  id: string;
  name: string;
  /** null: untracked, never full. */
  capacity: number | null;
  isDefault: boolean;
  /** The bulk copies in it now. */
  held: number;
}

/** Her boxes with how many cards each holds, in her order. */
export function bulkUnitViews(
  units: readonly Row<"bulk_unit">[],
  copies: Iterable<Pick<Row<"copy">, "role" | "bulk_unit_id">>,
): BulkUnitView[] {
  const held = new Map<string, number>();
  for (const c of copies) {
    if (c.role === "bulk" && c.bulk_unit_id)
      held.set(c.bulk_unit_id, (held.get(c.bulk_unit_id) ?? 0) + 1);
  }
  return [...units]
    .sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at))
    .map((u) => ({
      id: u.id,
      name: u.name,
      capacity: u.capacity,
      isDefault: u.is_default,
      held: held.get(u.id) ?? 0,
    }));
}

/** Whether a box can take `n` more cards. */
export const hasRoom = (u: BulkUnitView, n = 1): boolean =>
  u.capacity === null || u.held + n <= u.capacity;

/** The box the plan sends a card to on its own: her default with room, else her first with room, else none. */
export function bulkUnitForRoute(units: readonly BulkUnitView[]): string | null {
  const byDefault = units.find((u) => u.isDefault);
  if (byDefault && hasRoom(byDefault)) return byDefault.id;
  return units.find((u) => hasRoom(u))?.id ?? null;
}
