/**
 * Apply a move or a decision resolution (dev-spec §5 M7 acceptance; §4 audit trail).
 *
 * The write side of the line screen. A move rewrites a copy's placement columns and records a
 * `PlacementDecision` (`resolved_by: 'user'`); moving a card off a line reopens its vacated slot
 * (removal symmetry, sync-arch §1.6) and demotes a `complete` line to `open`. A decision resolution
 * re-derives the decision from FRESH state (never trusts a client write payload), turns the chosen
 * option into repo writes via the pure resolver, applies them in dependency order, and records the
 * audit row. Every branch writes exactly one `PlacementDecision`.
 *
 * No cross-statement transaction (supabase-js; migrations frozen) — writes are ordered and small.
 * SERVER ONLY.
 */

import {
  copyRepo,
  evolutionLineRepo,
  lineSlotRepo,
  placementDecisionRepo,
  wishlistItemRepo,
  type DbClient,
} from "@/lib/repo";
import { resolveDecisionWrites } from "./decisions";
import { buildScreenModel } from "./load";
import { describeMove, moveDecisionReason, placementForMove, type MoveNameLookups } from "./move";
import type { DecisionChoiceId, MoveRequest } from "./types";

export interface MoveResult {
  copyId: string;
  destinationLabel: string;
}

/** Move an owned/shelved copy to a new home; rewrite placement + write the user audit row. */
export async function applyMove(
  db: DbClient,
  ownerId: string,
  req: MoveRequest,
  names: MoveNameLookups,
): Promise<MoveResult> {
  const copy = await copyRepo.getByPk(db, req.copyId);
  if (!copy) throw new Error("That card is no longer in the collection.");

  const patch = placementForMove(req.destination);
  const priorSlotId = copy.line_slot_id;

  await copyRepo.update(db, req.copyId, {
    role: patch.role,
    binder_id: patch.binder_id,
    binder_half: patch.binder_half,
    color_band: patch.color_band,
    line_slot_id: patch.line_slot_id,
  });

  // Moving a card OUT of a line reopens the slot it filled and demotes a completed line.
  if (priorSlotId) {
    // By primary key: a full-table `list` is capped at the server's max-rows, so scanning for the
    // slot could silently miss it once the collection outgrows one page.
    const slot = await lineSlotRepo.getByPk(db, priorSlotId);
    if (slot && slot.copy_id === req.copyId) {
      await lineSlotRepo.update(db, slot.id, { state: "placeholder", copy_id: null });
      const line = await evolutionLineRepo.getByPk(db, slot.line_id);
      if (line && line.status === "complete") {
        await evolutionLineRepo.update(db, line.id, { status: "open" });
      }
    }
  }

  const destinationLabel = describeMove(req.destination, names);
  await placementDecisionRepo.insert(db, {
    owner_id: ownerId,
    haul_id: null,
    copy_id: req.copyId,
    decision: "placement-move",
    reason: moveDecisionReason(req.destination, destinationLabel),
    resolved_by: "user",
  });

  return { copyId: req.copyId, destinationLabel };
}

/**
 * Resolve a decision: re-derive it from fresh state, compute the writes for the chosen option, apply
 * them, and record the `PlacementDecision`. Throws if the decision is stale (state changed under it).
 */
export async function applyDecision(
  db: DbClient,
  ownerId: string,
  decisionId: string,
  choiceId: DecisionChoiceId,
): Promise<void> {
  const model = await buildScreenModel(db);
  const derived = model.derived.find((d) => d.card.id === decisionId);
  if (!derived) throw new Error("That decision is no longer open — the line state has changed.");

  const writes = resolveDecisionWrites(derived.resolution, choiceId);

  // Line status.
  if (writes.linePatch?.status) {
    await evolutionLineRepo.update(db, derived.resolution.lineId, {
      status: writes.linePatch.status,
    });
  }

  // Slot state / target changes.
  for (const p of writes.slotPatches) {
    const patch: Record<string, unknown> = {};
    if (p.state !== undefined) patch.state = p.state;
    if (p.copyId !== undefined) patch.copy_id = p.copyId;
    if (p.targetCatalogCardId !== undefined) patch.target_catalog_card_id = p.targetCatalogCardId;
    if (p.note !== undefined) patch.note = p.note;
    if (Object.keys(patch).length > 0) await lineSlotRepo.update(db, p.slotId, patch);
  }

  // Wishlist: resolve (drop) some, upsert (create/refresh) others.
  if (writes.wishlistResolveSlotIds.length > 0 || writes.wishlistUpserts.length > 0) {
    const existing = await wishlistItemRepo.listAll(db);
    const openBySlot = new Map<string, string>();
    for (const w of existing) {
      if (w.resolved_at === null && w.line_slot_id) openBySlot.set(w.line_slot_id, w.id);
    }

    for (const slotId of writes.wishlistResolveSlotIds) {
      const id = openBySlot.get(slotId);
      if (id) await wishlistItemRepo.update(db, id, { resolved_at: new Date().toISOString() });
    }

    for (const up of writes.wishlistUpserts) {
      const id = openBySlot.get(up.lineSlotId);
      const values = {
        line_slot_id: up.lineSlotId,
        required_dex_id: up.requiredDexId,
        required_type: up.requiredType,
        required_stage: up.requiredStage,
        chosen_catalog_card_id: up.chosenCatalogCardId,
        alternate_catalog_card_ids: up.alternateCatalogCardIds,
        will_live_in_specialty: up.willLiveInSpecialty,
      };
      if (id) await wishlistItemRepo.update(db, id, values);
      else await wishlistItemRepo.insert(db, { owner_id: ownerId, ...values });
    }
  }

  // Audit (dev-spec §4 — one row per user decision).
  await placementDecisionRepo.insert(db, {
    owner_id: ownerId,
    haul_id: null,
    copy_id: null,
    decision: writes.decision.decision,
    reason: writes.decision.reason,
    resolved_by: "user",
  });
}
