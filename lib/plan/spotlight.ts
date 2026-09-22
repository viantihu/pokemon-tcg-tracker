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

import {
  band,
  buildChain,
  placeCard,
  type CascadeResult,
  type IncomingCard,
  type PlacementTarget,
} from "@/lib/engine";
import type { MoveDestination } from "@/lib/line/types";
import type { DbClient, Row } from "@/lib/repo";
import { buildIncoming, loadPlanContext, type DraftItem, type PlanContext } from "./context";
import { describeTarget, toPlanItem } from "./assemble";
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
  /**
   * Pulls of copies that are NOT shelved, listed distinctly (UIL-087, the Senior BA's ruling). These
   * change what she has to physically DO before pressing Done — go and find the card in the bulk pile —
   * so a set of them that differs from the one she was shown is exactly the kind of drift this digest
   * exists to refuse. Sorted, because the engine's slot order is not a promise. A pull FROM A FRONT HALF
   * is deliberately not here: it does not change the target pocket and it is a card she can already see.
   */
  const unplaced = (result.newLine?.slots ?? [])
    .filter((s) => s.copyId && s.pullFrom === null && s.state === "filled")
    .map((s) => s.copyId as string)
    .sort();
  if (unplaced.length > 0) parts.push(`unplaced:${unplaced.join(",")}`);
  return parts.join("|");
}

/**
 * A card of HERS the cascade wants to relocate into the line this card would start (UIL-061).
 *
 * Disclosure, not a decision: each one has to be ticked before it moves. `generateSlots` fills a new
 * line's stages from her whole collection, so without naming these the panel says "starts a new line"
 * while the write quietly relocates cards she never touched.
 */
export interface ProposedPull {
  copyId: string;
  /** Card name, so the row reads as a card and not an id. */
  name: string;
  /** Where it is NOW, in the same vocabulary the rest of the screen uses. */
  fromLabel: string;
  /** Which stage of the new line it would fill, for ordering. */
  stageIndex: number;
  /** True when it currently occupies another line's slot — worth saying, it leaves that line short. */
  fromLine: boolean;
  /**
   * The card is not shelved anywhere, so confirming this pull is an instruction to HER as much as a
   * write: she has to find the card before the line holds it (UIL-087). A front-half pull is a card she
   * can see on a page; this one is not.
   *
   * NOT called "in the bulk box": `role: 'bulk'` currently means both "filed in a bulk box" and "an
   * import made this and it is not placed anywhere yet", and it is nearly always the second here
   * (Karvi's ruling, 2026-09-22 — the conflation itself is UIL-088).
   */
  notYetPlaced: boolean;
}

/**
 * The two-way ask when a card's own colour differs from the line it would join (UIL-069) — Karvi's
 * ruling reverses UIL-065's own "the line's band wins" default. Both options are real, "no rule"
 * placements; neither is a recommendation, so a caller must not pre-select one.
 */
export interface BandMismatchChoice {
  /** e.g. "PRIMEAPE LINE" — a label she recognizes, not just "the line". */
  lineSpeciesLabel: string;
  /** "Binder 1 · Back · Orange" — the destination if she joins the line. */
  lineDestination: string;
  /** "Binder 1 · Front · Purple" — the destination if she files it by its own colour instead. */
  ownColorDestination: string;
  /**
   * Ready to send back verbatim as `override` if she picks "file by its own colour" — translated
   * here so the client never has to know `PlacementTarget`'s shape, the same reason `lib/line/move.ts`
   * keeps `describeMove`/`moveNameLookups` server-side. There is deliberately no equivalent for the
   * LINE option: joining it is the cascade's own default (no override), confirmed by `bandChoice:
   * "line"` plus the ordinary digest check instead — carrying an override for it would route through
   * `writeOverriddenCard`, which skips the slot-fill side effect this option actually needs.
   */
  ownColorMoveDestination: MoveDestination;
}

export interface SpotlightPlacement {
  /** The row to display — freshly derived, so it names the pocket the write will actually use. */
  item: PlanItem;
  /** Sent back with the Done click; the write refuses if its own derivation disagrees. */
  digest: string;
  /**
   * Cards of hers this placement would move. Empty for everything except a new line with owned chain
   * members. Nothing here moves unless its `copyId` comes back in `confirmedPulls`.
   */
  proposedPulls: ProposedPull[];
  /** Present only for a colour mismatch on an existing line's open slot (UIL-069); null otherwise. */
  bandMismatch: BandMismatchChoice | null;
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
    proposedPulls: proposedPullsFor(result, pc, card.id),
    bandMismatch: bandMismatchChoiceFor(result, pc),
  };
}

/**
 * The two-option ask when the line's band and the card's own band disagree (UIL-069). `target`
 * already names the line option (UIL-065 unchanged); this only has to describe it and its
 * alternative for display — the species label needs its own chain-walk because a `line_slot` names
 * no species (system-design §6), the same reason `lib/line/load.ts` walks from `root_dex_id` too.
 */
function bandMismatchChoiceFor(result: CascadeResult, pc: PlanContext): BandMismatchChoice | null {
  const mismatch = result.bandMismatch;
  if (!mismatch) return null;
  const seed = pc.ctx.catalog.find(
    (c) => !c.isDigitalOnly && c.dexId.includes(mismatch.lineRootDexId),
  );
  const chain = seed
    ? buildChain({ id: "r", card: seed, variant: "normal" } as IncomingCard, pc.ctx.catalog)
    : [];
  const rootName = chain[0]?.name;
  // The engine only ever sets a front-half own-colour target (see cascade.ts STEP 4) — the fallback
  // is defensive, not a supported second shape.
  const ownColorMoveDestination: MoveDestination =
    mismatch.ownColorTarget.kind === "front-half"
      ? {
          kind: "shelf",
          binderId: mismatch.ownColorTarget.binderId ?? "",
          half: "front",
          band: mismatch.ownColorTarget.band,
        }
      : { kind: "bulk" };
  return {
    lineSpeciesLabel: rootName ? `${rootName.toUpperCase()} LINE` : "EVOLUTION LINE",
    lineDestination: describeTarget(result.target, pc.lookups),
    ownColorDestination: describeTarget(mismatch.ownColorTarget, pc.lookups),
    ownColorMoveDestination,
  };
}

/**
 * The owned copies a new-line placement would relocate.
 *
 * Reads the slots the engine already produced rather than re-deriving the chain — the engine is the one
 * authority on which copies a line claims, and a second walk here could disagree with the one the write
 * uses, which is the drift UIL-045 exists to prevent.
 *
 * Deliberately NOT filtered by `pullFrom`. `pullFrom` is only set for a front-half shelved copy, but the
 * writer moves ANY owned copy the slot names — `ownedAt` matches species + band with no role filter — so
 * a copy in bulk, a block, a specialty binder or another line's slot is equally in scope. Disclosing only
 * the `pullFrom` ones would under-report exactly the cases nobody expected (UIL-061, UIL-062).
 */
function proposedPullsFor(
  result: CascadeResult,
  pc: PlanContext,
  incomingId: string,
): ProposedPull[] {
  const slots = result.newLine?.slots;
  if (!slots) return [];
  const out: ProposedPull[] = [];
  for (const slot of slots) {
    if (!slot.copyId || slot.copyId === incomingId) continue;
    const row = pc.copyRowById.get(slot.copyId);
    if (!row) continue;
    const card = pc.catalogById.get(row.catalog_card_id);
    out.push({
      copyId: slot.copyId,
      name: card?.name ?? row.catalog_card_id,
      fromLabel: describeCurrentPlacement(row, pc),
      stageIndex: slot.stageIndex,
      fromLine: row.line_slot_id !== null,
      notYetPlaced: row.role !== "shelved",
    });
  }
  return out;
}

/**
 * Where a copy sits right now, in the screen's own vocabulary.
 *
 * `role: 'bulk'` is AMBIGUOUS today and this label must not resolve the ambiguity by guessing (UIL-087
 * follow-up): it means both "filed in a bulk box" and "an import created this and it is not placed
 * anywhere yet", and for a proposed pull it is usually the second. Saying "Bulk box" would assert a
 * placement she never made — the same false claim as the "already placed" slot note this entry removed.
 * So it reads as the honest either/or until the two states are actually separated (UIL-088), and the
 * row's `notYetPlaced` flag is what the consent step acts on.
 *
 * The other branches are unambiguous and unchanged. A bulk DESTINATION she chose is a different thing
 * and still reads "Bulk box" (`describeMove`), correctly: that one she did choose.
 */
function describeCurrentPlacement(row: Row<"copy">, pc: PlanContext): string {
  if (row.role === "bulk") return "Bulk box or still in the haul";
  if (row.role === "block") return "A binder block";
  const binder = (row.binder_id && pc.lookups.binderNameById.get(row.binder_id)) || "Binder";
  const half = row.binder_half === "front" ? "Front" : row.binder_half === "back" ? "Back" : null;
  const band = row.color_band ? pc.lookups.bandDisplayByKey.get(row.color_band) : null;
  return [binder, half, band].filter(Boolean).join(" · ");
}
