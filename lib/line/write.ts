/**
 * Apply a move or a decision resolution (dev-spec §5 M7 acceptance; §4 audit trail).
 *
 * The write side of the line screen. A move rewrites a copy's placement columns, joins the
 * destination collection's chase list when there is one, and records a `PlacementDecision`
 * (`resolved_by: 'user'`); moving a card off a line reopens its vacated slot (removal symmetry,
 * sync-arch §1.6) and demotes a `complete` line to `open`. A decision resolution re-derives the
 * decision from FRESH state (never trusts a client write payload), turns the chosen option into repo
 * writes via the pure resolver, applies them in dependency order, and records the audit row. Every
 * branch writes exactly one `PlacementDecision`.
 *
 * ATOMICITY. `applyMove` is now ONE transaction: it reads fresh state, hands the whole ordered write
 * set to the `apply_write_ops` RPC, and is all-or-nothing (UIL-023). It used to issue four separate
 * awaited statements with no transaction and no compensating rollback — the fourth write path M10
 * never converted. Every op it needs already existed (`update_copy`, `update_slot`,
 * `update_line` from 0008, `union_collection_targets` from 0007, `insert_decision`), so the
 * conversion required NO migration. Fixing UIL-022 by bolting a fifth un-transacted write onto that
 * sequence would have created the exact half-apply this path exists to prevent: a copy physically in
 * a collection whose chase list never got updated.
 *
 * `applyDecision` is NOT converted and is still a sequence of un-transacted writes. It needs an op
 * `apply_write_ops` does not have — `wishlist_item` can only be INSERTED through the RPC (0006), never
 * patched, and a decision resolution updates open wishlist rows (`resolved_at`, and a re-choose that
 * refreshes an existing row). Converting it therefore means a new migration and a wider blast radius
 * than UIL-022/UIL-023 name; it is called out in the PR rather than smuggled in here.
 *
 * SERVER ONLY.
 */

import { toCatalogCard } from "@/lib/plan/adapt";
import type { IncomingCard, TypeColorMap, Variant } from "@/lib/engine";
import {
  applyWriteOps,
  catalogCardRepo,
  collectionRepo,
  copyRepo,
  evolutionLineRepo,
  lineSlotRepo,
  placementDecisionRepo,
  typeColorMapRepo,
  wishlistItemRepo,
  type DbClient,
  type WriteOp,
  binderBlockRepo,
} from "@/lib/repo";
import { resolveDecisionWrites } from "./decisions";
import { buildScreenModel } from "./load";
import {
  buildExistingLineJoinOps,
  buildMoveOps,
  buildNewLineJoinOps,
  describeMove,
  isMoveDestinationComplete,
  lineJoinOf,
  type MoveNameLookups,
} from "./move";
import type { DecisionChoiceId, MoveDestination, MoveRequest } from "./types";

export interface MoveResult {
  copyId: string;
  destinationLabel: string;
}

/**
 * Move an owned/shelved copy to a new home, ATOMICALLY: placement + vacated slot + demoted line +
 * destination-collection membership + the audit row, all in one transaction.
 *
 * Everything the write set depends on is re-derived from FRESH state here — which slot the copy fills
 * and whether that slot's line is `complete`. The client sends only a copy id and a destination; a
 * stale slot or line id from the browser is never trusted (the rule `applyDecision` and
 * `applyCollectionRemoval` both follow).
 *
 * `ownerId` is no longer a parameter: the RPC is SECURITY INVOKER, so `owner_id` defaults to
 * `auth.uid()` and RLS enforces it. It is never carried in a payload.
 */
export async function applyMove(
  db: DbClient,
  req: MoveRequest,
  names: MoveNameLookups,
): Promise<MoveResult> {
  const copy = await copyRepo.getByPk(db, req.copyId);
  if (!copy) throw new Error("That card is no longer in the collection.");

  // `isMoveDestinationComplete` is also the panel's Confirm gate, but that gate is client-side only
  // — nothing stopped a stale tab, a bundle from before UIL-056, or any caller that skips the panel
  // from sending a back-half destination with no line and reproducing the exact strand this fix
  // exists to close. Re-checked here for the same reason a stale slot/line id is never trusted from
  // the browser: the ONE rule, enforced in the ONE place that can't be bypassed.
  if (!isMoveDestinationComplete(req.destination)) {
    throw new Error("That destination is incomplete — reload the screen and pick again.");
  }

  await assertCollectionDestinationLives(db, req.destination);
  await assertBlockDestinationOpen(db, req.destination);

  // Moving a card OUT of a line reopens the slot it filled and demotes a completed line.
  let reopenSlotId: string | null = null;
  let demoteLineId: string | null = null;
  if (copy.line_slot_id) {
    // By primary key: a full-table `list` is capped at the server's max-rows, so scanning for the
    // slot could silently miss it once the collection outgrows one page.
    const slot = await lineSlotRepo.getByPk(db, copy.line_slot_id);
    if (slot && slot.copy_id === req.copyId) {
      reopenSlotId = slot.id;
      const line = await evolutionLineRepo.getByPk(db, slot.line_id);
      if (line && line.status === "complete") demoteLineId = line.id;
    }
  }

  // Moving a card INTO the back half resolves a line target (UIL-056) — re-derived fresh here, same
  // as reopenSlotId/demoteLineId above, never trusted from the client.
  const join = lineJoinOf(req.destination);
  let lineJoinOps: WriteOp[] | undefined;
  let resolvedLineSlotId: string | null | undefined;
  if (join && req.destination.kind === "shelf") {
    if (join.mode === "existing") {
      const slot = await lineSlotRepo.getByPk(db, join.slotId);
      if (!slot || slot.line_id !== join.lineId) {
        throw new Error("That line slot no longer exists — reload the screen and pick again.");
      }
      if (slot.state === "filled") {
        throw new Error("That slot has already been filled — reload the screen and pick again.");
      }
      const siblings = await lineSlotRepo.listByLine(db, join.lineId);
      const slotIsLastOpen = siblings.every((s) => s.id === slot.id || s.state === "filled");
      const built = buildExistingLineJoinOps({
        copyId: req.copyId,
        lineId: join.lineId,
        slotId: slot.id,
        slotIsLastOpen,
      });
      lineJoinOps = built.ops;
      resolvedLineSlotId = built.slotId;
    } else {
      const card = await catalogCardRepo.getByPk(db, copy.catalog_card_id);
      if (!card) throw new Error("That card's catalog entry is missing — reload and try again.");
      const cc = toCatalogCard(card);
      const [catalogRows, typeMapRows] = await Promise.all([
        catalogCardRepo.listAll(db),
        typeColorMapRepo.list(db),
      ]);
      const typeColorMap: TypeColorMap = {};
      for (const t of typeMapRows) typeColorMap[t.card_type] = t.band;
      const incoming: IncomingCard = {
        id: req.copyId,
        card: cc,
        variant: (copy.variant as Variant) ?? "normal",
      };
      const built = buildNewLineJoinOps({
        incoming,
        catalog: catalogRows.map(toCatalogCard),
        typeColorMap,
        binderId: req.destination.binderId,
        destinationBand: req.destination.band,
      });
      // Checked against the line's ACTUAL root (built.rootDexId) rather than the moved card's own
      // dexId — those differ whenever the card is not itself the chain's root (e.g. starting a line
      // from a Stage1 whose Basic exists in the catalog as a placeholder). Discarding `built.ops` on
      // a throw is safe: they are pure data, no I/O has happened yet.
      // Scoped to the DESTINATION BINDER (UIL-084): a line in another binder no longer owns this
      // species-and-band, so she can start that binder's own line.
      /**
       * NO "a line already exists" refusal (UIL-096). This used to read every line for the species in the
       * destination binder and band and throw `LINE_EXISTS_IN_BINDER` if one matched her card's locale.
       * Karvi overruled the rule: "Instead of blocking the creation of an evolution line, I want a warning
       * that there is a line existing in my ENTIRE collection." The warning is the Move panel's, shown
       * before she confirms, from the join options that already list every line she has; by the time a
       * request reaches here she has seen it and chosen to start a new line anyway, and that is hers to
       * choose. A card must always be movable.
       *
       * Nothing downstream needed the uniqueness: `evolution_line` has no unique constraint (0002 declares
       * only a plain `(root_dex_id, color_band)` index), and the cascade's own join picks deterministically
       * among several same-species lines by oldest-first (`existingLineSlot`, pinned elsewhere).
       */
      lineJoinOps = built.ops;
      resolvedLineSlotId = built.slotId;
    }
  }

  const destinationLabel = describeMove(req.destination, names);
  await applyWriteOps(db, {
    ops: buildMoveOps({
      copyId: req.copyId,
      catalogCardId: copy.catalog_card_id,
      destination: req.destination,
      reopenSlotId,
      demoteLineId,
      destinationLabel,
      lineJoinOps,
      resolvedLineSlotId,
    }),
  });

  return { copyId: req.copyId, destinationLabel };
}

/**
 * Refuse a block destination that is not an OPEN need (UIL-030): the slot must exist, be a block slot of
 * that line, the line must live in that binder, and no line-terminated binder_block may back it yet —
 * otherwise a stale tab could stack a second block on a pocket run that is already filled.
 */
async function assertBlockDestinationOpen(
  db: DbClient,
  destination: MoveDestination,
): Promise<void> {
  if (destination.kind !== "block") return;
  const slot = await lineSlotRepo.getByPk(db, destination.slotId);
  if (!slot || slot.line_id !== destination.lineId || slot.state !== "block") {
    throw new Error("That block slot no longer exists — reload the screen and pick again.");
  }
  const line = await evolutionLineRepo.getByPk(db, destination.lineId);
  if (!line || line.binder_id !== destination.binderId) {
    throw new Error("That line is not in that binder any more — reload the screen and pick again.");
  }
  const blocks = await binderBlockRepo.list(db);
  if (blocks.some((b) => b.line_id === destination.lineId && b.purpose === "line-terminated")) {
    throw new Error(
      "That line's block pocket is already filled — reload the screen and pick again.",
    );
  }
}

/**
 * Refuse a collection destination that would orphan the card even WITH the membership write.
 *
 * `union_collection_targets` matches by id and silently writes nothing when no row matches — that is
 * deliberate and correct for the backfill tagger, but here a no-op union is indistinguishable from the
 * bug UIL-022 describes: the copy lands in the binder, the list never gains it. Two stale-client cases
 * reach it, both from a tab left open across a Collections edit:
 *
 *   1. the collection was DELETED → the union matches nothing, and the card sits in an ex-collection's
 *      binder on no list at all;
 *   2. the collection has since MOVED to a different binder → the union lands, but membership is
 *      derived from `current_binder_ids` (app/(ui)/coll/actions.ts `loadCollHub`), so the card reads as
 *      an un-owned target she is still chasing while she is in fact holding it.
 *
 * Both are refused here rather than in the client, for the same reason `blockedTargetDrops` is a
 * server-side refusal: a stale page or a second tab walks straight past a hidden control.
 */
async function assertCollectionDestinationLives(
  db: DbClient,
  destination: MoveDestination,
): Promise<void> {
  if (destination.kind !== "collection") return;
  const col = await collectionRepo.getByPk(db, destination.collectionId);
  if (!col) {
    throw new Error("That collection no longer exists — reload the screen and pick a home again.");
  }
  if (!(col.current_binder_ids ?? []).includes(destination.binderId)) {
    throw new Error(
      `${col.name} does not live in that binder any more — reload the screen and pick a home again.`,
    );
  }
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
  pickedCatalogCardId?: string,
): Promise<void> {
  const model = await buildScreenModel(db);
  const derived = model.derived.find((d) => d.card.id === decisionId);
  if (!derived) throw new Error("That decision is no longer open — the line state has changed.");

  // `pickedCatalogCardId` is validated against THIS freshly-derived resolution's own options inside
  // resolveDecisionWrites/wishlistUpsertFor — never trusted outright, the same rule a stale slot/line
  // id already follows here.
  const writes = resolveDecisionWrites(derived.resolution, choiceId, pickedCatalogCardId);

  // Line status.
  if (writes.linePatch?.status) {
    await evolutionLineRepo.update(db, derived.resolution.lineId, {
      status: writes.linePatch.status,
    });
  }

  // Slot state / target changes, including the UIL-078 "stays resolved" marker: state in state,
  // so the marker survives whatever happens to the audit trail (docs/issue-log.md UIL-042).
  for (const p of writes.slotPatches) {
    const patch: Record<string, unknown> = {};
    if (p.state !== undefined) patch.state = p.state;
    if (p.copyId !== undefined) patch.copy_id = p.copyId;
    /**
     * UIL-091: a pick re-points this. THE COLUMN'S MEANING, stated here because it is the write site and
     * because 0019 and every future reader depend on it: a NULL target means "the cheapest at load" — the
     * loader resolves it from `altOptions` each time, so it follows prices and new printings — and a STORED
     * target means "she chose this". That is why migration 0019 RELEASED foreign-locale targets instead of
     * re-pointing them (none was her choice), and why `pickedTargetPatch` emits only on a validated explicit
     * pick: stamping the engine's current default would freeze a live answer into a decision nobody made.
     */
    if (p.targetCatalogCardId !== undefined) patch.target_catalog_card_id = p.targetCatalogCardId;
    if (p.note !== undefined) patch.note = p.note;
    if (p.resolvedDecisionKind !== undefined) patch.resolved_decision_kind = p.resolvedDecisionKind;
    if (p.resolvedDecisionChoice !== undefined) {
      patch.resolved_decision_choice = p.resolvedDecisionChoice;
    }
    if (p.resolvedDecisionCollectionId !== undefined) {
      patch.resolved_decision_collection_id = p.resolvedDecisionCollectionId;
    }
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

  // Audit (dev-spec §4 — one row per user decision). `line_id`/`line_slot_id` are traceability only
  // (UIL-078) — naming which slot this row was about, since nothing here or anywhere else reads them
  // back to decide behaviour (that's `line_slot.resolved_decision_kind`'s job, not this table's).
  await placementDecisionRepo.insert(db, {
    owner_id: ownerId,
    haul_id: null,
    copy_id: null,
    line_id: derived.resolution.lineId,
    line_slot_id: derived.resolution.slotId,
    decision: writes.decision.decision,
    reason: writes.decision.reason,
    resolved_by: "user",
  });
}
