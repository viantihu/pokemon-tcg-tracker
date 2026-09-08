/**
 * Commit a haul (dev-spec §5 M6; system-design §4, §7B step 6).
 *
 * Re-runs the cascade over the draft (deterministic against current DB state) and writes every
 * record it implies via `lib/repo`: the Haul, a Copy per card, EvolutionLine + LineSlots for new
 * lines, slot fills for existing lines, holo-swap displacements, WishlistItems for placeholders,
 * and a PlacementDecision per card (reason + resolvedBy — the audit trail is not optional, dev-spec
 * §4). Writes run under the RLS-scoped client from the auth seam (lib/plan/session.ts), so
 * `owner_id` is NOT stamped explicitly: the column defaults to `auth.uid()` and the RLS
 * `with check (owner_id = auth.uid())` policy enforces it.
 *
 * ATOMICITY. supabase-js has no cross-statement transaction and this phase adds no migration (the
 * migrations dir is frozen), so a real all-or-nothing commit would need a Postgres RPC in a future
 * migration. Until then this does the next best thing: writes in dependency order and, on ANY
 * failure, runs a compensating rollback (deletes inserted rows, reverts updated ones) in reverse
 * before rethrowing — so a failed commit leaves no half-written haul. FLAGGED as a seam.
 */

import type { DbClient, Insert } from "@/lib/repo";
import {
  copyRepo,
  evolutionLineRepo,
  haulRepo,
  lineSlotRepo,
  placementDecisionRepo,
  wishlistItemRepo,
} from "@/lib/repo";
import { copyPlacementFromTarget } from "./placement";
import { loadPlanContext, planFromDraft, type DraftItem } from "./context";
import type { PlannedCard } from "./types";

export type HaulSource = "bulk-bin" | "pack-rip" | "show" | "trade";

export interface CommitInput {
  source: HaulSource;
  notes?: string | null;
  draft: DraftItem[];
}

export interface CommitResult {
  haulId: string;
  counts: { copies: number; lines: number; slots: number; wishlist: number; decisions: number };
}

/** Undo stack for the compensating rollback (see file header). Run in reverse on failure. */
class Rollback {
  private steps: Array<() => Promise<void>> = [];
  add(step: () => Promise<void>) {
    this.steps.push(step);
  }
  async run() {
    for (const step of this.steps.reverse()) {
      try {
        await step();
      } catch {
        // Best-effort: keep unwinding even if one compensation fails.
      }
    }
  }
}

/**
 * Commit a whole haul atomically-enough (compensating rollback on failure). Returns the new haul id
 * and per-table counts written.
 */
export async function commitHaul(db: DbClient, input: CommitInput): Promise<CommitResult> {
  const pc = await loadPlanContext(db);
  const { planned } = planFromDraft(pc, input.draft);

  const rb = new Rollback();
  const counts = { copies: 0, lines: 0, slots: 0, wishlist: 0, decisions: 0 };

  // Lines created THIS pass, so a second card of the same (root, band) fills instead of duplicating.
  const passLines = new Map<string, { lineId: string; slotIdByDex: Map<number, string> }>();

  try {
    const haul = await haulRepo.insert(db, {
      source: input.source,
      notes: input.notes ?? null,
    });
    rb.add(() => haulRepo.remove(db, haul.id));

    for (const p of planned) {
      const copyId = await writeCard(db, haul.id, p, pc, passLines, counts, rb);
      await placementDecisionRepo.insert(db, {
        haul_id: haul.id,
        copy_id: copyId,
        decision: p.result.step,
        reason: p.result.reason,
        resolved_by: "auto",
      });
      counts.decisions += 1;
    }

    return { haulId: haul.id, counts };
  } catch (err) {
    await rb.run();
    throw err;
  }
}

/** Insert the incoming copy with its placement, then apply the step's line/swap side effects. */
async function writeCard(
  db: DbClient,
  haulId: string,
  p: PlannedCard,
  pc: Awaited<ReturnType<typeof loadPlanContext>>,
  passLines: Map<string, { lineId: string; slotIdByDex: Map<number, string> }>,
  counts: CommitResult["counts"],
  rb: Rollback,
): Promise<string> {
  const { result } = p;
  const now = new Date().toISOString();

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

  const copyInsert: Insert<"copy"> = {
    catalog_card_id: p.tcgdexId,
    variant: p.variant,
    haul_id: haulId,
    acquired_at: now,
    role: placement.role,
    binder_id: placement.binderId,
    binder_half: placement.binderHalf,
    color_band: placement.colorBand,
  };
  const copy = await copyRepo.insert(db, copyInsert);
  rb.add(() => copyRepo.remove(db, copy.id));
  counts.copies += 1;

  if (swap) {
    // Incoming holo takes over the line slot, if any; the displaced normal goes to bulk.
    if (swap.incomingInherits.lineSlotId) {
      await copyRepo.update(db, copy.id, { line_slot_id: swap.incomingInherits.lineSlotId });
      await lineSlotRepo.update(db, swap.incomingInherits.lineSlotId, { copy_id: copy.id });
    }
    const displaced = pc.copyRowById.get(swap.displacedCopyId);
    if (displaced) {
      const prior = {
        role: displaced.role,
        binder_id: displaced.binder_id,
        binder_half: displaced.binder_half,
        color_band: displaced.color_band,
        line_slot_id: displaced.line_slot_id,
      };
      await copyRepo.update(db, displaced.id, {
        role: "bulk",
        binder_id: null,
        binder_half: null,
        color_band: null,
        line_slot_id: null,
      });
      rb.add(() => copyRepo.update(db, displaced.id, prior).then(() => undefined));
    }
    return copy.id;
  }

  // Fill an existing DB line's open slot (system-design §5 step 4a).
  if (result.filledExistingSlot) {
    const { lineId, stageIndex } = result.filledExistingSlot;
    const slots = await lineSlotRepo.listByLine(db, lineId);
    const slot = slots.find((s) => s.stage_index === stageIndex);
    if (slot) {
      const prior = { state: slot.state, copy_id: slot.copy_id };
      await lineSlotRepo.update(db, slot.id, { state: "filled", copy_id: copy.id });
      rb.add(() => lineSlotRepo.update(db, slot.id, prior).then(() => undefined));
      await copyRepo.update(db, copy.id, { line_slot_id: slot.id });
    }
    return copy.id;
  }

  // Create (or dedupe into) a new line.
  if (result.newLine) {
    await writeNewLine(db, p, copy.id, pc, passLines, counts, rb);
  }

  return copy.id;
}

/** Create the proposed line + its slots + wishlist, or fill the incoming's slot if the line exists. */
async function writeNewLine(
  db: DbClient,
  p: PlannedCard,
  incomingCopyId: string,
  pc: Awaited<ReturnType<typeof loadPlanContext>>,
  passLines: Map<string, { lineId: string; slotIdByDex: Map<number, string> }>,
  counts: CommitResult["counts"],
  rb: Rollback,
): Promise<void> {
  const plan = p.result.newLine!;
  const key = `${plan.rootDexId}:${plan.colorBand}`;
  const incomingStageIndex =
    p.result.target.kind === "back-half-line" ? p.result.target.stageIndex : -1;

  // Same line already created this pass, or already in the DB → fill instead of duplicating.
  const passLine = passLines.get(key);
  const dbLine = passLine
    ? null
    : await evolutionLineRepo.findByRootAndBand(db, plan.rootDexId, plan.colorBand);
  if (passLine || dbLine) {
    const lineId = passLine?.lineId ?? dbLine!.id;
    const slots = await lineSlotRepo.listByLine(db, lineId);
    // Prefer the incoming's own stage slot; otherwise the first still-open slot.
    const byStage = slots.find((s) => s.stage_index === incomingStageIndex && s.state !== "filled");
    const slot = byStage ?? slots.find((s) => s.state !== "filled");
    if (slot) {
      const prior = { state: slot.state, copy_id: slot.copy_id };
      await lineSlotRepo.update(db, slot.id, { state: "filled", copy_id: incomingCopyId });
      rb.add(() => lineSlotRepo.update(db, slot.id, prior).then(() => undefined));
      await copyRepo.update(db, incomingCopyId, { line_slot_id: slot.id });
    }
    return;
  }

  const line = await evolutionLineRepo.insert(db, {
    root_dex_id: plan.rootDexId,
    color_band: plan.colorBand,
    binder_id: plan.binderId,
    half: "back",
    status: plan.status,
  });
  rb.add(() => evolutionLineRepo.remove(db, line.id));
  counts.lines += 1;

  const slotIdByStage = new Map<number, string>();
  const slotIdByDex = new Map<number, string>();

  for (const slot of plan.slots) {
    const isIncoming = slot.copyId === p.incomingId;
    const ownedCopyId = !isIncoming && slot.copyId ? slot.copyId : null;
    const copyIdForSlot = isIncoming ? incomingCopyId : ownedCopyId;

    const slotRow = await lineSlotRepo.insert(db, {
      line_id: line.id,
      stage_index: slot.stageIndex,
      stage: slot.stage,
      state: slot.state,
      copy_id: copyIdForSlot,
      target_catalog_card_id: slot.targetCatalogCardId,
      note: slot.note ?? null,
    });
    rb.add(() => lineSlotRepo.remove(db, slotRow.id));
    counts.slots += 1;
    slotIdByStage.set(slot.stageIndex, slotRow.id);
    slotIdByDex.set(slot.dexId, slotRow.id);

    // Wire the incoming copy to its slot.
    if (isIncoming) {
      await copyRepo.update(db, incomingCopyId, { line_slot_id: slotRow.id });
    }
    // Pull an owned front-half copy into the line's back half (worklist "pull" action).
    if (ownedCopyId) {
      const owned = pc.copyRowById.get(ownedCopyId);
      if (owned) {
        const prior = {
          binder_id: owned.binder_id,
          binder_half: owned.binder_half,
          color_band: owned.color_band,
          line_slot_id: owned.line_slot_id,
        };
        await copyRepo.update(db, ownedCopyId, {
          binder_id: line.binder_id,
          binder_half: "back",
          color_band: plan.colorBand,
          line_slot_id: slotRow.id,
        });
        rb.add(() => copyRepo.update(db, ownedCopyId, prior).then(() => undefined));
      }
    }
  }

  // Wishlist every placeholder slot (system-design §6 alternates).
  for (const w of p.result.wishlist ?? []) {
    const lineSlotId = slotIdByStage.get(w.stageIndex) ?? null;
    await wishlistItemRepo.insert(db, {
      line_slot_id: lineSlotId,
      required_dex_id: w.requiredDexId,
      required_type: w.requiredType,
      required_stage: w.requiredStage,
      chosen_catalog_card_id: w.chosenCatalogCardId,
      alternate_catalog_card_ids: w.alternateCatalogCardIds,
      will_live_in_specialty: w.willLiveInSpecialty,
      held_for_binder_id: line.binder_id,
    });
    counts.wishlist += 1;
  }

  passLines.set(key, { lineId: line.id, slotIdByDex });
}
