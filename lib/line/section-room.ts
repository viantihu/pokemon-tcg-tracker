/**
 * A binder section at its limit takes no more cards. Pure, so the pickers and the writers share ONE definition.
 *
 * A section is one half of a general binder (front, back) or a whole specialty binder (`single`). Its room is the
 * `binder_section` view's `free_pockets`: capacity less what is shelved, blocked and reserved by open placeholders
 * (0002). A move that would take more pockets than are free is refused, in her words, however it got to the server:
 * the Move sheet, the line popup, the Haul Plan's Move or its own placement, a collection's removal.
 *
 * What takes a pocket (`sectionDemand`): a card entering a section it is not already shelved in; a new line's
 * placeholder stages and a binder block, which reserve pockets of their own. What takes none: a card already in that
 * section (a re-band, a move between lines of one back half), and a card filling a slot that is already reserved
 * (joining an existing line), whose pocket is counted once, as the placeholder.
 *
 * There is no "add anyway": see `lib/line/overrides.ts`.
 */
import type { WriteOp } from "@/lib/repo";

export type SectionHalf = "front" | "back" | "single";

/** One section's free pockets, as the `binder_section` view reports them. */
export interface SectionRoom {
  binderId: string;
  half: SectionHalf;
  free: number;
}

/** The `binder_section` view's rows as the pickers and writers read them. */
export function sectionRooms(
  rows: readonly { binder_id: string | null; half: string | null; free_pockets: number | null }[],
): SectionRoom[] {
  return rows.flatMap((s) =>
    s.binder_id && s.half
      ? [{ binderId: s.binder_id, half: s.half as SectionHalf, free: s.free_pockets ?? 0 }]
      : [],
  );
}

/** A section as a map key. */
export const sectionKey = (binderId: string, half: SectionHalf): string => `${binderId}:${half}`;

/** The half a shelved copy sits in: a specialty binder's copies have none, and are its `single` section. */
export const halfOf = (binderHalf: string | null | undefined): SectionHalf =>
  binderHalf === "front" || binderHalf === "back" ? binderHalf : "single";

/** The section a move destination lands a card in; null for bulk, which has boxes instead (lib/plan/bulk-units). */
export function sectionOfDestination(dest: {
  kind: string;
  binderId?: string;
  half?: string;
}): { binderId: string; half: SectionHalf } | null {
  switch (dest.kind) {
    case "shelf":
      return dest.binderId ? { binderId: dest.binderId, half: halfOf(dest.half) } : null;
    case "collection":
      return dest.binderId ? { binderId: dest.binderId, half: "single" } : null;
    case "block":
      return dest.binderId ? { binderId: dest.binderId, half: "back" } : null;
    default:
      return null;
  }
}

/** Free pockets in a section, or null when the rooms do not say (an older caller, a binder just made). */
export function freeIn(
  rooms: readonly SectionRoom[] | undefined,
  binderId: string,
  half: SectionHalf,
): number | null {
  const hit = rooms?.find((r) => r.binderId === binderId && r.half === half);
  return hit ? hit.free : null;
}

/** True when the section is at its limit. Unknown room is not full: the writers still check it on fresh rows. */
export function isSectionFull(
  rooms: readonly SectionRoom[] | undefined,
  binderId: string,
  half: SectionHalf,
): boolean {
  const free = freeIn(rooms, binderId, half);
  return free !== null && free <= 0;
}

const HALF_WORDS: Record<SectionHalf, string> = {
  front: "front half",
  back: "back half",
  single: "",
};

/** "Binder 1's front half", "Specialty A". */
export function sectionName(binderName: string, half: SectionHalf): string {
  return half === "single" ? binderName : `${binderName}'s ${HALF_WORDS[half]}`;
}

/** Her words for a section with no room for the card, with what she can do about it. */
export function fullSectionReason(binderName: string, half: SectionHalf): string {
  return `${sectionName(binderName, half)} is full. Pick another place, or add pages in Settings.`;
}

/** The part of a copy row `sectionDemand` reads: where it is now. */
export interface CopyPlace {
  role: string;
  binder_id: string | null;
  binder_half: string | null;
}

/** A section a write needs more pockets in than are free. */
export interface SectionShortfall {
  binderId: string;
  half: SectionHalf;
  need: number;
  free: number;
}

/**
 * The pockets a write takes in each section, by `sectionKey`. `copies` holds where each copy it moves is now (a copy
 * not in it is read as new to every section). Only what ENTERS a section counts; what leaves one is not credited, so
 * the answer errs toward "full", never toward "room".
 */
export function sectionDemand(
  ops: readonly WriteOp[],
  copies: ReadonlyMap<string, CopyPlace>,
): Map<string, { binderId: string; half: SectionHalf; need: number }> {
  const demand = new Map<string, { binderId: string; half: SectionHalf; need: number }>();
  const add = (binderId: string, half: SectionHalf, n: number) => {
    if (n <= 0) return;
    const key = sectionKey(binderId, half);
    const hit = demand.get(key);
    if (hit) hit.need += n;
    else demand.set(key, { binderId, half, need: n });
  };

  // Slots and lines this same write creates: a copy filling a NEW slot starts a line (and takes a pocket); one filling
  // an existing slot takes the pocket that slot already reserves.
  const newSlots = new Set<string>();
  const lineBinder = new Map<string, string | null>();
  for (const op of ops) {
    if (op.op === "insert_slot" && op.id) newSlots.add(op.id);
    if (op.op === "insert_line" && op.id) lineBinder.set(op.id, op.binder_id ?? null);
  }

  for (const op of ops) {
    if (op.op === "update_copy") {
      const patch = op.patch;
      if (patch.role !== "shelved" || !patch.binder_id) continue;
      const half = halfOf(patch.binder_half);
      const now = copies.get(op.id);
      if (
        now &&
        now.role === "shelved" &&
        now.binder_id === patch.binder_id &&
        halfOf(now.binder_half) === half
      )
        continue; // already in this section
      if (patch.line_slot_id && !newSlots.has(patch.line_slot_id)) continue; // fills a reserved slot
      add(patch.binder_id, half, 1);
    } else if (op.op === "insert_slot") {
      const binderId = lineBinder.get(op.line_id);
      if (binderId && op.state === "placeholder") add(binderId, "back", 1);
    } else if (op.op === "insert_binder_block") {
      add(op.binder_id, halfOf(op.half), op.pocket_count);
    }
  }
  return demand;
}

/** The sections a write needs more pockets in than `rooms` has free. A section the rooms do not name is not checked. */
export function sectionShortfalls(
  ops: readonly WriteOp[],
  copies: ReadonlyMap<string, CopyPlace>,
  rooms: readonly SectionRoom[],
): SectionShortfall[] {
  const out: SectionShortfall[] = [];
  for (const { binderId, half, need } of sectionDemand(ops, copies).values()) {
    const free = freeIn(rooms, binderId, half);
    if (free !== null && need > free) out.push({ binderId, half, need, free });
  }
  return out;
}

/** The refusal, in her words, for the first section a write has no room in. */
export function shortfallMessage(
  shortfalls: readonly SectionShortfall[],
  binderName: (id: string) => string,
): string {
  const s = shortfalls[0];
  const name = binderName(s.binderId);
  if (s.need > 1 && s.free > 0) {
    return `${sectionName(name, s.half)} has room for ${s.free} more pocket${s.free === 1 ? "" : "s"}, and this needs ${s.need}. Pick another place, or add pages in Settings.`;
  }
  return fullSectionReason(name, s.half);
}
