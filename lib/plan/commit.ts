/**
 * Commit a haul (dev-spec §5 M6; system-design §4, §7B step 6).
 *
 * Re-runs the cascade over the draft (deterministic against current DB state) and writes every
 * record it implies: the Haul, a Copy per card, EvolutionLine + LineSlots for new lines, slot fills
 * for existing lines, holo-swap displacements, WishlistItems for placeholders, and a
 * PlacementDecision per card (reason + resolvedBy — the audit trail is not optional, dev-spec §4).
 *
 * TWO KINDS OF DRAFT ENTRY (UIL-003). An entry either takes in a NEW card (typed intake → a fresh
 * `copy` row stamped with this haul) or ROUTES AN EXISTING unplaced one (`existingCopyId` set → the
 * placement columns of that row are updated in place). The second kind is how sync's additions reach
 * the cascade: sync creates copies unplaced on purpose (sync-architecture §1.1) and the plan is where
 * they get a home. Creating new rows for them instead would DOUBLE her counts, so the distinction is
 * load-bearing, not cosmetic.
 *
 * A routed copy is never stamped with a `haul_id` — it was not acquired in this haul — and its
 * `variant` / `dex_variant_raw` are left alone, because Dex owns the variant field (sync-architecture
 * §1.1) and the next import would overwrite anything we wrote. A pass made up entirely of routed
 * copies writes NO haul row at all; its decisions carry `haul_id: null`.
 *
 * ATOMICITY (M10). The whole write set is computed here in TS — the cascade/decision logic stays
 * pure — then applied in ONE transaction by the `apply_write_ops` RPC (migration 0006). Row UUIDs are
 * generated client-side (`crypto.randomUUID`) so line→slot→copy cross-references resolve before
 * insert. This replaces the earlier compensating-rollback interim: a commit that fails partway now
 * leaves ZERO rows. Writes run under the RLS-scoped client from the auth seam (lib/plan/session.ts)
 * and the RPC is SECURITY INVOKER, so `owner_id` is never stamped — it defaults to `auth.uid()` and
 * the RLS `with check (owner_id = auth.uid())` policy enforces it.
 */

import { effectiveType, type Role } from "@/lib/engine";
import {
  applyWriteOps,
  type DbClient,
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
  LINE_EXISTS_IN_BINDER,
  lineJoinOf,
  placementForMove,
  releaseSlotOps,
} from "@/lib/line/move";
import type { MoveDestination } from "@/lib/line/types";

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
  /** UIL-084: keyed on the BINDER too, and its remedies both exist. Shared string, see lib/line/move.ts. */
  lineExists: LINE_EXISTS_IN_BINDER,
  catalogMissing: "That card's catalog entry is missing — reload and try again.",
} as const;
import { copyPlacementFromTarget } from "./placement";
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

export type HaulSource = "bulk-bin" | "pack-rip" | "show" | "trade";

export interface CommitInput {
  source: HaulSource;
  notes?: string | null;
  draft: DraftItem[];
  /**
   * Per-incoming-card placement overrides (M7 — placement override on ALL cards; keyed by draft id).
   * An overridden card is placed exactly where she says (binder+half+band / collection / bulk) with a
   * `resolved_by: 'user'` audit row, and the cascade's line/swap side effects are skipped for it.
   * Absent/empty ⇒ identical to the pure cascade commit.
   */
  overrides?: Record<string, MoveDestination>;
  /**
   * Join an existing haul instead of opening a new one (UIL-027). A per-card commit threads the id the
   * FIRST card returned through the rest of the sitting, so the sitting remains one haul in the audit
   * trail even though every card is now its own transaction. Absent ⇒ a haul is opened if the pass
   * takes in any new card, exactly as before.
   */
  existingHaulId?: string | null;
}

export interface CommitCounts {
  /** NEW copy rows written (typed intake). */
  copies: number;
  /** EXISTING unplaced copies given a placement (UIL-003) — no new rows. */
  routed: number;
  lines: number;
  slots: number;
  wishlist: number;
  decisions: number;
}

export interface CommitResult {
  /** Null when the pass only routed existing copies, so no acquisition event happened. */
  haulId: string | null;
  counts: CommitCounts;
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
    return [slotId, line?.status === "complete" ? lineId : null];
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
    source: HaulSource;
    notes?: string | null;
    /** The single card being shelved — a typed entry, or a routed existing copy (UIL-003). */
    card: DraftItem;
    /** Her explicit placement for this card, if she overrode the cascade (M7). */
    override?: MoveDestination | null;
    /** The haul this sitting already opened; null/absent opens one on the first new card. */
    haulId?: string | null;
    /**
     * Copy ids she ticked to relocate into the line this card starts (UIL-061). Absent means MOVE
     * NOTHING — the default is deliberately the safe one, so a caller that forgets to thread it
     * through leaves her collection alone rather than relocating it.
     */
    confirmedPulls?: string[];
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
  },
): Promise<CommitResult> {
  // UIL-070 part 1: the refusal `applyMove` makes, made here too. The panel disables Confirm for an
  // incomplete destination, but a stale tab or a caller that skips the panel could still send a bare
  // back-half shelf — which this path used to WRITE, as exactly UIL-056's strand: a back-half copy
  // with no line. Checked before any I/O; nothing to roll back.
  if (input.override && !isMoveDestinationComplete(input.override)) {
    throw new Error(REFUSE.incomplete);
  }

  const draft = [input.card];
  const pc = await loadPlanContext(db, { excludeOwnedCopyIds: existingCopyIds(draft) });
  const { planned } = planFromDraft(pc, draft);
  // Consent rides on the planned card, so `writeNewLine` never has to guess (UIL-061).
  const withConsent = planned.map((pl) => ({ ...pl, confirmedPulls: input.confirmedPulls ?? [] }));

  // A colour mismatch (UIL-069) is never a silent default. "File by its own colour" arrives as
  // `override` below and is drift-proof by construction; nothing further to check. "Join the line"
  // has no override to carry — it IS the cascade's own placement — so it is refused unless she
  // explicitly confirmed it via `bandChoice` AND that confirmation is backed by a matching
  // `expectedDigest`. `bandChoice` alone would be an unbacked client assertion: a stale or careless
  // caller could send `"line"` on every card regardless of whether she was ever actually asked, which
  // is the exact silent default this whole check exists to prevent.
  if (
    planned[0]?.result.bandMismatch &&
    !input.override &&
    (input.bandChoice !== "line" || !input.expectedDigest)
  ) {
    throw new Error(
      "This card's own colour differs from the line it would join — pick which one wins before confirming.",
    );
  }

  // Compare BEFORE building the payload, so a conflict costs nothing and writes nothing.
  if (input.expectedDigest && !input.override && planned[0]) {
    const actual = placementDigest(planned[0].result);
    if (actual !== input.expectedDigest) {
      throw new PlacementChangedError(
        derivePlacementFrom(pc, input.card)?.item ?? null,
        input.expectedDigest,
        actual,
      );
    }
  }

  const { payload, haulId, counts } = buildHaulCommitPayload(pc, withConsent, {
    source: input.source,
    notes: input.notes ?? null,
    draft,
    overrides: input.override ? { [input.card.id]: input.override } : undefined,
    existingHaulId: input.haulId ?? null,
  });
  assertPlacementBandsConfigured(payload, pc);
  await applyWriteOps(db, payload);
  return { haulId, counts };
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

/**
 * Build the fully-resolved, ordered write set for a haul commit (PURE — no I/O). Emitted in the exact
 * dependency order the previous per-row writes used, so it is FK-safe when applied verbatim.
 */
export function buildHaulCommitPayload(
  pc: PlanContext,
  planned: PlannedCard[],
  input: CommitInput,
): { payload: WritePayload; haulId: string | null; counts: CommitCounts } {
  const ops: WriteOp[] = [];
  const counts: CommitCounts = {
    copies: 0,
    routed: 0,
    lines: 0,
    slots: 0,
    wishlist: 0,
    decisions: 0,
  };
  const now = new Date().toISOString();

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

  // Only a pass that actually takes in a new card is an acquisition event. A pure routing pass over
  // copies sync already created gets no haul row (see the file header).
  // A haul row is opened once per sitting, not once per card: `existingHaulId` is how cards two
  // onward join the one the first card opened. Only a pass that takes in a NEW card is an acquisition
  // event at all — a pure routing pass over sync's copies still writes no haul (see the header).
  const hasNewCards = planned.some((p) => !p.existingCopyId);
  const joinedHaulId = input.existingHaulId ?? null;
  const haulId = joinedHaulId ?? (hasNewCards ? crypto.randomUUID() : null);
  if (haulId && !joinedHaulId) {
    ops.push({ op: "insert_haul", id: haulId, source: input.source, notes: input.notes ?? null });
  }

  for (const p of planned) {
    // A routed copy belongs to no haul, even when the same pass also takes in new cards.
    const decisionHaulId = p.existingCopyId ? null : haulId;
    const override = input.overrides?.[p.incomingId];
    // UIL-069: by this point a mismatch has already been resolved one way or the other —
    // `commitCardPlacement` refuses before reaching here (its only caller now that the whole-haul
    // `commitHaul` entry point is gone) — this only picks the HONEST audit text for whichever way it
    // went, so the trail says what she actually chose rather than reusing `p.result.reason`, which
    // always describes the LINE option regardless of her pick.
    const mismatch = p.result.bandMismatch;
    if (override) {
      // Manual placement wins: place the copy where she said, skip all cascade side effects.
      const copyId = writeOverriddenCard(
        ops,
        haulId,
        p,
        override,
        pc,
        slotsByLine,
        passLines,
        now,
        counts,
      );
      const reason = mismatch
        ? "Colour mismatch resolved at intake (her call, UIL-069): filed by its own colour rather " +
          "than joining the existing line."
        : `Manual placement override at intake (your call, cascade skipped): ${p.result.reason}`;
      ops.push({
        op: "insert_decision",
        haul_id: decisionHaulId,
        copy_id: copyId,
        decision: mismatch ? "colour-mismatch-own-color" : "placement-override",
        reason,
        resolved_by: "user",
      });
      counts.decisions += 1;
      continue;
    }
    const copyId = writeCard(ops, haulId, p, pc, slotsByLine, passLines, now, counts);
    const reason = mismatch
      ? "Colour mismatch resolved at intake (her call, UIL-069): joined the existing line over " +
        "filing by its own colour."
      : p.result.reason;
    ops.push({
      op: "insert_decision",
      haul_id: decisionHaulId,
      copy_id: copyId,
      decision: mismatch ? "colour-mismatch-join-line" : p.result.step,
      reason,
      resolved_by: mismatch ? "user" : "auto",
    });
    counts.decisions += 1;
  }

  return { payload: { ops }, haulId, counts };
}

/** Emit the incoming copy with its placement, then the step's line/swap side effects. Returns id. */
function writeCard(
  ops: WriteOp[],
  haulId: string | null,
  p: PlannedCard,
  pc: PlanContext,
  slotsByLine: Map<string, MutableSlot[]>,
  passLines: Map<string, { lineId: string }>,
  now: string,
  counts: CommitCounts,
): string {
  const { result } = p;

  // Placement columns. Holo-swap inherits the displaced copy's role wholesale (system-design §3).
  const swap = result.swap;
  const placement = swap
    ? {
        role: "shelved" as const,
        binderId: swap.incomingInherits.binderId,
        binderHalf: swap.incomingInherits.binderHalf,
        colorBand: swap.incomingInherits.colorBand,
      }
    : copyPlacementFromTarget(result.target);

  const copyId = emitIncomingCopy(ops, haulId, p, placement, now, counts);

  if (swap) {
    // Incoming holo takes over the line slot, if any; the displaced normal goes to bulk.
    if (swap.incomingInherits.lineSlotId) {
      ops.push({
        op: "update_copy",
        id: copyId,
        patch: { line_slot_id: swap.incomingInherits.lineSlotId },
      });
      ops.push({
        op: "update_slot",
        id: swap.incomingInherits.lineSlotId,
        patch: { copy_id: copyId },
      });
      touchSlot(slotsByLine, swap.incomingInherits.lineSlotId, copyId);
    }
    const displaced = pc.copyRowById.get(swap.displacedCopyId);
    if (displaced) {
      ops.push({
        op: "update_copy",
        id: displaced.id,
        patch: {
          role: "bulk",
          binder_id: null,
          binder_half: null,
          color_band: null,
          line_slot_id: null,
        },
      });
    }
    return copyId;
  }

  // Fill an existing DB line's open slot (system-design §5 step 4a).
  if (result.filledExistingSlot) {
    const { lineId, stageIndex } = result.filledExistingSlot;
    const slots = slotsByLine.get(lineId) ?? [];
    const slot = slots.find((s) => s.stage_index === stageIndex);
    /**
     * ALL OR NOTHING (UIL-062). The two pointers are one fact stored twice — `slot.copy_id` and
     * `copy.line_slot_id` — and the app is only correct when they agree.
     *
     * This used to be `if (slot) { … }` with no else. When the slot could not be resolved, the cascade
     * had already decided "fill stage N of line L" and `emitIncomingCopy` had already written the
     * back-half placement columns with `line_slot_id: null` (`copyPlacementFromTarget` carries no slot
     * id for any target kind). Neither pointer op then ran, so the commit succeeded having shelved the
     * card in the back half while the line still showed that stage as wanting a card: Done pressed, card
     * physically in the binder, that stage still reading as unfilled on the Lines page.
     *
     * Described as the PATH, deliberately, and not as the report that prompted the look. The report was
     * a Dragonair reading HUNTING, and that turned out to be no defect at all — she owns no Dragonair
     * and the slot was a correct placeholder. Naming it here would hand the next reader a conflation
     * that already cost two sessions and one spurious re-check request.
     *
     * Failing loudly is right rather than harsh. The write is one `apply_write_ops` transaction, so
     * throwing leaves ZERO rows and she retries against fresh state; the alternative is a silent
     * half-write that no screen contradicts. If this ever fires it means the context and the cascade
     * disagree about a line's slots, which is a bug worth surfacing rather than absorbing.
     */
    if (!slot) {
      throw new Error(
        `Cannot commit: the cascade chose stage ${stageIndex} of line ${lineId} for this card, but ` +
          `that slot is not in the loaded line state. Re-run the plan so it reflects current lines.`,
      );
    }
    slot.state = "filled";
    slot.copy_id = copyId;
    ops.push({ op: "update_slot", id: slot.id, patch: { state: "filled", copy_id: copyId } });
    ops.push({ op: "update_copy", id: copyId, patch: { line_slot_id: slot.id } });
    return copyId;
  }

  // Create (or dedupe into) a new line.
  if (result.newLine) {
    writeNewLine(ops, p, copyId, pc, slotsByLine, passLines, counts);
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
  haulId: string | null,
  p: PlannedCard,
  dest: MoveDestination,
  pc: PlanContext,
  slotsByLine: Map<string, MutableSlot[]>,
  passLines: Map<string, { lineId: string }>,
  now: string,
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
    haulId,
    p,
    {
      role: placement.role,
      binderId: placement.binder_id,
      binderHalf: placement.binder_half,
      colorBand: placement.color_band,
      lineSlotId: existingJoin?.slotId ?? placement.line_slot_id,
    },
    now,
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
    // Keyed on the line's ACTUAL root, not the card's own dexId (a Stage1 is not its own root) —
    // the same check, and the same key, `applyMove` uses. Scoped to the DESTINATION BINDER as of
    // UIL-084: a line in another binder no longer owns this species-and-band, so she can start this
    // binder's own line. A duplicate in the SAME binder is still refused, and the panel now disables
    // Confirm for exactly that case, so reaching here is a stale client.
    const key = passLineKey(dest.binderId, built.rootDexId, dest.band);
    if (passLines.has(key) || findLineInBinder(pc, built.rootDexId, dest.band, dest.binderId)) {
      throw new Error(REFUSE.lineExists);
    }
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
 * Write the incoming card's placement and return the copy id it lives on.
 *
 * The ONE place the new-vs-routed split is decided (UIL-003): a typed card gets a fresh `copy` row
 * stamped with the haul, while an entry carrying `existingCopyId` patches the placement of the row
 * sync already created. The routed patch names all five placement columns explicitly because
 * `CopyPatch` writes exactly the keys present (a missing key is left unchanged, which would strand a
 * stale placement); it deliberately omits `variant` / `dex_variant_raw` / `haul_id`, which are not
 * this pass's to change.
 */
function emitIncomingCopy(
  ops: WriteOp[],
  haulId: string | null,
  p: PlannedCard,
  placement: {
    // `Role`, not just shelved/bulk: a move override can place a card as a repurposed binder block.
    role: Role;
    binderId: string | null;
    binderHalf: "front" | "back" | null;
    colorBand: string | null;
    lineSlotId?: string | null;
  },
  now: string,
  counts: CommitCounts,
): string {
  if (p.existingCopyId) {
    ops.push({
      op: "update_copy",
      id: p.existingCopyId,
      patch: {
        role: placement.role,
        binder_id: placement.binderId,
        binder_half: placement.binderHalf,
        color_band: placement.colorBand,
        line_slot_id: placement.lineSlotId ?? null,
      },
    });
    counts.routed += 1;
    return p.existingCopyId;
  }

  const copyId = crypto.randomUUID();
  ops.push({
    op: "insert_copy",
    id: copyId,
    catalog_card_id: p.tcgdexId,
    variant: p.variant,
    haul_id: haulId,
    acquired_at: now,
    role: placement.role,
    binder_id: placement.binderId,
    binder_half: placement.binderHalf,
    color_band: placement.colorBand,
    line_slot_id: placement.lineSlotId ?? null,
  });
  counts.copies += 1;
  return copyId;
}

/** Create the proposed line + its slots + wishlist, or fill the incoming's slot if the line exists. */
function writeNewLine(
  ops: WriteOp[],
  p: PlannedCard,
  incomingCopyId: string,
  pc: PlanContext,
  slotsByLine: Map<string, MutableSlot[]>,
  passLines: Map<string, { lineId: string }>,
  counts: CommitCounts,
): void {
  const plan = p.result.newLine!;
  // Binder-scoped as of UIL-084, like every other reading of the uniqueness key: "the same line"
  // means the same species and band IN THE SAME BINDER.
  const key = passLineKey(plan.binderId, plan.rootDexId, plan.colorBand);
  const incomingStageIndex =
    p.result.target.kind === "back-half-line" ? p.result.target.stageIndex : -1;

  // Same line already created this pass, or already in the DB → fill instead of duplicating.
  const passLine = passLines.get(key);
  const dbLine = passLine
    ? null
    : findLineInBinder(pc, plan.rootDexId, plan.colorBand, plan.binderId);
  if (passLine || dbLine) {
    const lineId = passLine?.lineId ?? dbLine!;
    const slots = slotsByLine.get(lineId) ?? [];
    // Prefer the incoming's own stage slot; otherwise the first still-open slot.
    const byStage = slots.find((s) => s.stage_index === incomingStageIndex && s.state !== "filled");
    const slot = byStage ?? slots.find((s) => s.state !== "filled");
    if (slot) {
      slot.state = "filled";
      slot.copy_id = incomingCopyId;
      ops.push({
        op: "update_slot",
        id: slot.id,
        patch: { state: "filled", copy_id: incomingCopyId },
      });
      ops.push({ op: "update_copy", id: incomingCopyId, patch: { line_slot_id: slot.id } });
    }
    return;
  }

  const lineId = crypto.randomUUID();
  ops.push({
    op: "insert_line",
    id: lineId,
    root_dex_id: plan.rootDexId,
    color_band: plan.colorBand,
    binder_id: plan.binderId,
    half: "back",
    status: plan.status,
  });
  counts.lines += 1;

  const slotIdByStage = new Map<number, string>();
  const mirror: MutableSlot[] = [];

  /**
   * Pulls she has agreed to. Empty means move nothing (UIL-061) — the cascade's proposal is a
   * proposal, and every stage it wanted to fill from her collection stays a placeholder instead.
   */
  const confirmed = new Set(p.confirmedPulls ?? []);

  for (const slot of plan.slots) {
    const isIncoming = slot.copyId === p.incomingId;
    const proposedPullId = !isIncoming && slot.copyId ? slot.copyId : null;
    // A proposed pull she has not confirmed is not written. The slot degrades to a placeholder so the
    // line still records that the stage exists, without claiming to hold a card that is really still
    // in her binder. Deliberately NO wishlist row for it: the engine only proposes wishlist entries for
    // stages it found nothing for, and she already OWNS this card — she just kept it where it was.
    // Adding one would put a card she owns on a list of cards to acquire.
    const ownedCopyId = proposedPullId && confirmed.has(proposedPullId) ? proposedPullId : null;
    const declinedPull = proposedPullId !== null && ownedCopyId === null;
    const copyIdForSlot = isIncoming ? incomingCopyId : ownedCopyId;
    const slotState = declinedPull ? "placeholder" : slot.state;

    const slotId = crypto.randomUUID();
    ops.push({
      op: "insert_slot",
      id: slotId,
      line_id: lineId,
      stage_index: slot.stageIndex,
      stage: slot.stage,
      state: slotState,
      copy_id: copyIdForSlot,
      target_catalog_card_id: slot.targetCatalogCardId,
      // Say WHY it is open, so the Lines screen can distinguish "never owned" from "she kept it where
      // it was" without inferring it.
      note: declinedPull ? "left in place (not confirmed)" : (slot.note ?? null),
    });
    counts.slots += 1;
    slotIdByStage.set(slot.stageIndex, slotId);
    mirror.push({
      id: slotId,
      stage_index: slot.stageIndex,
      state: slotState,
      copy_id: copyIdForSlot,
    });

    // Wire the incoming copy to its slot.
    if (isIncoming) {
      ops.push({ op: "update_copy", id: incomingCopyId, patch: { line_slot_id: slotId } });
    }
    // A CONFIRMED pull: relocate the copy into this line's back half.
    if (ownedCopyId) {
      const owned = pc.copyRowById.get(ownedCopyId);
      if (owned) {
        // Release the slot it is leaving, through the SHARED emitter (UIL-062 follow-up).
        //
        // This was a fourth inline `update_slot`, which defeats the point of extracting
        // `releaseSlotOps` in the first place — one emission path is what stops the release op lists
        // drifting apart, and a path outside it is a path that can drift. It was also missing two
        // things the sibling `writeOverriddenCard` block has:
        //
        //   * the DEMOTE. A line that was `complete` is not complete once a stage empties, and leaving
        //     the status alone is the same class of lie as the stale slot itself.
        //   * the POSITIVE-MATCH guard. Releasing on "the copy has a pointer" alone will evict a card
        //     that never moved, if that pointer was already crossed. I found and fixed exactly this in
        //     `writeOverriddenCard` while building #151 and did not carry it across — so of the three
        //     gaps here this is the only one that can CORRUPT rather than under-record.
        const [vacating, demoting] = slotReleaseFor(owned, pc);
        if (vacating) {
          ops.push(...releaseSlotOps(vacating, demoting));
          touchSlot(slotsByLine, vacating, null);
        }
        ops.push({
          op: "update_copy",
          id: ownedCopyId,
          patch: {
            binder_id: plan.binderId,
            binder_half: "back",
            color_band: plan.colorBand,
            line_slot_id: slotId,
          },
        });
        // Its own audit row. Without this the move is not merely unconfirmed, it is UNTRACKED: the
        // commit loop writes one decision per incoming DRAFT card, so a pulled copy previously got
        // none at all and "why is this Charmander in the back half" had no answer anywhere.
        ops.push({
          op: "insert_decision",
          haul_id: null, // not acquired in this haul — it was already hers
          copy_id: ownedCopyId,
          decision: "line-pull-confirmed",
          reason:
            `Moved into the new ${plan.colorBand} line for ${p.tcgdexId} at your confirmation ` +
            `(was ${owned.binder_half ?? "unplaced"}${owned.color_band ? ` · ${owned.color_band}` : ""}, role ${owned.role}).`,
          resolved_by: "user",
        });
        counts.decisions += 1;
      }
    }
  }

  // Wishlist every placeholder slot (system-design §6 alternates).
  for (const w of p.result.wishlist ?? []) {
    const lineSlotId = slotIdByStage.get(w.stageIndex) ?? null;
    ops.push({
      op: "insert_wishlist",
      line_slot_id: lineSlotId,
      required_dex_id: w.requiredDexId,
      required_type: w.requiredType,
      required_stage: w.requiredStage,
      chosen_catalog_card_id: w.chosenCatalogCardId,
      alternate_catalog_card_ids: w.alternateCatalogCardIds,
      will_live_in_specialty: w.willLiveInSpecialty,
      held_for_binder_id: plan.binderId,
    });
    counts.wishlist += 1;
  }

  slotsByLine.set(lineId, mirror);
  passLines.set(key, { lineId });
}

/** Mutate the mirror so a subsequent same-pass read of this slot sees the fill. */
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

/** Existing line id for a (rootDexId, colorBand), read from the loaded snapshot (was a live query). */
/**
 * The line that already occupies (binder, species, band) — the uniqueness key as of UIL-084, keyed on
 * the BINDER too. `pc.ctx.lines` is ordered oldest-first (see `loadPlanContext`), so when duplicates
 * exist from before this rule the answer is the original rather than an arbitrary row.
 */
function findLineInBinder(
  pc: PlanContext,
  rootDexId: number,
  colorBand: string,
  binderId: string | null,
): string | null {
  for (const line of pc.ctx.lines) {
    if (
      line.rootDexId === rootDexId &&
      line.colorBand === colorBand &&
      (line.binderId ?? null) === binderId
    ) {
      return line.id;
    }
  }
  return null;
}

/** The in-pass key for a line created earlier in THIS payload — the same (binder, species, band). */
function passLineKey(binderId: string | null, rootDexId: number, colorBand: string): string {
  return `${binderId ?? ""}:${rootDexId}:${colorBand}`;
}
