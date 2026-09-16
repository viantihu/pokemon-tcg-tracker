/**
 * The card in the spotlight, re-derived against CURRENT state at the moment she looks at it (UIL-045).
 *
 * THE BUG. `planFromDraft` runs the cascade for every card in the draft against ONE context and never
 * mutates it between cards (`context.ts`, the `placeCard(incoming, pc.ctx)` loop). So every row of the
 * worklist is computed as if it were the only card in the haul. The write does not work that way: the
 * old whole-haul commit maintained live `slotsByLine`/`passLines` mirrors across the loop, and per-card
 * commit (UIL-027) re-reads the database on every Done. Either way the WRITE accounts for the cards
 * already shelved and the DISPLAY does not.
 *
 * Why that is worse than a wrong write, and why this is High rather than cosmetic: the two disagree
 * only for cards that interact with an earlier card in the same haul, and when they disagree the
 * database is RIGHT. She reads the screen to decide which pocket to physically put the card in. So the
 * card goes where the stale forecast said, the row records where the cascade actually decided, and
 * nothing ever contradicts anything. A wrong write shows up eventually; a wrong shelf does not.
 *
 * The commonest trigger is not an evolution line — it is a SECOND COPY OF THE SAME CARD. Forecast says
 * "front half" for both, because `duplicateOf` only considers `role === "shelved"` copies and at
 * forecast time neither is shelved yet. Shelve the first and the second re-derives to "duplicate →
 * bulk". Same shape for two cards of one line: both forecast "start a new line", and the second
 * actually fills the placeholder the first just created.
 *
 * PRE-EXISTING, NOT INTRODUCED BY UIL-027. The gap has been live since M6; per-card commit inherited
 * it. What UIL-027 removed was the single review step, which is why it is worth closing now.
 *
 * WHAT THIS FIXES AND WHAT IT DELIBERATELY DOES NOT. Only the spotlight card is re-derived — that is
 * the one card whose accuracy puts a physical card in a physical pocket. The rest of the worklist stays
 * the original forecast and is labelled as an estimate. Re-forecasting the whole tail on every Done
 * would cost eight of `loadPlanContext`'s nine reads (the catalog is cached, the other eight are not,
 * and `copyRepo.listAll` pages with her collection) multiplied by every click of a 685-card sitting.
 *
 * WHY A DIGEST RATHER THAN CARRYING THE PLACEMENT TO THE WRITE. The obvious stronger fix is to show
 * what will be written by having the write use what was shown — one derivation, no possible
 * disagreement. It does not work here, and the reason is specific: a cascade result is not just four
 * placement columns. `writeCard` emits side effects the columns cannot express — `update_slot` to fill
 * an existing line's open slot, `writeNewLine` to create a line and its slots, and for a holo swap an
 * `update_copy` that displaces the normal to bulk. `writeOverriddenCard` gets to skip all of that
 * precisely because a manual override is defined as "no cascade side effects". Carrying a placement
 * for a cascade-placed card would therefore silently drop line creation, slot fills and swaps — a far
 * worse bug than the one being fixed. Serialising the whole write set to the client and trusting it
 * back is the other option, and it puts the engine's authority in the browser.
 *
 * So the write keeps re-deriving server-side, and the client instead sends back the DIGEST of what it
 * displayed. The server re-derives (its existing single context load — no extra round trip on the write
 * path) and compares. Equal: write. Different: refuse, and hand back the new placement to show her.
 * Optimistic concurrency on the placement rather than a lock or a trusted payload. The guarantee is
 * then "what she saw is what was written, or she was told it changed" — which is the honest version of
 * the property (b) was reaching for.
 */

import { band, placeCard, type CascadeResult, type PlacementTarget } from "@/lib/engine";
import type { DbClient } from "@/lib/repo";
import { buildIncoming, loadPlanContext, type DraftItem, type PlanContext } from "./context";
import { toPlanItem } from "./assemble";
import type { PlanItem } from "./types";

/**
 * A stable, comparable summary of WHERE a cascade result puts a card, including the line side effects
 * that a bare placement would lose.
 *
 * Everything that changes which pocket the card ends up in, and nothing that does not: the reason
 * string and the proposal list are excluded deliberately, so a reworded explanation is not a false
 * conflict. The band is the DB key, matching the space the engine runs in.
 */
export function placementDigest(result: CascadeResult): string {
  const t: PlacementTarget = result.target;
  const parts: string[] = [t.kind];
  switch (t.kind) {
    case "bulk":
      break;
    case "specialty":
      parts.push(t.binderId ?? "-", t.collectionId ?? "-");
      break;
    case "front-half":
      parts.push(t.binderId ?? "-", t.band);
      break;
    case "back-half-line":
      parts.push(t.binderId ?? "-", t.band, t.lineId, String(t.stageIndex));
      break;
  }
  // Side effects change the physical outcome as much as the target does: filling an existing slot puts
  // the card in a specific pocket of a specific line, and a swap displaces another card to bulk.
  if (result.filledExistingSlot) {
    parts.push(`fill:${result.filledExistingSlot.lineId}:${result.filledExistingSlot.stageIndex}`);
  }
  if (result.newLine) parts.push("newline");
  if (result.swap) parts.push(`swap:${result.swap.displacedCopyId}`);
  return parts.join("|");
}

export interface SpotlightPlacement {
  /** The row to display — freshly derived, so it names the pocket the write will actually use. */
  item: PlanItem;
  /** Sent back with the Done click; the write refuses if its own derivation disagrees. */
  digest: string;
}

/**
 * Re-derive ONE card against current database state.
 *
 * `excludeOwnedCopyIds` mirrors what a commit does for a routing pass (UIL-003): a pending copy this
 * sitting is about to route is the incoming stack, not the established collection, so it must not also
 * be visible as already-owned. Passing the same set the commit will pass is what makes this derivation
 * equal to the commit's — anything else here and the digest would conflict on every card.
 */
export async function deriveSpotlightPlacement(
  db: DbClient,
  card: DraftItem,
  options: { excludeOwnedCopyIds?: Iterable<string> } = {},
): Promise<SpotlightPlacement | null> {
  const pc = await loadPlanContext(db, {
    excludeOwnedCopyIds: options.excludeOwnedCopyIds,
  });
  return derivePlacementFrom(pc, card);
}

/** The pure half, so tests and the commit path can share one derivation without a second DB read. */
export function derivePlacementFrom(pc: PlanContext, card: DraftItem): SpotlightPlacement | null {
  const incoming = buildIncoming(card, pc.catalogById);
  if (!incoming) return null;
  const result = placeCard(incoming, pc.ctx);
  const bandKey = band(incoming.card, pc.ctx.typeColorMap);
  return {
    item: toPlanItem(incoming, result, bandKey, pc.lookups),
    digest: placementDigest(result),
  };
}
