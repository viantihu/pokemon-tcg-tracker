/**
 * Her bulk boxes as the Haul Plan reads them (UIL-130). Pure.
 *
 * Karvi, 2026-09-29: a box with a card limit that is full takes no more ("Stop it, ask for another"); an untracked
 * box is never full. So where the plan sends a card to bulk on its own (a plain duplicate, a holo's displaced normal),
 * it names her default box when it has room, else her first box (in her order) that has room. When none has room it
 * names none, and the database refuses the write in her words, so she is asked rather than a box overfilled.
 *
 * 0037 (Karvi, 2026-10-01: "Users should always be able to override all rules"): that is the recommendation. She can
 * still pick a full box herself, warned in her words (`addAnywayWarning`), and confirm "Add anyway · N over".
 */
import type { BulkUnitView, Row, WritePayload } from "@/lib/repo";

export type { BulkUnitView };

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

/** A box's load in her terms: "54 cards · no limit", "50 of 60 cards", "60 of 60 cards · full", "72 of 60 cards · 12 over". */
export function boxLoad(u: Pick<BulkUnitView, "held" | "capacity">): string {
  const cards = (n: number) => `${n} card${n === 1 ? "" : "s"}`;
  if (u.capacity === null) return `${cards(u.held)} · no limit`;
  const of = `${u.held} of ${cards(u.capacity)}`;
  if (u.held > u.capacity) return `${of} · ${u.held - u.capacity} over`;
  if (u.held === u.capacity) return `${of} · full`;
  return of;
}

/** The box a picker starts on: the one named, else her default with room, else her first with room, else her default. */
export function initialBox(units: readonly BulkUnitView[], named?: string): string | undefined {
  if (named && units.some((u) => u.id === named)) return named;
  return bulkUnitForRoute(units) ?? units.find((u) => u.isDefault)?.id;
}

/** Her words for a full box a picker can't take a card into. */
export const fullBoxReason = (u: Pick<BulkUnitView, "name" | "held" | "capacity">) =>
  `${u.name} is full (${u.held} of ${u.capacity} cards). Pick another box.`;

/** How many cards over its limit a box will be once `n` more go in (0 for a box with room, or with no limit). */
export const overBy = (u: Pick<BulkUnitView, "held" | "capacity">, n = 1): number =>
  u.capacity === null ? 0 : Math.max(0, u.held + n - u.capacity);

/** 0037: her warning when she picks a full box anyway. The full-box reason first, then what adding it anyway does. */
export const addAnywayWarning = (u: Pick<BulkUnitView, "name" | "held" | "capacity">, n = 1) =>
  `${fullBoxReason(u)} Or add it anyway: it will be ${overBy(u, n)} over.`;

/** 0037: the confirm for a full box she picked knowingly: "Add anyway · 1 over". */
export const addAnywayLabel = (u: Pick<BulkUnitView, "held" | "capacity">, n = 1) =>
  `Add anyway · ${overBy(u, n)} over`;

/**
 * Settings' delete of a box, its cards going to `moveTo` (UIL-130). The database refuses a `moveTo` with a card limit
 * that cannot take them all. 0037 (Karvi, 2026-10-01: "Users should always be able to override all rules"): her
 * "Delete anyway" sends it with bulk_box_full, recorded on a decision that names both boxes and how far over the box
 * will be, read from `units` as they are now. Anyway into a box that has room by now is the plain delete: no rule is
 * overridden.
 */
export function deleteBoxWrite(
  id: string,
  moveTo: string,
  units: readonly BulkUnitView[],
  anyway: boolean,
): WritePayload {
  const del = { op: "delete_bulk_unit" as const, id, move_to: moveTo };
  const gone = units.find((u) => u.id === id);
  const dest = units.find((u) => u.id === moveTo);
  const over = anyway && gone && dest ? overBy(dest, gone.held) : 0;
  if (!gone || !dest || over === 0) return { ops: [del] };
  const cards = `${gone.held} card${gone.held === 1 ? "" : "s"}`;
  return {
    ops: [
      del,
      {
        op: "insert_decision",
        haul_id: null,
        copy_id: null,
        decision: "bulk-box-deleted-over-limit",
        reason: `Deleted ${gone.name}: its ${cards} went to ${dest.name}, ${over} over its card limit (your call).`,
        resolved_by: "user",
        overrides: ["bulk_box_full"],
      },
    ],
    overrides: ["bulk_box_full"],
  };
}
