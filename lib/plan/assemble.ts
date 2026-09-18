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

/**
 * Human "where does it go" string for a bare target, e.g. "Binder 1 · Back · Red". Takes a
 * `PlacementTarget` rather than a whole `CascadeResult` so a caller with a SECOND, alternate target
 * — UIL-069's colour-mismatch options are the first case — can describe it the same way, not a
 * hand-rolled second copy of this switch.
 */
export function describeTarget(t: PlacementTarget, l: AssembleLookups): string {
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

/** The target's band, for targets that carry one; null for "bulk" and "specialty" (UIL-017). */
function targetBand(t: PlacementTarget): string | null {
  return t.kind === "front-half" || t.kind === "back-half-line" ? t.band : null;
}

/**
 * Reader-facing explanation of *why* the cascade routed a card (UIL-017). `CascadeResult.reason` is
 * the engine's own internal decision trace — it names internal fields (`cardClass`) and, in
 * production, carries the colour band as its raw DB key (`"dark_blue"`, not `"Dark blue"`) — so it
 * stays exactly as the engine wrote it for logs, audits, and the tests that assert on it, and this
 * derives the display copy separately rather than editing that string in place.
 *
 * Total: every `CascadeStep` maps (mirrors `actionForResult` in action.ts).
 */
export function describeReason(
  incoming: IncomingCard,
  result: CascadeResult,
  l: AssembleLookups,
): string {
  const t = result.target;
  const band = () => bandName(targetBand(t) ?? "", l);
  switch (result.step) {
    case "collection-claim": {
      const name =
        t.kind === "specialty" && t.collectionId ? l.collectionNameById.get(t.collectionId) : null;
      const belongs = name ? `Belongs to your "${name}" collection` : "Belongs to a collection";
      return `${belongs} — collection cards go to the specialty binder ahead of a line placement.`;
    }
    case "card-class":
      return incoming.card.rarity
        ? `Specialty card (${incoming.card.rarity}) — goes to the specialty binder.`
        : "Specialty card — goes to the specialty binder.";
    case "duplicate":
      return result.swap
        ? `Holo duplicate of a card already on the shelf — the holo takes its place${
            result.swap.incomingInherits.lineSlotId ? ", including its line slot," : ""
          } and the plain copy moves to the bulk box.`
        : "Duplicate of a card already on the shelf — goes to the bulk box.";
    case "line-existing":
      return result.filledExistingSlot
        ? `Fills the open ${incoming.card.stage ?? "line"} slot on the existing ${band()} line, in the back half.`
        : `The ${band()} line already has this stage — the extra copy goes to the front half.`;
    case "line-new": {
      const count = result.sameColorMembers;
      const members =
        count !== undefined ? ` (${count} same-colour card${count === 1 ? "" : "s"} so far)` : "";
      return `Starts a new ${band()} line for ${incoming.card.name}${members} — goes to the back half.`;
    }
    case "line-nonviable": {
      const count = result.sameColorMembers;
      const detail =
        count !== undefined ? ` (${count} same-colour card${count === 1 ? "" : "s"})` : "";
      return `Not enough same-colour cards yet${detail} to start a line — goes to the front half, ${band()} band.`;
    }
    case "basic-no-line":
      return `Basic Pokémon with no line yet — goes to the front half, ${band()} band.`;
    case "trainer":
      return `${
        incoming.card.category === "Energy" ? "Energy card" : "Trainer / Supporter / Item card"
      } — goes to the front half, ${band()} band.`;
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
    setCardCountOfficial: incoming.card.setCardCountOfficial ?? null,
    // Off the catalog row, not `incoming.card` — the engine's CatalogCard has no image (UIL-016).
    imageUrl: l.imageUrlByTcgdexId.get(incoming.card.tcgdexId) ?? null,
    variant: incoming.variant,
    stage: incoming.card.stage,
    isBasic: incoming.card.stage === "Basic",
    bandKey,
    action: actionForResult(result),
    destination: describeTarget(result.target, l),
    reason: describeReason(incoming, result, l),
    needsDecision: resultNeedsDecision(result),
  };
}
