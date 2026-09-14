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
import { applyWriteOps, type DbClient, type WriteOp, type WritePayload } from "@/lib/repo";
// Leaf import (lib/line/move depends only on lib/line/types → lib/engine; no cycle back to lib/plan).
import { collectionTargetJoinOp, placementForMove } from "@/lib/line/move";
import type { MoveDestination } from "@/lib/line/types";
import { copyPlacementFromTarget } from "./placement";
import { loadPlanContext, planFromDraft, type DraftItem, type PlanContext } from "./context";
import type { PlannedCard } from "./types";

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

/** A line slot as the builder tracks it, mutated in place as fills are recorded so a later card in
 *  the SAME haul sees the earlier fill (mirrors the old live `listByLine` re-reads exactly). */
interface MutableSlot {
  id: string;
  stage_index: number;
  state: string;
  copy_id: string | null;
}

/**
 * Commit a whole haul atomically. Loads context, re-runs the cascade, builds the ordered write set,
 * and applies it in one transaction via the RPC. Returns the new haul id and per-table counts.
 */
export async function commitHaul(db: DbClient, input: CommitInput): Promise<CommitResult> {
  const pc = await loadPlanContext(db, {
    excludeOwnedCopyIds: existingCopyIds(input.draft),
  });
  const { planned } = planFromDraft(pc, input.draft);
  const { payload, haulId, counts } = buildHaulCommitPayload(pc, planned, input);
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
  const hasNewCards = planned.some((p) => !p.existingCopyId);
  const haulId = hasNewCards ? crypto.randomUUID() : null;
  if (haulId) {
    ops.push({ op: "insert_haul", id: haulId, source: input.source, notes: input.notes ?? null });
  }

  for (const p of planned) {
    // A routed copy belongs to no haul, even when the same pass also takes in new cards.
    const decisionHaulId = p.existingCopyId ? null : haulId;
    const override = input.overrides?.[p.incomingId];
    if (override) {
      // Manual placement wins: place the copy where she said, skip all cascade side effects.
      const copyId = writeOverriddenCard(ops, haulId, p, override, now, counts);
      ops.push({
        op: "insert_decision",
        haul_id: decisionHaulId,
        copy_id: copyId,
        decision: "placement-override",
        reason: `Manual placement override at intake (your call, cascade skipped): ${p.result.reason}`,
        resolved_by: "user",
      });
      counts.decisions += 1;
      continue;
    }
    const copyId = writeCard(ops, haulId, p, pc, slotsByLine, passLines, now, counts);
    ops.push({
      op: "insert_decision",
      haul_id: decisionHaulId,
      copy_id: copyId,
      decision: p.result.step,
      reason: p.result.reason,
      resolved_by: "auto",
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
    if (slot) {
      slot.state = "filled";
      slot.copy_id = copyId;
      ops.push({ op: "update_slot", id: slot.id, patch: { state: "filled", copy_id: copyId } });
      ops.push({ op: "update_copy", id: copyId, patch: { line_slot_id: slot.id } });
    }
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
  now: string,
  counts: CommitCounts,
): string {
  const placement = placementForMove(dest);
  const copyId = emitIncomingCopy(
    ops,
    haulId,
    p,
    {
      role: placement.role,
      binderId: placement.binder_id,
      binderHalf: placement.binder_half,
      colorBand: placement.color_band,
      lineSlotId: placement.line_slot_id,
    },
    now,
    counts,
  );

  const join = collectionTargetJoinOp(dest, p.tcgdexId);
  if (join) ops.push(join);

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
  const key = `${plan.rootDexId}:${plan.colorBand}`;
  const incomingStageIndex =
    p.result.target.kind === "back-half-line" ? p.result.target.stageIndex : -1;

  // Same line already created this pass, or already in the DB → fill instead of duplicating.
  const passLine = passLines.get(key);
  const dbLine = passLine ? null : findLineByRootAndBand(pc, plan.rootDexId, plan.colorBand);
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

  for (const slot of plan.slots) {
    const isIncoming = slot.copyId === p.incomingId;
    const ownedCopyId = !isIncoming && slot.copyId ? slot.copyId : null;
    const copyIdForSlot = isIncoming ? incomingCopyId : ownedCopyId;

    const slotId = crypto.randomUUID();
    ops.push({
      op: "insert_slot",
      id: slotId,
      line_id: lineId,
      stage_index: slot.stageIndex,
      stage: slot.stage,
      state: slot.state,
      copy_id: copyIdForSlot,
      target_catalog_card_id: slot.targetCatalogCardId,
      note: slot.note ?? null,
    });
    counts.slots += 1;
    slotIdByStage.set(slot.stageIndex, slotId);
    mirror.push({
      id: slotId,
      stage_index: slot.stageIndex,
      state: slot.state,
      copy_id: copyIdForSlot,
    });

    // Wire the incoming copy to its slot.
    if (isIncoming) {
      ops.push({ op: "update_copy", id: incomingCopyId, patch: { line_slot_id: slotId } });
    }
    // Pull an owned front-half copy into the line's back half (worklist "pull" action).
    if (ownedCopyId) {
      const owned = pc.copyRowById.get(ownedCopyId);
      if (owned) {
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
function touchSlot(slotsByLine: Map<string, MutableSlot[]>, slotId: string, copyId: string): void {
  for (const slots of slotsByLine.values()) {
    const slot = slots.find((s) => s.id === slotId);
    if (slot) {
      slot.state = "filled";
      slot.copy_id = copyId;
      return;
    }
  }
}

/** Existing line id for a (rootDexId, colorBand), read from the loaded snapshot (was a live query). */
function findLineByRootAndBand(
  pc: PlanContext,
  rootDexId: number,
  colorBand: string,
): string | null {
  for (const line of pc.ctx.lines) {
    if (line.rootDexId === rootDexId && line.colorBand === colorBand) return line.id;
  }
  return null;
}
