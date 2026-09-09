/**
 * Commit a haul (dev-spec §5 M6; system-design §4, §7B step 6).
 *
 * Re-runs the cascade over the draft (deterministic against current DB state) and writes every
 * record it implies: the Haul, a Copy per card, EvolutionLine + LineSlots for new lines, slot fills
 * for existing lines, holo-swap displacements, WishlistItems for placeholders, and a
 * PlacementDecision per card (reason + resolvedBy — the audit trail is not optional, dev-spec §4).
 *
 * ATOMICITY (M10). The whole write set is computed here in TS — the cascade/decision logic stays
 * pure — then applied in ONE transaction by the `apply_write_ops` RPC (migration 0006). Row UUIDs are
 * generated client-side (`crypto.randomUUID`) so line→slot→copy cross-references resolve before
 * insert. This replaces the earlier compensating-rollback interim: a commit that fails partway now
 * leaves ZERO rows. Writes run under the RLS-scoped client from the auth seam (lib/plan/session.ts)
 * and the RPC is SECURITY INVOKER, so `owner_id` is never stamped — it defaults to `auth.uid()` and
 * the RLS `with check (owner_id = auth.uid())` policy enforces it.
 */

import { applyWriteOps, type DbClient, type WriteOp, type WritePayload } from "@/lib/repo";
// Leaf import (lib/line/move depends only on lib/line/types → lib/engine; no cycle back to lib/plan).
import { placementForMove } from "@/lib/line/move";
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

export interface CommitResult {
  haulId: string;
  counts: { copies: number; lines: number; slots: number; wishlist: number; decisions: number };
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
  const pc = await loadPlanContext(db);
  const { planned } = planFromDraft(pc, input.draft);
  const { payload, haulId, counts } = buildHaulCommitPayload(pc, planned, input);
  await applyWriteOps(db, payload);
  return { haulId, counts };
}

/**
 * Build the fully-resolved, ordered write set for a haul commit (PURE — no I/O). Emitted in the exact
 * dependency order the previous per-row writes used, so it is FK-safe when applied verbatim.
 */
export function buildHaulCommitPayload(
  pc: PlanContext,
  planned: PlannedCard[],
  input: CommitInput,
): { payload: WritePayload; haulId: string; counts: CommitResult["counts"] } {
  const ops: WriteOp[] = [];
  const counts = { copies: 0, lines: 0, slots: 0, wishlist: 0, decisions: 0 };
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

  const haulId = crypto.randomUUID();
  ops.push({ op: "insert_haul", id: haulId, source: input.source, notes: input.notes ?? null });

  for (const p of planned) {
    const override = input.overrides?.[p.incomingId];
    if (override) {
      // Manual placement wins: place the copy where she said, skip all cascade side effects.
      const copyId = writeOverriddenCard(ops, haulId, p, override, now, counts);
      ops.push({
        op: "insert_decision",
        haul_id: haulId,
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
      haul_id: haulId,
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
  haulId: string,
  p: PlannedCard,
  pc: PlanContext,
  slotsByLine: Map<string, MutableSlot[]>,
  passLines: Map<string, { lineId: string }>,
  now: string,
  counts: CommitResult["counts"],
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
  });
  counts.copies += 1;

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

/** Emit a copy at a manual override placement (M7). No line/swap side effects; audited as user. */
function writeOverriddenCard(
  ops: WriteOp[],
  haulId: string,
  p: PlannedCard,
  dest: MoveDestination,
  now: string,
  counts: CommitResult["counts"],
): string {
  const placement = placementForMove(dest);
  const copyId = crypto.randomUUID();
  ops.push({
    op: "insert_copy",
    id: copyId,
    catalog_card_id: p.tcgdexId,
    variant: p.variant,
    haul_id: haulId,
    acquired_at: now,
    role: placement.role,
    binder_id: placement.binder_id,
    binder_half: placement.binder_half,
    color_band: placement.color_band,
    line_slot_id: placement.line_slot_id,
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
  counts: CommitResult["counts"],
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
