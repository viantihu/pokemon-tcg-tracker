/**
 * Placement override — move ANY owned/shelved card (dev-spec §5 M7; memory-confirmed; system-design
 * §12 "coarse location is a feature").
 *
 * Pure translation of a move destination into the `copy` placement columns, plus the audit reason
 * for the `PlacementDecision` the move writes (`resolved_by: 'user'`). The escape hatch from the
 * cascade: no rule applies, it is her call. Moving a card off a line clears its `line_slot_id`; the
 * I/O layer reopens the vacated slot (removal symmetry, sync-arch §1.6).
 *
 * Coarse location only: a move sets binder + half + band (or a collection, or bulk). It never
 * auto-joins a line and never addresses a pocket or page.
 */

import type { CopyPlacementPatch, MoveDestination } from "./types";

/** Derive the four placement columns (+ cleared line link) for a moved copy. */
export function placementForMove(dest: MoveDestination): CopyPlacementPatch {
  switch (dest.kind) {
    case "bulk":
      // Bulk box has no internal structure: no binder, no half, no band, no line slot.
      return {
        role: "bulk",
        binder_id: null,
        binder_half: null,
        color_band: null,
        line_slot_id: null,
      };
    case "collection":
      // Specialty binders are a single section — no half, no rainbow band (system-design §4).
      return {
        role: "shelved",
        binder_id: dest.binderId,
        binder_half: null,
        color_band: null,
        line_slot_id: null,
      };
    case "shelf":
      return {
        role: "shelved",
        binder_id: dest.binderId,
        binder_half: dest.half,
        color_band: dest.band,
        line_slot_id: null,
      };
  }
}

/** Human destination label for the audit reason + the "MOVED → …" tag. */
export function describeMove(dest: MoveDestination, names: MoveNameLookups): string {
  switch (dest.kind) {
    case "bulk":
      return "Bulk box (not shelved)";
    case "collection": {
      const binder = names.binderName(dest.binderId);
      const coll = names.collectionName(dest.collectionId);
      return coll ? `${binder} · ${coll}` : binder;
    }
    case "shelf": {
      const binder = names.binderName(dest.binderId);
      const half = dest.half === "front" ? "Front" : "Back";
      const band = names.bandDisplay(dest.band);
      return `${binder} · ${half} · ${band}`;
    }
  }
}

export interface MoveNameLookups {
  binderName: (id: string | null) => string;
  collectionName: (id: string) => string | null;
  bandDisplay: (key: string) => string;
}

/** The `PlacementDecision.reason` recorded for a manual move (always `resolved_by: 'user'`). */
export function moveDecisionReason(dest: MoveDestination, destLabel: string): string {
  const where =
    dest.kind === "bulk"
      ? "the bulk box"
      : dest.kind === "collection"
        ? "a collection in the specialty binder"
        : "a binder half + band";
  return `Manual placement override (your call, no rule applied): moved to ${where} — ${destLabel}.`;
}

/** Validate a destination before it is applied (guards the empty picker states the panel allows). */
export function isMoveDestinationComplete(dest: MoveDestination): boolean {
  switch (dest.kind) {
    case "bulk":
      return true;
    case "collection":
      return Boolean(dest.binderId && dest.collectionId);
    case "shelf":
      return Boolean(dest.binderId && dest.half && dest.band);
  }
}
