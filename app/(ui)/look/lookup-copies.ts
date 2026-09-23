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

/** One physical copy of the looked-up printing, with what the move overlay needs to move it. */
export interface LookupMovableCopy {
  copyId: string;
  /** Includes `'haul'` (UIL-088): a card imported and not placed anywhere is still movable from here. */
  role: "haul" | "shelved" | "bulk" | "block";
  /** Where it is now, for the overlay's "NOW · …" line and the row itself. */
  currentLabel: string;
  /** Its present home as a destination; absent when it has none the picker can express (a block). */
  initial?: MoveDestination;
  /**
   * True when this record came from her Dex export — it belongs to a `presence_group` (UIL-089).
   *
   * What it decides: whether a removal needs remembering (Dex would otherwise re-create it), and which of
   * two records of one card is the IDENTITY in a merge. A hand-typed copy is in no group, so no import
   * counts it and none will re-create it.
   */
  dexTracked: boolean;
}

/** The slice of an owned copy + name lookups this module needs. Matches `OwnedCopy` + PlanContext. */
export interface CopyHome {
  id: string;
  role: "haul" | "shelved" | "bulk" | "block";
  binderId: string | null;
  binderHalf: "front" | "back" | null;
  colorBand: string | null;
  lineSlotId: string | null;
  /** The `presence_group` this copy belongs to, or null for a hand-typed one (UIL-089). */
  presenceGroupId?: string | null;
}

export interface HomeNames {
  binderName: (id: string) => string | undefined;
  bandDisplay: (key: string) => string | undefined;
  /** The collection living in `binderId` that claims `tcgdexId`, if any — a specialty copy's home. */
  collectionIn: (binderId: string) => string | null;
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

export function toMovableCopy(c: CopyHome, names: HomeNames): LookupMovableCopy {
  return {
    copyId: c.id,
    role: c.role,
    currentLabel: copyHomeLabel(c, names),
    initial: copyHomeDestination(c, names),
    dexTracked: c.presenceGroupId != null,
  };
}
