/**
 * Commit a haul (dev-spec §5 M6; system-design §4, §7B step 6).
 *
 * Re-runs the cascade over the draft (deterministic against current DB state) and writes every
 * record it implies: the copy's placement, EvolutionLine + LineSlots for new lines, slot fills for
 * existing lines, holo-swap displacements, WishlistItems for placeholders, and a PlacementDecision
 * per card (reason + resolvedBy — the audit trail is not optional, dev-spec §4).
 *
 * ONE KIND OF DRAFT ENTRY (UIL-098 part 2): a copy her Dex import created, waiting in her haul. The
 * commit PLACES that copy — it patches the placement columns of the row sync already created — and
 * never creates one. Dex is the source of truth for what she owns, and a copy made anywhere but the
 * import belongs to no presence group, so the next import's reconcile cannot see it and creates a SECOND
 * one when Dex lists the card: two records for one physical card. The Plan's typed intake ("add by set,
 * number or name") was exactly such a path, and it is gone; `commitCardPlacement` refuses any row that
 * does not name a copy in her haul, so a stale tab or a hand-built request cannot bring it back. The only
 * file that may emit `insert_copy` is lib/sync/exec.ts (UIL-098's rule; its database guard is part 4).
 *
 * WHAT WENT WITH IT. A typed card was the only thing that opened a `haul` row, so the Plan no longer
 * writes one: its source, notes and the sitting's haul id are gone, and every decision carries
 * `haul_id: null`, which is what a routed copy's decision always carried. The copy's `variant` /
 * `dex_variant_raw` are left alone, because Dex owns the variant field (sync-architecture §1.1) and the
 * next import would overwrite anything we wrote.
 *
 * ATOMICITY (M10). The whole write set is computed here in TS — the cascade/decision logic stays
 * pure — then applied in ONE transaction by the `apply_write_ops` RPC (migration 0006). Row UUIDs are
 * generated client-side (`crypto.randomUUID`) so line→slot→copy cross-references resolve before
 * insert. This replaces the earlier compensating-rollback interim: a commit that fails partway now
 * leaves ZERO rows. Writes run under the RLS-scoped client from the auth seam (lib/plan/session.ts)
 * and the RPC is SECURITY INVOKER, so `owner_id` is never stamped — it defaults to `auth.uid()` and
 * the RLS `with check (owner_id = auth.uid())` policy enforces it.
 */

import { localeOfId } from "@/lib/catalog/locale";
import type { Locale } from "@/lib/sync/types";
import {
  buildChain,
  effectiveType,
  formOf,
  isPlaced,
  type CardForm,
  type Role,
} from "@/lib/engine";
import {
  applyWriteOps,
  evolutionLineRepo,
  lineSlotRepo,
  type DbClient,
  type OverrideRule,
  type Row,
  type WriteOp,
  type WritePayload,
} from "@/lib/repo";
// Leaf import (lib/line/move depends only on lib/line/types → lib/engine; no cycle back to lib/plan).
import {
  blockOps,
  buildExistingLineJoinOps,
  buildNewLineJoinOps,
  collectionTargetJoinOp,
  isMoveDestinationComplete,
  lineJoinOf,
  placementForMove,
  releaseSlotOps,
} from "@/lib/line/move";
import type { MoveDestination } from "@/lib/line/types";
import type { LineChoice } from "@/lib/line/popup";
import {
  lineChoiceDestinations,
  overLimitNote,
  overridesFor,
  recordOverrides,
} from "@/lib/line/overrides";
import { lineReadsClosed } from "@/lib/line/popup";
import type { LineWriteReads } from "@/lib/line/line-choice";
import { buildBackHalfLineOps, KEEP_IS_NO_LINE_MOVE } from "@/lib/line/write";
import { isLineCard } from "./line-proposal";
import { lineDoneFor, newLineKey } from "./line-done";

/**
 * `applyMove`'s exact wording (lib/line/write.ts) for the same refusals on this path (UIL-070 part 1).
 * One vocabulary: whichever screen she moved a card from, a stale pick reads the same way.
 */
const REFUSE = {
  blockSlotGone: "That block slot no longer exists — reload the plan and pick again.",
  blockFilled: "That line's block pocket is already filled — reload the plan and pick again.",
  incomplete: "That destination is incomplete — reload the screen and pick again.",
  slotGone: "That line slot no longer exists — reload the screen and pick again.",
  slotFilled: "That slot has already been filled — reload the screen and pick again.",
  catalogMissing: "That card's catalog entry is missing — reload and try again.",
} as const;

/**
 * UIL-117: a card headed into a line waits for her OK in the line popup. Karvi: "The user must always authorize all
 * moves." Exported so the screen and the tests agree on the wording.
 */
export const LINE_CHOICE = {
  missing: "This card goes into a line. Open it and confirm its line first.",
  holoNeedsHome: "Pick where the holo goes, then confirm.",
  lineGone: "That line is no longer there. Reload the plan and pick again.",
  notALineCard: "This card isn't headed into a line. Reload the plan and pick again.",
} as const;

/**
 * UIL-053: a specialty card bound for a binder that holds collections must name the one it joins, or it
 * lands in the binder on no collection's list. Exported so the screen and the tests agree on the wording.
 * Since 0037 that is the recommendation, not a wall: "Shelve without a collection" is her override
 * (`noCollection`, collection_pick). A pick that is not one of the binder's collections stays refused.
 */
export const COLLECTION_PICK = {
  missing:
    "This card goes in a binder that holds collections. Pick which collection it belongs to, then press Done again.",
  notHere: "That collection is no longer in this card's binder. Pick again from the ones shown.",
} as const;

/**
 * The refusals for a row that is not a card waiting in her haul (UIL-098 part 2). Exported so the tests
 * and the screen agree on the wording.
 */
export const NOT_A_HAUL_COPY = {
  /** No copy at all: a hand-typed row, which the Plan no longer accepts. */
  notFromImport:
    "Only cards from your Dex import can be placed here. Add the card in Dex, then import it on the " +
    "Sync page, and it will be waiting in your haul.",
  /** The copy it named has gone — removed, or merged into another copy, since the plan was run. */
  copyGone: "That card is no longer in your collection. Reload the plan to see what is waiting.",
} as const;
import { copyPlacementFromTarget } from "./placement";
import { bulkUnitForRoute } from "./bulk-units";
import { NO_BINDER } from "./no-binder";
import { loadPlanContext, planFromDraft, type DraftItem, type PlanContext } from "./context";
import { derivePlacementFrom, placementDigest } from "./spotlight";
import type { PlanItem, PlannedCard } from "./types";

/**
 * Thrown when the placement re-derived at Done time differs from the one the screen was showing
 * (UIL-045). Carries the FRESH row so the caller can show her what changed rather than just failing.
 *
 * A distinct error type rather than a message, because the UI has to treat it differently from a real
 * failure: nothing is wrong, nothing was written, and the correct response is "look again", not
 * "retry".
 */
export class PlacementChangedError extends Error {
  readonly fresh: PlanItem | null;
  readonly expectedDigest: string;
  readonly actualDigest: string;
  constructor(fresh: PlanItem | null, expectedDigest: string, actualDigest: string) {
    super(
      fresh
        ? `This card's placement changed while you were working: it now goes to ${fresh.destination}. ` +
            `Nothing was written — check the new position and press Done again.`
        : "This card's placement changed while you were working. Nothing was written.",
    );
    this.name = "PlacementChangedError";
    this.fresh = fresh;
    this.expectedDigest = expectedDigest;
    this.actualDigest = actualDigest;
  }
}

type BulkDestination = Extract<MoveDestination, { kind: "bulk" }>;

export interface CommitInput {
  draft: DraftItem[];
  /**
   * Per-incoming-card placement overrides (M7 — placement override on ALL cards; keyed by draft id).
   * An overridden card is placed exactly where she says (binder+half+band / collection / bulk) with a
   * `resolved_by: 'user'` audit row, and the cascade's line/swap side effects are skipped for it.
   * Absent/empty ⇒ identical to the pure cascade commit.
   */
  overrides?: Record<string, MoveDestination>;
  /**
   * The collection she picked for each specialty card whose binder holds collections (UIL-053), keyed by
   * draft id. `commitCardPlacement` has already checked each is one of that binder's collections.
   */
  collectionChoices?: Record<string, string>;
  /**
   * The specialty cards she shelves in such a binder with NO collection, knowingly (0037's collection_pick), keyed by
   * draft id. Recorded on the card's decision and declared on the write.
   */
  withoutCollection?: Record<string, true>;
  /**
   * The box she picked for the copy a swap displaces (0037, the Tech Lead's "no dead ends": with every box full the
   * plan names none), keyed by draft id. `overFull` is recorded on the swap's decision and declared on the write.
   */
  displacedTo?: Record<string, BulkDestination>;
  /** The audit text for an override that stands for a line-popup Keep (UIL-117), keyed by draft id. */
  overrideReasons?: Record<string, string>;
}

export interface CommitCounts {
  /** Copies in her haul given a placement (UIL-003). The Plan never creates a copy (UIL-098). */
  routed: number;
  lines: number;
  slots: number;
  wishlist: number;
  decisions: number;
}

export interface CommitResult {
  counts: CommitCounts;
  /**
   * True when the copy had ALREADY been placed, so nothing was written (UIL-092 part 2, re-scoped by
   * UIL-098 part 2). Every count is zero. The caller treats it as success — the card IS placed — rather
   * than as an error, because the usual cause is a retry after a lost response: the first press landed,
   * and reporting the second as a failure is the failure mode UIL-092 fixed.
   */
  alreadyCommitted?: boolean;
  /**
   * True when the line her line-popup confirm concerned (the one she started, joined, swapped into, or kept) is DONE
   * once the write has landed: nothing in it left to chase (`lineDoneFor`, UIL-120). Read from the database after the
   * write, never from the browser. The Haul Plan's step-through stops there. False for a card with no line choice.
   */
  lineDone?: boolean;
  /**
   * The line her confirm concerned, as it reads after the write (UIL-120, Karvi 2026-09-27: "Confirm & next" never
   * opens another line's card): its id, and the species its open stages still want, so the step-through opens the next
   * card only when its re-routed proposal names THIS line (`sameLineWaiting`). A stage she left empty wants none.
   */
  line?: LineAfterWrite;
}

/** Her confirm's line after the write (UIL-120). */
export interface LineAfterWrite {
  lineId: string;
  /** Species (dex ids) its open stages still want: a placeholder that is not a stage she left empty. */
  openDexIds: number[];
}

/** The one rule (./line-done) over the line as it is now, and what it still wants: read AFTER her confirm's write. */
async function lineAfterWrite(
  db: DbClient,
  pc: PlanContext,
  lineId: string,
  incoming: PlannedCard,
): Promise<{ lineDone: boolean; line: LineAfterWrite }> {
  const [slots, line] = await Promise.all([
    lineSlotRepo.listByLine(db, lineId),
    evolutionLineRepo.getByPk(db, lineId),
  ]);
  const card = pc.catalogById.get(incoming.tcgdexId);
  // The family's chain, by stage: the species each stage wants, whether or not it names a target yet.
  const chain = card
    ? buildChain({ id: incoming.incomingId, card, variant: incoming.variant }, pc.ctx.catalog)
    : [];
  const open = slots.filter((s) => s.state === "placeholder" && s.stage_choice !== "empty");
  return {
    lineDone: lineDoneFor(
      slots.map((s) => s.state),
      line?.status,
    ),
    line: {
      lineId,
      openDexIds: open
        .map((s) => chain[s.stage_index]?.dexId)
        .filter((d): d is number => d !== undefined),
    },
  };
}

/**
 * The existing copies a draft is routing (UIL-003). Both the plan run and the commit must withhold
 * these from `ctx.owned` — see `LoadPlanContextOptions.excludeOwnedCopyIds` for why — so the helper
 * lives here and is shared with the server actions rather than re-derived at each call site.
 */
export function existingCopyIds(draft: DraftItem[]): string[] {
  return draft.map((d) => d.existingCopyId).filter((id): id is string => !!id);
}

/**
 * Resolve WHICH slot a copy is vacating and whether its line stops being complete (UIL-062).
 *
 * One resolver, because there are two callers in this file — the placement override and the confirmed
 * new-line pull — and they were resolving it differently. #151 gave the override a positive-match guard
 * and a demote lookup; the pull path had neither, so it released on "the copy has a pointer" alone and
 * never demoted. That is the drift `releaseSlotOps` was extracted to stop, one level up.
 *
 * POSITIVE MATCH, deliberately. A release fires only when the slot actually NAMES this copy. If it
 * names someone else the pointer was already crossed, and clearing the slot would evict a card that
 * never moved — turning a repair into a corruption. So: opt in on proof, not "release unless disproven".
 *
 * Resolved from the loaded context rather than from the client, the same rule `applyMove` follows.
 * Returns a tuple shaped for `releaseSlotOps`, and `[null, null]` when nothing should be released.
 */
function slotReleaseFor(
  copy: Row<"copy"> | undefined,
  pc: PlanContext,
): [slotId: string | null, demoteLineId: string | null] {
  const slotId = copy?.line_slot_id ?? null;
  if (!copy || !slotId) return [null, null];
  for (const [lineId, slots] of pc.slotRowsByLine) {
    const slot = slots.find((sl) => sl.id === slotId);
    if (!slot) continue;
    if (slot.copy_id !== copy.id) return [null, null];
    const line = pc.ctx.lines.find((l) => l.id === lineId);
    return [slotId, lineReadsClosed(line?.status) ? lineId : null];
  }
  return [null, null];
}

/** A line slot as the builder tracks it, mutated in place as fills are recorded so a later card in
 *  the SAME haul sees the earlier fill (mirrors the old live `listByLine` re-reads exactly). */
interface MutableSlot {
  id: string;
  stage_index: number;
  state: string;
  copy_id: string | null;
}

/**
 * Commit ONE card's placement, atomically, the moment she decides it (UIL-027).
 *
 * WHY THIS EXISTS, and what it changes. "Done, next card" was a pure client-side checkbox: it moved the
 * cursor and ticked the worklist and wrote nothing. Nothing persisted until a single "Commit the haul"
 * click wrote every card in the draft — including the hundreds she had never looked at — which is what
 * she described as treating unshelved cards as inventory. Working 50 of 700 cards and closing the tab
 * wrote zero rows.
 *
 * THE GUARANTEE THIS TRADES, stated rather than narrowed. M10 made the haul commit whole-haul atomic
 * specifically so "a commit that fails partway leaves ZERO rows". Per card, the unit of atomicity moves
 * from the haul to the card: a failure on card 340 of 700 leaves 1–339 genuinely shelved. That is a
 * DIFFERENT guarantee, not a weaker one — she physically put those 339 cards in binders, and a database
 * that disagrees with the shelf until a final button is pressed is the mismatch being reported. Each
 * card is still individually atomic: one `apply_write_ops` call, never sequenced repo writes (the
 * failure UIL-023 records for `applyMove`).
 *
 * A SIDE EFFECT THAT IS PURE GAIN. `buildHaulCommitPayload` carries a mutable slot mirror and a
 * `passLines` map so a later card in the SAME payload sees an earlier card's new line. Committing per
 * card makes that machinery unnecessary rather than broken: each card is planned against a context
 * re-read from the database, which now contains the previous card's committed writes. Reality is the
 * mirror.
 *
 * COST, flagged not hidden: this loads the full plan context per card, and that context pages the whole
 * catalog mirror. See `loadPlanContext`'s own note about scoping to the haul's dexId neighbourhoods —
 * that becomes load-bearing under this model, where it was merely flagged before.
 */
export async function commitCardPlacement(
  db: DbClient,
  input: {
    /** The single card being shelved: a copy waiting in her haul (UIL-003, UIL-098). */
    card: DraftItem;
    /** Her explicit placement for this card, if she overrode the cascade (M7). */
    override?: MoveDestination | null;
    /**
     * The `placementDigest` of what the screen was SHOWING when she clicked Done (UIL-045).
     *
     * The write re-derives from current state, so without this it can silently land somewhere other
     * than the pocket she read off the screen and physically used — DB right, shelf wrong, nothing
     * ever contradicting anything. When supplied and the fresh derivation disagrees, this refuses
     * instead of writing, and hands back the new placement for the screen to show.
     *
     * Optional, and absent means "do not check": the whole-haul path and the tests that predate this
     * have no digest to offer, and a cascade-placed card is still written correctly without one.
     * Ignored for an override, which cannot drift — `writeOverriddenCard` writes her destination
     * verbatim, so display and write already share one source.
     */
    expectedDigest?: string | null;
    /**
     * Her explicit resolution of a colour mismatch (UIL-069), when the spotlight showed one.
     * `"own-color"` is redundant with `override` being set (that IS the resolution) and is accepted
     * only for symmetry; the load-bearing value is `"line"` — the one case with no override to prove
     * she chose it. Required ALONGSIDE a matching `expectedDigest`, not instead of one: the flag alone
     * would be an unbacked client assertion (a careless caller could send `"line"` on every card
     * whether she was asked or not), while the digest is what proves this specific derivation — with
     * this specific mismatch — is the one she actually looked at. Absent/null ⇒ unresolved.
     */
    bandChoice?: "line" | "own-color" | null;
    /**
     * The collection she picked for a specialty card whose binder holds collections (UIL-053). Required
     * then, and only then; must be one of the binder's collections as they are NOW. Ignored for an
     * override, which names its own destination.
     */
    collectionChoice?: string | null;
    /**
     * Her "Shelve without a collection" for that card (0037, Karvi: "Users should always be able to override all
     * rules"): it goes in the binder on no collection's list, recorded as her override (collection_pick). Only with no
     * `collectionChoice`: a stale pick is refused either way. Ignored for an override, as `collectionChoice` is.
     */
    noCollection?: boolean | null;
    /**
     * The box she picked for the copy this card swaps out (a holo over her normal in a front half), when the plan can
     * name none because every box is full (0037). With `overFull` it goes over that box's limit, recorded. Only for a
     * swap written by the plan; ignored for an override (her Move skips the swap) and for any other card.
     */
    displacedTo?: BulkDestination | null;
    /**
     * Her choice in the line popup (UIL-117), REQUIRED for a card whose placement is in a line or that could
     * replace a card in one, unless she moved it instead (`override`). Start and join are written by the ONE line
     * builder over fresh state; a replace's Keep writes no line at all.
     *
     * With a back-half `override` it is her Move sheet's line popup (UIL-117: the one popup on every screen): that
     * line choice IS where the card goes, whatever the cascade routed it to.
     */
    lineChoice?: LineChoice | null;
  },
): Promise<CommitResult> {
  // UIL-070 part 1: the refusal `applyMove` makes, made here too. The panel disables Confirm for an
  // incomplete destination, but a stale tab or a caller that skips the panel could still send a bare
  // back-half shelf — which this path used to WRITE, as exactly UIL-056's strand: a back-half copy
  // with no line. Checked before any I/O; nothing to roll back.
  // A line choice is the line instruction for a back-half move, in place of the older `lineJoin` (`applyMove`'s rule).
  const movedIntoLine =
    !!input.lineChoice && input.override?.kind === "shelf" && input.override.half === "back";
  if (input.override && !movedIntoLine && !isMoveDestinationComplete(input.override)) {
    throw new Error(REFUSE.incomplete);
  }
  // A line choice rides only with a back-half move: with any other override the screen and the server disagree.
  if (input.override && input.lineChoice && !movedIntoLine) {
    throw new Error(LINE_CHOICE.notALineCard);
  }
  // 0037: the box she picks for a swapped-out copy is a bulk box, never anywhere else.
  if (input.displacedTo && input.displacedTo.kind !== "bulk") throw new Error(REFUSE.incomplete);
  // UIL-098 part 2: a row that names no copy is a hand-typed card, and placing it would CREATE one — the
  // twin the next import cannot see. Refused before any I/O.
  if (!input.card.existingCopyId) throw new Error(NOT_A_HAUL_COPY.notFromImport);

  const draft = [input.card];
  const pc = await loadPlanContext(db, { excludeOwnedCopyIds: existingCopyIds(draft) });

  /**
   * THE COPY MUST STILL BE WAITING IN HER HAUL (UIL-098 part 2). Costs no I/O: `loadPlanContext` has
   * already read every copy, and `copyRowById` is built before the `excludeOwnedCopyIds` filter.
   *
   * Gone ⇒ refuse: it was removed or merged since the plan was run, and there is nothing to place.
   *
   * Already placed ⇒ write NOTHING, and say so as success (UIL-092 part 2's rule, now for the only kind of
   * row there is). The usual cause is a retry after a lost response, where the first press landed; the
   * other is a second tab. Either way the card has a home, and re-running the cascade over it would MOVE
   * a card she has already put in a binder — the plan re-derives against current state, so a second write
   * can land somewhere other than the pocket she used.
   */
  const copy = pc.copyRowById.get(input.card.existingCopyId);
  if (!copy) throw new Error(NOT_A_HAUL_COPY.copyGone);
  if (isPlaced(copy.role as Role)) {
    return {
      counts: { routed: 0, lines: 0, slots: 0, wishlist: 0, decisions: 0 },
      alreadyCommitted: true,
    };
  }

  const { planned } = planFromDraft(pc, draft);

  /**
   * UIL-117: EVERY card headed into a line waits for her OK; the cascade no longer starts, fills or swaps a line on
   * its own. Her Move (`override`) is her OK too, and goes the way it always has (a card must always be movable).
   *   - start / join / swap: the ONE line builder, over fresh state, then this card, then its decision;
   *   - keep (the card already in the line stays): no line write. This card goes where she sent it (a kept upgrade
   *     always names where, the Senior BA's ruling).
   */
  let override = input.override ?? null;
  let overrideReason: string | null = null;
  /** A Keep writes no line, but it concerned one: the step-through asks whether that line is done (UIL-120). */
  let keptLineId: string | null = null;
  const lead = planned[0];
  /**
   * Her Move to a back half from the Plan's Move sheet, through its line popup (UIL-117; the Senior BA's follow-up to
   * #422): the ONE line builder writes her choice, stage choices and pulls included, as on Lines, Lookup and
   * Collections. A Keep is no move into a line.
   */
  if (lead && movedIntoLine && input.lineChoice) {
    const choice = input.lineChoice;
    if (choice.mode === "replace" && choice.keep) throw new Error(KEEP_IS_NO_LINE_MOVE);
    return commitLineChoice(db, pc, lead, copy, choice);
  }
  /**
   * UIL-126: a PLAIN extra copy of a stage a line holds is not a line card; a normal Done files it in the front half.
   * Her one line choice for it is "⇄ Swap this one into the line…": a swap into exactly the line and slot it
   * duplicates. Any other line choice sent for a card that is not a line card is REFUSED, never quietly ignored
   * (TL review): it would mean the screen and the server disagree about the card.
   */
  if (lead && !isLineCard(lead.result) && !override && input.lineChoice) {
    const choice = input.lineChoice;
    const fs =
      lead.result.step === "line-existing" && !lead.result.swap ? lead.result.filledStage : null;
    const slotId = fs ? (pc.lookups.lines?.slotIdAt(fs.lineId, fs.stageIndex) ?? null) : null;
    if (
      !fs ||
      choice.mode !== "replace" ||
      choice.keep ||
      choice.lineId !== fs.lineId ||
      choice.slotId !== slotId
    ) {
      throw new Error(LINE_CHOICE.notALineCard);
    }
    return commitLineChoice(db, pc, lead, copy, choice);
  }
  if (lead && isLineCard(lead.result) && !override) {
    const choice = input.lineChoice;
    if (!choice) throw new Error(LINE_CHOICE.missing);
    if (choice.mode === "replace" && choice.keep) {
      // Keep means "the card already in the line stays". Only an UPGRADE of a card in a line has that choice (a plain
      // extra copy is not a line card since UIL-126); sent for any other line card it would fall through to the
      // cascade, which writes the line itself (TL review).
      if (!lead.result.swap) throw new Error(LINE_CHOICE.missing);
      // The line it concerned, from the server's own derivation (the upgrade's slot), not the browser's (QA on #410).
      const heldSlot = lead.result.swap.incomingInherits.lineSlotId;
      keptLineId = heldSlot ? (pc.lookups.lines?.lineOfSlot(heldSlot) ?? null) : null;
      // A kept upgrade always names where it goes (the Senior BA's ruling; bulk suggested).
      if (!choice.incoming) throw new Error(LINE_CHOICE.holoNeedsHome);
      if (!isMoveDestinationComplete(choice.incoming)) throw new Error(REFUSE.incomplete);
      override = choice.incoming;
      overrideReason =
        "Kept the card already in the line (her call, UIL-117); this copy went where she sent it.";
    } else {
      return commitLineChoice(db, pc, lead, copy, choice);
    }
  }

  // A colour mismatch (UIL-069) is never a silent default. "File by its own colour" arrives as
  // `override` below and is drift-proof by construction; nothing further to check. "Join the line"
  // has no override to carry — it IS the cascade's own placement — so it is refused unless she
  // explicitly confirmed it via `bandChoice` AND that confirmation is backed by a matching
  // `expectedDigest`. `bandChoice` alone would be an unbacked client assertion: a stale or careless
  // caller could send `"line"` on every card regardless of whether she was ever actually asked, which
  // is the exact silent default this whole check exists to prevent.
  if (
    planned[0]?.result.bandMismatch &&
    !override &&
    (input.bandChoice !== "line" || !input.expectedDigest)
  ) {
    throw new Error(
      "This card's own colour differs from the line it would join — pick which one wins before confirming.",
    );
  }

  // UIL-053: in a binder that holds collections, the card joins the one she picked, or, her override (0037), none.
  const pick = planned[0]?.result.collectionPick;
  let withoutCollection = false;
  if (pick && !override) {
    if (input.collectionChoice) {
      if (!pick.collections.some((c) => c.id === input.collectionChoice)) {
        throw new Error(COLLECTION_PICK.notHere);
      }
    } else if (input.noCollection === true) {
      withoutCollection = true;
    } else {
      throw new Error(COLLECTION_PICK.missing);
    }
  }

  // Compare BEFORE building the payload, so a conflict costs nothing and writes nothing.
  if (input.expectedDigest && !override && planned[0]) {
    const actual = placementDigest(planned[0].result);
    if (actual !== input.expectedDigest) {
      throw new PlacementChangedError(
        derivePlacementFrom(pc, input.card)?.item ?? null,
        input.expectedDigest,
        actual,
      );
    }
  }

  const { payload, counts } = buildHaulCommitPayload(pc, planned, {
    draft,
    overrides: override ? { [input.card.id]: override } : undefined,
    overrideReasons: overrideReason ? { [input.card.id]: overrideReason } : undefined,
    collectionChoices:
      pick && !override && input.collectionChoice
        ? { [input.card.id]: input.collectionChoice }
        : undefined,
    withoutCollection: withoutCollection ? { [input.card.id]: true } : undefined,
    displacedTo:
      input.displacedTo && !override && planned[0]?.result.swap
        ? { [input.card.id]: input.displacedTo }
        : undefined,
  });
  assertPlacementBandsConfigured(payload, pc);
  assertPlacementBindersConfigured(payload, pc);
  await applyWriteOps(db, payload);
  if (!keptLineId || !lead) return { counts, lineDone: false };
  return { counts, ...(await lineAfterWrite(db, pc, keptLineId, lead)) };
}

/** How her line-popup choice is named in the decision history (UIL-117). */
const LINE_DECISION = {
  start: {
    decision: "line-start",
    reason: "Started this line (her call in the line popup, UIL-117).",
  },
  join: {
    decision: "line-join",
    reason: "Added to this line (her call in the line popup, UIL-117).",
  },
  replace: {
    decision: "line-replace",
    reason:
      "Swapped into this line; the card it replaced went where she sent it (her call in the line popup, UIL-117).",
  },
} as const;

/**
 * Her line-popup choice for one card (UIL-117): start a line, join one, or swap a card in one. The ONE line builder
 * writes the line side from fresh state (`buildBackHalfLineOps`, which checks the choice against its line, or a
 * start against where the card is going); this card then goes into the slot it names, in the LINE's binder and band,
 * and its decision records her call. One `apply_write_ops` call; 0028's slot check runs on all of it.
 */
async function commitLineChoice(
  db: DbClient,
  pc: PlanContext,
  p: PlannedCard,
  copy: Row<"copy">,
  choice: Exclude<LineChoice, { mode: "replace"; keep: true }>,
): Promise<CommitResult> {
  let dest: Extract<MoveDestination, { kind: "shelf" }>;
  if (choice.mode === "start") {
    dest = { kind: "shelf", binderId: choice.binderId, half: "back", band: choice.band };
  } else {
    const line = pc.ctx.lines.find((l) => l.id === choice.lineId);
    if (!line) throw new Error(LINE_CHOICE.lineGone);
    // UIL-127a: a line whose binder was deleted has nowhere to take the card; say so, not "another binder".
    if (!line.binderId) throw new Error(NO_BINDER.refusal(cardName(pc, p.tcgdexId)));
    dest = { kind: "shelf", binderId: line.binderId, half: "back", band: line.colorBand };
  }
  const built = await buildBackHalfLineOps(db, copy, dest, choice, { reads: lineWriteReadsOf(pc) });
  const ops: WriteOp[] = [...built.ops];
  const counts: CommitCounts = {
    routed: 0,
    lines: ops.filter((o) => o.op === "insert_line").length,
    slots: ops.filter((o) => o.op === "insert_slot").length,
    wishlist: ops.filter((o) => o.op === "insert_wishlist").length,
    decisions: 0,
  };
  // After the line side, so the slot this card points at already exists (a start inserts it).
  const copyId = emitIncomingCopy(
    ops,
    p,
    {
      role: "shelved",
      binderId: dest.binderId,
      binderHalf: "back",
      colorBand: dest.band,
      lineSlotId: built.slotId,
    },
    counts,
  );
  const started = ops.find((o) => o.op === "insert_line");
  // UIL-069's honest audit, kept: a card joined to a line of another colour says she chose the line over its own.
  const named =
    choice.mode === "join" && p.result.bandMismatch
      ? {
          decision: "colour-mismatch-join-line",
          reason:
            "Colour mismatch resolved at intake (her call, UIL-069): joined the existing line over filing by its own colour.",
        }
      : LINE_DECISION[choice.mode];
  ops.push({
    op: "insert_decision",
    haul_id: null,
    copy_id: copyId,
    ...named,
    resolved_by: "user",
    line_id:
      choice.mode === "start" ? (started?.op === "insert_line" ? started.id : null) : choice.lineId,
    line_slot_id: built.slotId,
  });
  counts.decisions += 1;
  // 0037: what she overrides, from every place her line choice sends a card; the line builder records its own.
  const payload: WritePayload = { ops, overrides: overridesFor(lineChoiceDestinations(choice)) };
  assertPlacementBandsConfigured(payload, pc);
  assertPlacementBindersConfigured(payload, pc);
  await applyWriteOps(db, payload);
  const lineId =
    choice.mode === "start" ? (started?.op === "insert_line" ? started.id : null) : choice.lineId;
  if (!lineId) return { counts, lineDone: false };
  return { counts, ...(await lineAfterWrite(db, pc, lineId, p)) };
}

/**
 * What the line builder reads, from the plan context this commit has already loaded (the Tech Lead's measurement,
 * 2026-10: a Haul Plan line confirm read every copy, line, slot and block, and the whole catalog, a second time). The
 * same rows: the context was read at the start of this request and nothing is written before the one write below.
 * Undefined for an older test context without the raw line rows: the builder then reads them itself.
 */
function lineWriteReadsOf(pc: PlanContext): LineWriteReads | undefined {
  if (!pc.lineRowById || !pc.blockRowsByLine) return undefined;
  return {
    catalog: pc.ctx.catalog,
    catalogById: pc.catalogById,
    typeColorMap: pc.ctx.typeColorMap,
    copiesById: pc.copyRowById,
    lines: pc.lineRowById,
    slotsByLine: pc.slotRowsByLine,
    blocksByLine: pc.blockRowsByLine,
    ...(pc.bulkUnits ? { boxNames: new Map(pc.bulkUnits.map((u) => [u.id, u.name])) } : {}),
  };
}

/**
 * Guard the write set before it reaches the DB: every colour band it stores must be a configured
 * band (a `color_band` key in `orderedBandKeys`). A band that is not — a display name leaking into
 * DB-key space, or a type mapped to a band `color_band` does not have (UIL-012) — would otherwise
 * fail `copy_color_band_fkey` mid-commit as an opaque 23503 naming neither the card nor the type.
 * This converts that into an actionable message, for THIS and every future cause. Pure (no I/O);
 * the atomic RPC still guarantees nothing is half-written if it somehow slips past.
 */
export function assertPlacementBandsConfigured(payload: WritePayload, pc: PlanContext): void {
  const known = new Set(pc.orderedBandKeys);
  const describe = (catalogCardId: string | null | undefined): string => {
    if (!catalogCardId) return "a copy";
    const card = pc.catalogById.get(catalogCardId);
    return card ? `${card.name} (${card.tcgdexId}, type ${effectiveType(card)})` : catalogCardId;
  };
  for (const op of payload.ops) {
    let bandKey: string | null | undefined;
    let subject: string;
    if (op.op === "insert_copy") {
      bandKey = op.color_band;
      subject = describe(op.catalog_card_id);
    } else if (op.op === "update_copy") {
      bandKey = op.patch.color_band;
      subject = describe(pc.copyRowById.get(op.id)?.catalog_card_id);
    } else if (op.op === "insert_line") {
      bandKey = op.color_band;
      subject = `the evolution line for dex #${op.root_dex_id}`;
    } else {
      continue;
    }
    // null clears a placement (bulk / specialty) and is always valid; undefined means the patch does
    // not touch the band. Only a present, non-null band that is not configured is a fault.
    if (bandKey != null && !known.has(bandKey)) {
      throw new Error(
        `Cannot commit: ${subject} resolved to colour band "${bandKey}", which is not one of the ` +
          `configured bands [${pc.orderedBandKeys.join(", ")}]. Check type_color_map and color_band ` +
          `in Settings — a display name such as "White" where the key "white" is expected is the ` +
          `usual cause.`,
      );
    }
  }
}

/** A card's name for her words, or "This card" when the catalog does not hold it. */
function cardName(pc: PlanContext, catalogCardId: string | null | undefined): string {
  const card = catalogCardId ? pc.catalogById.get(catalogCardId) : undefined;
  return card?.name ?? "This card";
}

/**
 * Guard the write set against shelving a card in NO binder, or in one that is not hers (UIL-127a). A new account
 * has no binder until she adds one, and the cascade then routes every shelf target to `binderId: null`; that used to
 * commit as a shelved card with no binder, which no screen could find. Pure (no I/O), like the band guard above.
 *
 * Only what the payload SETS is checked (the Tech Lead's C3): a copy left binderless by a binder being deleted is
 * never refused for being touched, so a card stays movable. `pc.ctx.binders` is read through RLS, so a binder id
 * that is not hers is "unknown" here too.
 */
export function assertPlacementBindersConfigured(payload: WritePayload, pc: PlanContext): void {
  const known = new Set(pc.ctx.binders.map((b) => b.id));
  const nameOf = (catalogCardId: string | null | undefined) => cardName(pc, catalogCardId);
  const shelves = (role: string | undefined) => role === "shelved" || role === "block";
  for (const op of payload.ops) {
    if (op.op === "insert_copy") {
      if (shelves(op.role) && (op.binder_id == null || !known.has(op.binder_id))) {
        throw new Error(NO_BINDER.refusal(nameOf(op.catalog_card_id)));
      }
    } else if (op.op === "update_copy") {
      if (!("binder_id" in op.patch)) continue;
      const role = op.patch.role ?? pc.copyRowById.get(op.id)?.role;
      const binderId = op.patch.binder_id;
      if (shelves(role) && (binderId == null || !known.has(binderId))) {
        throw new Error(NO_BINDER.refusal(nameOf(pc.copyRowById.get(op.id)?.catalog_card_id)));
      }
    } else if (op.op === "insert_line") {
      if (op.binder_id == null || !known.has(op.binder_id)) {
        throw new Error(NO_BINDER.refusal(`The evolution line for dex #${op.root_dex_id}`));
      }
    } else if (op.op === "insert_binder_block") {
      // UIL-121: a pocket's filler (an energy has no copy of its own to check) is in one of her binders too.
      if (!known.has(op.binder_id)) throw new Error(NO_BINDER.refusal("That filler"));
    }
  }
}

/**
 * Build the fully-resolved, ordered write set for a haul commit (PURE — no I/O). Emitted in the exact
 * dependency order the previous per-row writes used, so it is FK-safe when applied verbatim.
 */
export function buildHaulCommitPayload(
  pc: PlanContext,
  planned: PlannedCard[],
  input: CommitInput,
): { payload: WritePayload; counts: CommitCounts } {
  const ops: WriteOp[] = [];
  const counts: CommitCounts = {
    routed: 0,
    lines: 0,
    slots: 0,
    wishlist: 0,
    decisions: 0,
  };

  // Live-slot mirror: seeded from the DB snapshot, mutated as fills are recorded this pass.
  const slotsByLine = new Map<string, MutableSlot[]>();
  for (const [lineId, rows] of pc.slotRowsByLine) {
    slotsByLine.set(
      lineId,
      rows.map((r) => ({
        id: r.id,
        stage_index: r.stage_index,
        state: r.state,
        copy_id: r.copy_id,
      })),
    );
  }

  // Lines created THIS pass, so a second card of the same (root, band) fills instead of duplicating.
  const passLines = new Map<string, { lineId: string }>();
  // 0037: the rules her choices override, each recorded on its card's decision below and declared on the write.
  const declared = new Set<OverrideRule>();

  for (const p of planned) {
    const override = input.overrides?.[p.incomingId];
    // UIL-069: by this point a mismatch has already been resolved one way or the other —
    // `commitCardPlacement` refuses before reaching here (its only caller now that the whole-haul
    // `commitHaul` entry point is gone) — this only picks the HONEST audit text for whichever way it
    // went, so the trail says what she actually chose rather than reusing `p.result.reason`, which
    // always describes the LINE option regardless of her pick.
    const mismatch = p.result.bandMismatch;
    if (override) {
      // Manual placement wins: place the copy where she said, skip all cascade side effects.
      const copyId = writeOverriddenCard(ops, p, override, pc, slotsByLine, passLines, counts);
      const reason =
        (input.overrideReasons?.[p.incomingId] ??
          (mismatch
            ? "Colour mismatch resolved at intake (her call, UIL-069): filed by its own colour rather " +
              "than joining the existing line."
            : `Manual placement override at intake (your call, cascade skipped): ${p.result.reason}`)) +
        overLimitNote([override]);
      // A full box she picked knowingly (0037) is recorded on this card's decision.
      const rules = overridesFor([override]);
      for (const r of rules) declared.add(r);
      ops.push(
        recordOverrides(
          {
            op: "insert_decision",
            haul_id: null,
            copy_id: copyId,
            decision: mismatch ? "colour-mismatch-own-color" : "placement-override",
            reason,
            resolved_by: "user",
          },
          rules,
        ),
      );
      counts.decisions += 1;
      continue;
    }
    // A card headed into a line is written only through her line choice (UIL-117: `commitLineChoice`) or her Move
    // (above). The cascade no longer starts, fills or swaps a line on its own; a line card here would mean the screen
    // and the server disagree about it, so it is refused, never written.
    if (isLineCard(p.result)) throw new Error(LINE_CHOICE.missing);
    // 0037: the box she picked for the copy a swap displaces (every box full), recorded on this card's decision.
    const displaced = p.result.swap ? input.displacedTo?.[p.incomingId] : undefined;
    const displacedRules = overridesFor([displaced]);
    for (const r of displacedRules) declared.add(r);
    const copyId = writeCard(ops, p, pc, counts, displaced);
    // UIL-053: the card goes on the list of the collection she picked, in the same transaction as its
    // placement, so it is never in the binder and on no list.
    const picked = p.result.collectionPick?.collections.find(
      (c) => c.id === input.collectionChoices?.[p.incomingId],
    );
    if (picked) {
      ops.push({
        op: "union_collection_targets",
        collection_id: picked.id,
        catalog_card_ids: [p.tcgdexId],
      });
    }
    // 0037: her "Shelve without a collection", in a binder that holds collections: on no list, as her override.
    const without =
      !picked && !!p.result.collectionPick && input.withoutCollection?.[p.incomingId] === true;
    if (without) declared.add("collection_pick");
    const reason = picked
      ? `Specialty card filed in the "${picked.name}" collection (her pick, UIL-053).`
      : without
        ? "Specialty card shelved in its binder with no collection (your call): it counts toward none."
        : p.result.reason + overLimitNote([displaced]);
    ops.push(
      recordOverrides(
        {
          op: "insert_decision",
          haul_id: null,
          copy_id: copyId,
          decision: p.result.step,
          reason,
          resolved_by: picked || without || displaced ? "user" : "auto",
        },
        [...(without ? (["collection_pick"] as const) : []), ...displacedRules],
      ),
    );
    counts.decisions += 1;
  }

  return { payload: { ops, ...(declared.size > 0 ? { overrides: [...declared] } : {}) }, counts };
}

/**
 * Emit the incoming copy with its placement, and a swap's displaced copy to the bulk box. Returns its id. Only a card
 * that is NOT headed into a line reaches here (`buildHaulCommitPayload` refuses one): a line is written by her line
 * choice alone (UIL-117), so the cascade's own line writes (fill a slot, start a line, a swap inside a line) are gone.
 */
function writeCard(
  ops: WriteOp[],
  p: PlannedCard,
  pc: PlanContext,
  counts: CommitCounts,
  /** 0037: the box she picked for the copy a swap displaces (absent: the box the plan names, if any). */
  displaced?: BulkDestination,
): string {
  const { result } = p;

  // Placement columns. An upgrade inherits the displaced copy's role wholesale (system-design §3).
  const swap = result.swap;
  const placement = swap
    ? {
        role: "shelved" as const,
        binderId: swap.incomingInherits.binderId,
        binderHalf: swap.incomingInherits.binderHalf,
        colorBand: swap.incomingInherits.colorBand,
      }
    : copyPlacementFromTarget(result.target);
  // UIL-130: where the plan sends a card to bulk on its own, the box with room it names (her default first). None with
  // room: no box named, and the database refuses in her words rather than overfill one.
  const routeBox = pc.bulkUnits ? bulkUnitForRoute(pc.bulkUnits) : null;

  const copyId = emitIncomingCopy(
    ops,
    p,
    placement.role === "bulk" && routeBox ? { ...placement, bulkUnitId: routeBox } : placement,
    counts,
  );

  if (swap) {
    // The displaced normal copy goes to the bulk box: the one she picked (0037), else the one the plan names.
    const out = pc.copyRowById.get(swap.displacedCopyId);
    const box = displaced?.unitId ?? routeBox;
    if (out) {
      ops.push({
        op: "update_copy",
        id: out.id,
        patch: {
          role: "bulk",
          binder_id: null,
          binder_half: null,
          color_band: null,
          line_slot_id: null,
          ...(box ? { bulk_unit_id: box } : {}),
        },
      });
    }
  }
  return copyId;
}

/**
 * Emit a copy at a manual override placement (M7). No line/swap side effects; audited as user.
 *
 * An override into a `{kind: "collection"}` destination has to do BOTH halves of collection membership
 * (UIL-022): shelve the copy in the collection's binder AND put the catalog id on that collection's
 * `target_catalog_card_ids`. Doing only the first leaves the card invisible in the very collection
 * holding it while occupying a real pocket — a card she would have to find by hand to discover.
 *
 * The membership op comes from `collectionTargetJoinOp` (lib/line/move.ts), the same single definition
 * the Line-screen move and the collection-removal path use, so "joining a collection" cannot mean two
 * different things depending on which screen she used. Unlike the Line move, this path needed no
 * atomicity work: the haul commit was already one `apply_write_ops` transaction, so the union simply
 * joins the payload and lands with the copy or not at all.
 */
function writeOverriddenCard(
  ops: WriteOp[],
  p: PlannedCard,
  dest: MoveDestination,
  pc: PlanContext,
  slotsByLine: Map<string, MutableSlot[]>,
  passLines: Map<string, { lineId: string }>,
  counts: CommitCounts,
): string {
  const placement = placementForMove(dest);

  /**
   * RELEASE THE SLOT SHE IS MOVING IT OUT OF (UIL-062).
   *
   * `placementForMove` clears `line_slot_id` for every destination kind — correctly, since no
   * `MoveDestination` can express "into a line slot". But this function skipped every line side effect,
   * so the copy side was written and the slot side was not: the vacated slot kept `state: 'filled'`
   * naming a copy that was no longer in it. The Lines page reads the SLOT, so it rendered as occupied
   * by a card that had moved, and nothing on screen contradicted it. Measured on Testing as 5 stale
   * slots, 4 of them from exactly this path.
   *
   * Resolved from the context we already hold rather than from the client — the same rule
   * `applyMove` follows — and emitted through the shared `releaseSlotOps` so the Line screen's release
   * and this one cannot drift.
   */
  const existing = p.existingCopyId ? pc.copyRowById.get(p.existingCopyId) : undefined;
  const [leavingSlotId, demoteLineId] = slotReleaseFor(existing, pc);
  if (leavingSlotId) {
    ops.push(...releaseSlotOps(leavingSlotId, demoteLineId));
    // Keep the in-pass mirror honest, or a later card in the same sitting would think the slot is
    // still filled and skip a stage it could now use.
    touchSlot(slotsByLine, leavingSlotId, null);
  }

  /**
   * THE LINE SHE PICKED (UIL-070 part 1). A back-half destination carries her `lineJoin` — UIL-056's
   * invariant, checked upstream by `isMoveDestinationComplete` — and this path used to drop it on the
   * floor: `placementForMove` nulls `line_slot_id` for every kind, so the copy landed in the back half
   * with no line and the picker's answer was never written (the UIL-045 shape, a screen showing one
   * thing and the write doing another).
   *
   * Resolved against the loaded snapshot and this pass's mirror — never trusted from the client — and
   * emitted through the SAME builders `applyMove` uses, so joining a line means one thing whichever
   * screen she did it from. An EXISTING slot is known before the copy is emitted, so the copy can
   * carry its `line_slot_id` directly; a NEW line's slots do not exist until their ops run, so the copy
   * goes in first, the line and slots reference it, and a final `update_copy` points back — the order
   * `writeNewLine` already uses for the cascade's own lines. Because she picked the line herself in the
   * picker, a band that differs from the card's own is her explicit choice: no UIL-069 ask applies.
   */
  const join = lineJoinOf(dest);
  let existingJoin: { lineId: string; slotId: string; slotIsLastOpen: boolean } | null = null;
  if (join?.mode === "existing") {
    const siblings = slotsByLine.get(join.lineId);
    const slot = siblings?.find((s) => s.id === join.slotId);
    if (!siblings || !slot) throw new Error(REFUSE.slotGone);
    if (slot.state === "filled") throw new Error(REFUSE.slotFilled);
    existingJoin = {
      lineId: join.lineId,
      slotId: slot.id,
      slotIsLastOpen: siblings.every((s) => s.id === slot.id || s.state === "filled"),
    };
  }

  // A block override must point at an OPEN need in this snapshot (UIL-030): a block slot of that line,
  // with no line-terminated binder_block yet. Resolved from the context, never trusted from the client.
  if (dest.kind === "block") {
    const slot = pc.slotRowsByLine.get(dest.lineId)?.find((s) => s.id === dest.slotId);
    if (!slot || slot.state !== "block") throw new Error(REFUSE.blockSlotGone);
    if (!(pc.blockNeeds ?? []).some((n) => n.slotId === dest.slotId))
      throw new Error(REFUSE.blockFilled);
  }

  const copyId = emitIncomingCopy(
    ops,
    p,
    {
      role: placement.role,
      binderId: placement.binder_id,
      binderHalf: placement.binder_half,
      colorBand: placement.color_band,
      lineSlotId: existingJoin?.slotId ?? placement.line_slot_id,
      // UIL-130: the box her Move named (absent: her default box).
      bulkUnitId: placement.bulk_unit_id ?? null,
    },
    counts,
  );
  // Becoming a binder block writes the row that closes the open need (UIL-030), same builder as applyMove.
  if (dest.kind === "block") ops.push(...blockOps(dest, copyId));

  if (existingJoin) {
    ops.push(...buildExistingLineJoinOps({ copyId, ...existingJoin }).ops);
    touchSlot(slotsByLine, existingJoin.slotId, copyId);
  } else if (join?.mode === "new" && dest.kind === "shelf") {
    const card = pc.catalogById.get(p.tcgdexId);
    if (!card) throw new Error(REFUSE.catalogMissing);
    const built = buildNewLineJoinOps({
      incoming: { id: copyId, card, variant: p.variant },
      catalog: pc.ctx.catalog,
      typeColorMap: pc.ctx.typeColorMap,
      binderId: dest.binderId,
      destinationBand: dest.band,
    });
    // NO "a line already exists here" refusal (UIL-096) — the same ruling `applyMove` follows. She asked
    // for a new line explicitly, having been shown every line the family already has; starting a second
    // one in this binder and band is her call. The key below is kept only for the in-pass bookkeeping, so
    // a later card in THIS payload can find the line just created — it no longer decides anything.
    const locale = localeOfId(p.tcgdexId);
    const key = passLineKey(
      dest.binderId,
      built.rootDexId,
      dest.band,
      locale,
      formOf(card, pc.ctx.catalog),
    );
    ops.push(...built.ops);
    if (built.slotId) {
      ops.push({ op: "update_copy", id: copyId, patch: { line_slot_id: built.slotId } });
    }
    // Mirror + pass bookkeeping, as `writeNewLine` does, so a later card this pass sees the new line.
    const lineOp = built.ops.find((o) => o.op === "insert_line");
    const mirror: MutableSlot[] = built.ops
      .filter((o): o is Extract<WriteOp, { op: "insert_slot" }> => o.op === "insert_slot")
      .map((o) => ({
        id: o.id,
        stage_index: o.stage_index,
        state: o.state,
        copy_id: o.copy_id ?? null,
      }));
    if (lineOp?.op === "insert_line") {
      slotsByLine.set(lineOp.id, mirror);
      passLines.set(key, { lineId: lineOp.id });
      counts.lines += 1;
      counts.slots += mirror.length;
    }
  }

  const collectionJoin = collectionTargetJoinOp(dest, p.tcgdexId);
  if (collectionJoin) ops.push(collectionJoin);

  return copyId;
}

/**
 * Write the incoming card's placement and return the copy id it lives on: the copy waiting in her haul.
 *
 * It PATCHES that row and never inserts one (UIL-098 part 2). This used to be the one place the
 * new-vs-routed split was decided (UIL-003), with an `insert_copy` branch for a hand-typed card; that
 * branch is gone, and this function refuses a row without `existingCopyId` (below) rather than write one.
 * The patch names all five placement columns explicitly because `CopyPatch` writes exactly the keys
 * present (a missing key is left unchanged, which would strand a stale placement); it deliberately omits
 * `variant` / `dex_variant_raw` / `haul_id`, which are not this pass's to change.
 */
function emitIncomingCopy(
  ops: WriteOp[],
  p: PlannedCard,
  placement: {
    // `Role`, not just shelved/bulk: a move override can place a card as a repurposed binder block.
    role: Role;
    binderId: string | null;
    binderHalf: "front" | "back" | null;
    colorBand: string | null;
    lineSlotId?: string | null;
    /** UIL-130: the bulk box, when one is named. Absent: the database gives a bulk copy her default box. */
    bulkUnitId?: string | null;
  },
  counts: CommitCounts,
): string {
  // The builder's refusal of a hand-typed row (UIL-098), not only `commitCardPlacement`'s: the builder is
  // exported, so a caller that skipped the per-card guard must still not turn a typed row into a copy.
  // Every card reaches here, and `ops` is local, so a throw returns no payload at all.
  if (!p.existingCopyId) throw new Error(NOT_A_HAUL_COPY.notFromImport);
  ops.push({
    op: "update_copy",
    id: p.existingCopyId,
    patch: {
      role: placement.role,
      binder_id: placement.binderId,
      binder_half: placement.binderHalf,
      color_band: placement.colorBand,
      line_slot_id: placement.lineSlotId ?? null,
      ...(placement.bulkUnitId ? { bulk_unit_id: placement.bulkUnitId } : {}),
    },
  });
  counts.routed += 1;
  return p.existingCopyId;
}

/**
 * Update the live slot mirror so a later card in the same pass sees this change.
 *
 * `copyId: null` RELEASES the slot rather than filling it (UIL-061/UIL-062) — a confirmed pull or an
 * override vacates whatever slot the copy was in, and the mirror has to agree with the ops or a later
 * card in the same pass would fill a slot this one just emptied, or skip a stage it just freed.
 */
function touchSlot(
  slotsByLine: Map<string, MutableSlot[]>,
  slotId: string,
  copyId: string | null,
): void {
  for (const slots of slotsByLine.values()) {
    const slot = slots.find((s) => s.id === slotId);
    if (slot) {
      slot.state = copyId ? "filled" : "placeholder";
      slot.copy_id = copyId;
      return;
    }
  }
}

/**
 * The in-pass key for a line created earlier in THIS payload — the same (binder, species, band). The same identity the
 * Haul Plan's step-through gives a line a start would write (`newLineKey`, UIL-120).
 */
function passLineKey(
  binderId: string | null,
  rootDexId: number,
  colorBand: string,
  locale: Locale,
  form: CardForm,
): string {
  return newLineKey(binderId, rootDexId, colorBand, locale, form);
}
