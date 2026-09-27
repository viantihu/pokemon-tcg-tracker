/**
 * The Lookup screen's per-copy move rows (UIL-051) — pure, no server imports, so the labels and the
 * "where it is now" destination can be tested without a DB and imported by the client component's types.
 *
 * A copy's present home is described in the Line screen's own words (`Binder · Half · Band`,
 * `Bulk box (not shelved)`), so what Lookup says "NOW" and what the Line screen says for the same copy
 * cannot drift apart. The same home is also handed to the move picker as its `initial` destination, so
 * the picker opens on where the card is rather than on a blank form.
 */
import { isPlaced } from "@/lib/engine";
import type { MoveDestination } from "@/lib/line/types";
import { stageLabel, type LeavesLine } from "@/lib/line/popup";

/** One physical copy of the looked-up printing, with what the move overlay needs to move it. */
export interface LookupMovableCopy {
  copyId: string;
  /** Includes `'haul'` (UIL-088): a card imported and not placed anywhere is still movable from here. */
  role: "haul" | "shelved" | "bulk" | "block";
  /** Where it is now, for the overlay's "NOW · …" line and the row itself. */
  currentLabel: string;
  /** Its present home as a destination; absent when it has none the picker can express (a block). */
  initial?: MoveDestination;
  /** The line it fills now, which a move leaves one short (UIL-061). */
  leaves?: LeavesLine;
}

/** The slice of an owned copy + name lookups this module needs. Matches `OwnedCopy` + PlanContext. */
export interface CopyHome {
  id: string;
  role: "haul" | "shelved" | "bulk" | "block";
  binderId: string | null;
  binderHalf: "front" | "back" | null;
  colorBand: string | null;
  lineSlotId: string | null;
}

export interface HomeNames {
  binderName: (id: string) => string | undefined;
  bandDisplay: (key: string) => string | undefined;
  /** The collection living in `binderId` that claims `tcgdexId`, if any — a specialty copy's home. */
  collectionIn: (binderId: string) => string | null;
  /** The line a copy fills through `lineSlotId`, when that slot really holds it (UIL-061). */
  leavesOf?: (lineSlotId: string, copyId: string) => LeavesLine | null;
}

/** The Line screen's label shape for a copy's current home (lib/line/load.ts `currentLabel`). */
export function copyHomeLabel(c: CopyHome, names: HomeNames): string {
  // UIL-088: an in-haul copy is placed NOWHERE, which is a different answer from the bulk box — the box
  // is somewhere she chose. Both were `'bulk'` before, so this label claimed a placement she never made.
  if (!isPlaced(c.role)) return "In haul (not placed yet)";
  if (c.role === "bulk") return "Bulk box (not shelved)";
  if (!c.binderId) return "Unshelved";
  const binder = names.binderName(c.binderId) ?? "Binder";
  if (c.role === "block") return `${binder} · binder block`;
  if (c.binderHalf === null) return `${binder} · Specialty`;
  const half = c.binderHalf === "back" ? "Back" : "Front";
  const band = c.colorBand ? (names.bandDisplay(c.colorBand) ?? c.colorBand) : null;
  const where = [binder, half, band].filter(Boolean).join(" · ");
  return c.lineSlotId ? `${where} · in a line` : where;
}

/**
 * The copy's present home as a `MoveDestination`, or undefined when none fits: a block (its pockets are
 * held; the remedy is the line detail), or a shelved copy whose specialty binder holds no collection
 * that claims this printing (nothing to pre-select honestly).
 */
export function copyHomeDestination(c: CopyHome, names: HomeNames): MoveDestination | undefined {
  // An in-haul copy has no present home to pre-select: every destination is equally new (UIL-088). The
  // picker opens on its own default rather than pretending the bulk box is where the card already is.
  if (!isPlaced(c.role)) return undefined;
  if (c.role === "bulk") return { kind: "bulk" };
  if (c.role !== "shelved" || !c.binderId) return undefined;
  if (c.binderHalf !== null) {
    if (!c.colorBand) return undefined;
    return { kind: "shelf", binderId: c.binderId, half: c.binderHalf, band: c.colorBand };
  }
  const collectionId = names.collectionIn(c.binderId);
  return collectionId ? { kind: "collection", binderId: c.binderId, collectionId } : undefined;
}

/** The slot fields `leavesFromSlots` reads. */
interface SlotLite {
  id: string;
  line_id: string;
  stage_index: number;
  stage: string;
  copy_id: string | null;
  target_catalog_card_id: string | null;
}

/**
 * The line a copy fills through `slotId`, named as the Lines page names it (its lowest named stage: "CHARMANDER
 * LINE"), and the stage a move leaves empty. Null unless the slot really holds this copy (UIL-087). Pure.
 */
export function leavesFromSlots(
  lines: Iterable<readonly SlotLite[]>,
  cardOfCopy: (copyId: string) => string | undefined,
  nameOfCard: (tcgdexId: string) => string | undefined,
  slotId: string,
  copyId: string,
): LeavesLine | null {
  for (const slots of lines) {
    const slot = slots.find((s) => s.id === slotId);
    if (!slot) continue;
    if (slot.copy_id !== copyId) return null;
    const named = [...slots]
      .sort((a, b) => a.stage_index - b.stage_index)
      .map((s) => {
        const id = s.copy_id ? cardOfCopy(s.copy_id) : s.target_catalog_card_id;
        return id ? nameOfCard(id) : undefined;
      })
      .find((n): n is string => !!n);
    return {
      lineName: named ? `${named.toUpperCase()} LINE` : "EVOLUTION LINE",
      stage: stageLabel(slot.stage),
    };
  }
  return null;
}

export function toMovableCopy(c: CopyHome, names: HomeNames): LookupMovableCopy {
  const leaves = c.lineSlotId && names.leavesOf ? names.leavesOf(c.lineSlotId, c.id) : null;
  return {
    copyId: c.id,
    role: c.role,
    currentLabel: copyHomeLabel(c, names),
    initial: copyHomeDestination(c, names),
    ...(leaves ? { leaves } : {}),
  };
}
