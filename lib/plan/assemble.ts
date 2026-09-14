/**
 * Cascade results → display `PlanItem`s (dev-spec §5 M6).
 *
 * Pure: given the cascade output plus name lookups (binder names, band display labels, collection
 * names), produce the flat rows the plan groups. Grouping order is decided later in `group.ts`;
 * this only flattens and describes.
 */

import type { CascadeResult, IncomingCard, PlacementTarget } from "@/lib/engine";
import { actionForResult, resultNeedsDecision } from "./action";
import type { PlanItem } from "./types";

export interface AssembleLookups {
  binderNameById: Map<string, string>;
  bandDisplayByKey: Map<string, string>;
  collectionNameById: Map<string, string>;
  /**
   * `catalog_card.image_url` by `tcgdex_id` (UIL-016). Keyed in TCGdex id space, unlike the three
   * uuid-keyed maps above.
   *
   * Required, not optional: a missing image is indistinguishable from an unwired one at runtime — it
   * just renders initials — so the wiring is enforced at compile time instead. That is the whole
   * shape of the bug this closed: `imageUrl` was never threaded through, and nothing complained.
   */
  imageUrlByTcgdexId: Map<string, string | null>;
}

const binderName = (id: string | null, l: AssembleLookups) =>
  (id && l.binderNameById.get(id)) || "Binder";
const bandName = (key: string, l: AssembleLookups) => l.bandDisplayByKey.get(key) ?? key;

/** Human "where does it go" string for a target, e.g. "Binder 1 · Back · Red". */
export function describeDestination(result: CascadeResult, l: AssembleLookups): string {
  const t: PlacementTarget = result.target;
  switch (t.kind) {
    case "bulk":
      return "Bulk box";
    case "specialty": {
      const coll = t.collectionId ? l.collectionNameById.get(t.collectionId) : null;
      return coll ? `${binderName(t.binderId, l)} · ${coll}` : binderName(t.binderId, l);
    }
    case "front-half":
      return `${binderName(t.binderId, l)} · Front · ${bandName(t.band, l)}`;
    case "back-half-line":
      return `${binderName(t.binderId, l)} · Back · ${bandName(t.band, l)}`;
  }
}

/** Flatten one planned card (incoming + its cascade result) into a display row. */
export function toPlanItem(
  incoming: IncomingCard,
  result: CascadeResult,
  bandKey: string,
  l: AssembleLookups,
): PlanItem {
  return {
    incomingId: incoming.id,
    tcgdexId: incoming.card.tcgdexId,
    name: incoming.card.name,
    setId: incoming.card.setId,
    localId: incoming.card.localId,
    // Off the catalog row, not `incoming.card` — the engine's CatalogCard has no image (UIL-016).
    imageUrl: l.imageUrlByTcgdexId.get(incoming.card.tcgdexId) ?? null,
    variant: incoming.variant,
    stage: incoming.card.stage,
    isBasic: incoming.card.stage === "Basic",
    bandKey,
    action: actionForResult(result),
    destination: describeDestination(result, l),
    reason: result.reason,
    needsDecision: resultNeedsDecision(result),
  };
}
