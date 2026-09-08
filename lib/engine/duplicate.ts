/**
 * Duplicate detection + holo-swap (system-design §3, cascade step 3; dev-spec §5 M3).
 *
 * A card is a duplicate when it shares ARTWORK (`artworkGroupId`) with an owned card, OR is the same
 * printing — same `(setId, localId)`. Variants (holo, reverse) are NOT part of the duplicate key:
 * two different printings with different art are both kept.
 *
 * Duplicates are checked against SHELVED copies only — never against copies already in the bulk box,
 * and never against copies sitting in a binder block. This is why `duplicateOf` filters on role.
 *
 * Holo-swap: when the incoming card is a holo and the matched shelved copy is a plain normal, the
 * incoming holo INHERITS the shelved copy's entire role — binder, half, band, and its line slot if
 * it held one — and the displaced normal is sent to bulk.
 */

import type { CatalogCard, OwnedCopy, Variant } from "./types";

/** True when two catalog printings collide under the duplicate key (art OR same printing). */
export function isDuplicateCard(a: CatalogCard, b: CatalogCard): boolean {
  // Same artwork cluster (holo/reverse of a printing share a group; so do art reprints).
  if (a.artworkGroupId && b.artworkGroupId && a.artworkGroupId === b.artworkGroupId) {
    return true;
  }
  // Same printing: identical (setId, localId). Ids compared exactly as stored.
  if (a.setId && a.localId && a.setId === b.setId && a.localId === b.localId) {
    return true;
  }
  return false;
}

/**
 * Find the shelved copy the incoming card duplicates, if any. Only `role === "shelved"` copies are
 * considered (bulk and block copies are invisible to duplicate detection). When several shelved
 * copies match, a NORMAL-variant copy is preferred as the match so a holo can swap into its slot.
 */
export function duplicateOf(incoming: CatalogCard, owned: OwnedCopy[]): OwnedCopy | null {
  const matches = owned.filter((c) => c.role === "shelved" && isDuplicateCard(incoming, c.card));
  if (matches.length === 0) return null;
  // Prefer a plain normal so the holo-swap path can fire when applicable.
  const normal = matches.find((c) => c.variant === "normal");
  return normal ?? matches[0];
}

/** The role a copy occupies — what a swapping holo inherits wholesale. */
export interface InheritedRole {
  binderId: string | null;
  binderHalf: OwnedCopy["binderHalf"];
  colorBand: string | null;
  lineSlotId: string | null;
}

export interface HoloSwap {
  /** The incoming holo takes over this role exactly (including a line slot). */
  incomingInherits: InheritedRole;
  /** The previously-shelved normal copy that gets displaced to bulk. */
  displacedCopyId: string;
}

export type DuplicateOutcome =
  | { kind: "not-duplicate" }
  /** Holo arrived over a shelved normal → swap. Incoming shelved, normal → bulk. */
  | { kind: "holo-swap"; swap: HoloSwap; matchedCopyId: string }
  /** Duplicate that is not a holo-over-normal → incoming goes to bulk. */
  | { kind: "bulk"; matchedCopyId: string; offerBlockRepurpose: boolean };

/**
 * Resolve cascade step 3 for an incoming card.
 *
 * @param incoming        the catalog record being routed
 * @param incomingVariant the incoming physical variant (holo/normal/…)
 * @param owned           existing copies (only SHELVED ones are consulted)
 * @param openBlockNeeds  count of open binder-block needs; when > 0 a bulk-bound duplicate is
 *                        additionally offered up as a repurposed block (system-design §5 step 3).
 */
export function resolveDuplicate(
  incoming: CatalogCard,
  incomingVariant: Variant,
  owned: OwnedCopy[],
  openBlockNeeds = 0,
): DuplicateOutcome {
  const match = duplicateOf(incoming, owned);
  if (!match) return { kind: "not-duplicate" };

  // Holo-swap: incoming holo over a shelved normal of the same card.
  if (incomingVariant === "holo" && match.variant === "normal") {
    return {
      kind: "holo-swap",
      matchedCopyId: match.id,
      swap: {
        incomingInherits: {
          binderId: match.binderId,
          binderHalf: match.binderHalf,
          colorBand: match.colorBand,
          lineSlotId: match.lineSlotId,
        },
        displacedCopyId: match.id,
      },
    };
  }

  return { kind: "bulk", matchedCopyId: match.id, offerBlockRepurpose: openBlockNeeds > 0 };
}
