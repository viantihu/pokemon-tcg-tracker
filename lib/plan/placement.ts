/**
 * Cascade target → stored `copy` placement (dev-spec §5 M6; system-design §4 Copy).
 *
 * Pure translation of a `PlacementTarget` into the four placement columns of a `copy` row. Bulk
 * copies carry no shelf location; specialty copies sit in a specialty binder with no half/band
 * (specialty binders are a single section); front/back copies carry binder + half + colour band.
 *
 * The holo-swap case is NOT handled here: a swapping holo inherits the displaced copy's role
 * wholesale (see `swap.incomingInherits`), which the commit applies directly.
 */

import type { PlacementTarget } from "@/lib/engine";

export interface CopyPlacement {
  role: "shelved" | "bulk";
  binderId: string | null;
  binderHalf: "front" | "back" | null;
  colorBand: string | null;
}

/** Derive the placement columns for the incoming copy from its cascade target. */
export function copyPlacementFromTarget(target: PlacementTarget): CopyPlacement {
  switch (target.kind) {
    case "bulk":
      return { role: "bulk", binderId: null, binderHalf: null, colorBand: null };
    case "specialty":
      // Specialty binders are one section — no half, no band (system-design §4 BinderSection).
      return { role: "shelved", binderId: target.binderId, binderHalf: null, colorBand: null };
    case "front-half":
      return {
        role: "shelved",
        binderId: target.binderId,
        binderHalf: "front",
        colorBand: target.band,
      };
    case "back-half-line":
      return {
        role: "shelved",
        binderId: target.binderId,
        binderHalf: "back",
        colorBand: target.band,
      };
  }
}
