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

import { toCatalogCard, toOwnedCopy } from "@/lib/plan/adapt";
import type { TypeColorMap, Variant } from "@/lib/engine";
import {
  applyWriteOps,
  catalogCardRepo,
  collectionRepo,
  copyRepo,
  evolutionLineRepo,
  lineSlotRepo,
  typeColorMapRepo,
  type DbClient,
  type Row,
  type SlotPatch,
  type WriteOp,
  binderBlockRepo,
} from "@/lib/repo";
import { resolveDecisionWrites } from "./decisions";
import { buildScreenModel } from "./load";
import {
  buildMoveOps,
  describeMove,
  isMoveDestinationComplete,
  lineJoinOf,
  type MoveNameLookups,
} from "./move";
import type { DecisionChoiceId, LineJoinChoice, MoveDestination, MoveRequest } from "./types";
import { buildLineChoiceOps, type LineWriteState } from "./line-choice";
import type { LineChoice } from "./popup";
import { lineReadsClosed } from "./popup";

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
/**
 * A join is checked against THE LINE (UIL-117 gap 2): the destination the browser sent must be the line's own binder,
 * back half and band. A stale sheet, a line with no binder (the panel then fell back to the first general binder) or
 * any caller that skips the panel is refused rather than silently corrected. The card-against-slot checks (species,
 * and language with its second confirm) live in `buildLineChoiceOps`, the one line builder.
 */
async function assertJoinMatchesLine(
  db: DbClient,
  lineId: string,
  dest: MoveDestination,
): Promise<void> {
  const line = await evolutionLineRepo.getByPk(db, lineId);
  if (!line) throw new Error("That line no longer exists — reload the screen and pick again.");
  if (dest.kind !== "shelf" || dest.half !== "back" || dest.binderId !== line.binder_id) {
    throw new Error("That line is in another binder — reload the screen and pick the line again.");
  }
  if (dest.band !== line.color_band) {
    throw new Error(
      "That line is in another colour band — reload the screen and pick the line again.",
    );
  }
}

/**
 * A START is written where the card is going, or not at all (QA on #385): the line is built from the choice's binder
 * and band while the copy is placed from the destination, and 0028 checks the binder but not the band, so a stale or
 * bypassing caller could otherwise leave a copy shelved in one band inside a line in another. Refused rather than
 * silently corrected, the same rule a join follows (`assertJoinMatchesLine`).
 */
function assertStartMatchesDestination(
  choice: Extract<LineChoice, { mode: "start" }>,
  dest: MoveDestination,
): void {
  if (dest.kind !== "shelf" || dest.half !== "back" || dest.binderId !== choice.binderId) {
    throw new Error(
      "That new line is for another binder than the one this card is moving to — reload the screen and start it again.",
    );
  }
  if (dest.band !== choice.band) {
    throw new Error(
      "That new line is for another colour band than the one this card is moving to — reload the screen and start it again.",
    );
  }
}

/**
 * The line ops for one copy moving into a back half (UIL-117), shared by every server path that can do it (a Move,
 * a Collections removal, the Haul Plan). A join or a replace is checked against its line, a start against the
 * destination; then the ONE line builder runs on fresh state. A replace's card coming out is checked like any move
 * (a collection that still exists), and when it goes into another back half, its own line choice is checked and
 * built by the same rules, from the same fresh read.
 *
 * NO "a line already exists" refusal on START (UIL-096). Karvi overruled it: "Instead of blocking the creation of an
 * evolution line, I want a warning that there is a line existing in my ENTIRE collection." The warning is the popup's,
 * shown before she confirms; by the time a request reaches here she has chosen to start one anyway.
 */
export async function buildBackHalfLineOps(
  db: DbClient,
  copy: Row<"copy">,
  destination: MoveDestination,
  choice: LineChoice,
  opts: { undecidedOk?: boolean } = {},
): Promise<{ ops: WriteOp[]; slotId: string }> {
  if (choice.mode === "join") await assertJoinMatchesLine(db, choice.lineId, destination);
  if (choice.mode === "start") assertStartMatchesDestination(choice, destination);
  if (choice.mode === "replace") {
    if (choice.keep) {
      throw new Error(
        "Keeping the card that's there means this one doesn't go into the line — pick where it goes instead.",
      );
    }
    await assertJoinMatchesLine(db, choice.lineId, destination);
    await assertCollectionDestinationLives(db, choice.outgoing);
  }
  const state = await loadLineWriteState(db, copy, choice);
  if (choice.mode === "replace" && !choice.keep && choice.outgoingLine) {
    const slot = [...state.slotsByLine.values()].flat().find((sl) => sl.id === choice.slotId);
    const outgoing = slot?.copy_id ? state.copiesById.get(slot.copy_id) : undefined;
    if (!outgoing)
      throw new Error("That slot is no longer filled — reload the screen and pick again.");
    const next = choice.outgoingLine;
    if (next.mode === "join") await assertJoinMatchesLine(db, next.lineId, choice.outgoing);
    else assertStartMatchesDestination(next, choice.outgoing);
    state.outgoing = await loadLineWriteState(db, outgoing, next);
  }
  const built = buildLineChoiceOps(state, copy.id, choice, opts);
  return { ops: built.ops, slotId: built.slotId };
}

/** The older `lineJoin` on a Move destination, read as the popup's choice (UIL-117): the same rules either way. */
function lineChoiceFromJoin(join: LineJoinChoice | null, dest: MoveDestination): LineChoice | null {
  if (!join || dest.kind !== "shelf") return null;
  return join.mode === "existing"
    ? { mode: "join", lineId: join.lineId, slotId: join.slotId }
    : // UIL-121: no stage is decided for her; the builder writes this older request's other stages undecided.
      { mode: "start", binderId: dest.binderId, band: dest.band, pulls: [], stages: {} };
}

/**
 * Fresh state for `buildLineChoiceOps`: the copy's card, the catalog and type map for a new line's slots, her other
 * copies as pull candidates, and every line and slot (for a joined line's language, and the slots pulls leave).
 */
async function loadLineWriteState(
  db: DbClient,
  copy: Row<"copy">,
  choice: LineChoice,
): Promise<LineWriteState> {
  const [catalogRows, typeMapRows, copies, lines, slots, blocks] = await Promise.all([
    catalogCardRepo.listAll(db),
    typeColorMapRepo.list(db),
    copyRepo.list(db),
    evolutionLineRepo.list(db),
    lineSlotRepo.list(db),
    binderBlockRepo.list(db),
  ]);
  const catalog = catalogRows.map(toCatalogCard);
  const catalogById = new Map(catalog.map((c) => [c.tcgdexId, c]));
  const card = catalogById.get(copy.catalog_card_id);
  if (!card) throw new Error("That card's catalog entry is missing — reload and try again.");
  const typeColorMap: TypeColorMap = {};
  for (const t of typeMapRows) typeColorMap[t.card_type] = t.band;
  const slotsByLine = new Map<string, Row<"line_slot">[]>();
  for (const sl of slots) slotsByLine.set(sl.line_id, [...(slotsByLine.get(sl.line_id) ?? []), sl]);
  const blocksByLine = new Map<string, Row<"binder_block">[]>();
  for (const b of blocks) {
    if (b.line_id) blocksByLine.set(b.line_id, [...(blocksByLine.get(b.line_id) ?? []), b]);
  }
  return {
    copy,
    incoming: { id: copy.id, card, variant: (copy.variant as Variant) ?? "normal" },
    catalog,
    typeColorMap,
    owned:
      choice.mode === "start"
        ? copies
            .filter((c) => c.id !== copy.id)
            .map((c) => toOwnedCopy(c, catalogById))
            .filter((o): o is NonNullable<typeof o> => o !== null)
        : [],
    copiesById: new Map(copies.map((c) => [c.id, c])),
    lines: new Map(lines.map((l) => [l.id, l])),
    slotsByLine,
    blocksByLine,
  };
}

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
  // A popup choice (UIL-117) IS the line instruction for a back-half destination, in place of the older lineJoin.
  const choiceCompletes =
    !!req.lineChoice && req.destination.kind === "shelf" && req.destination.half === "back";
  if (!choiceCompletes && !isMoveDestinationComplete(req.destination)) {
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
      if (line && lineReadsClosed(line.status)) demoteLineId = line.id;
    }
  }

  // Moving a card INTO the back half writes a line (UIL-056), through the ONE line builder (UIL-117): her popup
  // choice when the screen sent one, else the older `lineJoin` read as the same choice. Every id is re-read fresh
  // here and nothing about the line is trusted from the browser; the card lands in the LINE's binder and band.
  const join = lineJoinOf(req.destination);
  let lineJoinOps: WriteOp[] | undefined;
  let resolvedLineSlotId: string | null | undefined;
  if (req.destination.kind === "shelf" && req.destination.half === "back") {
    const choice = req.lineChoice ?? lineChoiceFromJoin(join, req.destination);
    if (choice) {
      // An older `lineJoin` (no popup) carries no stage choices: its unfilled stages are written undecided.
      const built = await buildBackHalfLineOps(db, copy, req.destination, choice, {
        undecidedOk: !req.lineChoice,
      });
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

  /**
   * ONE `apply_write_ops` CALL (UIL-095). Until 0021 this was a SEQUENCE: the line's status, then one update
   * per slot patch, then a read of the whole `wishlist_item` table, then a wishlist update or insert per
   * slot, then the audit row. Any failure after the first left her decision half-applied — a line capped
   * with its slot unmarked, a slot re-pointed with no wishlist row, or every write landed and NO audit row,
   * which UIL-042 says is not optional. Same shape as UIL-014, UIL-023 and UIL-033, and the same answer.
   *
   * THE WISHLIST OPS ARE KEYED ON THE SLOT, which is what let the read go. The old code read every wishlist
   * row to find the open one for a slot, then chose update-or-insert from that snapshot: a read-modify-write
   * across statements, the fault 0007 fixed in `union_collection_targets`. `upsert_wishlist_for_slot`
   * conflicts on 0021's partial unique index instead, so Postgres decides from the row it locks.
   *
   * ORDER IS TODAY'S ORDER — line, slots, wishlist resolves, wishlist upserts, audit — so the audit trail
   * reads the same as before. This is a change of transaction boundary, not of outcome, and the op-set
   * assertion in tests/line/decision-atomicity.test.ts is what says so.
   */
  const ops: WriteOp[] = [];

  if (writes.linePatch?.status) {
    ops.push({
      op: "update_line",
      id: derived.resolution.lineId,
      patch: { status: writes.linePatch.status },
    });
  }

  // Slot state / target changes, including the UIL-078 "stays resolved" marker: state in state, so the
  // marker survives whatever happens to the audit trail (docs/issue-log.md UIL-042).
  for (const p of writes.slotPatches) {
    const patch: SlotPatch = {};
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
    // UIL-121 (0030): these cards predate her stage choices and retire in A2. A slot one of them rewrites goes
    // back to "undecided" rather than keeping a chase or an empty its answer no longer matches (0030 checks both).
    if (Object.keys(patch).length > 0) {
      patch.stage_choice = null;
      ops.push({ op: "update_slot", id: p.slotId, patch });
    }
  }

  // Wishlist: resolve (close) some, upsert (create/refresh) others. No read first — see the note above.
  const patched = new Set(writes.slotPatches.map((p) => p.slotId));
  for (const slotId of writes.wishlistResolveSlotIds) {
    ops.push({ op: "resolve_wishlist_for_slot", line_slot_id: slotId });
    // A closed wish on a stage she was chasing: the chase is over, so the stage is undecided again (0030).
    if (!patched.has(slotId)) {
      ops.push({ op: "update_slot", id: slotId, patch: { stage_choice: null } });
    }
  }
  for (const up of writes.wishlistUpserts) {
    ops.push({
      op: "upsert_wishlist_for_slot",
      line_slot_id: up.lineSlotId,
      required_dex_id: up.requiredDexId,
      required_type: up.requiredType,
      required_stage: up.requiredStage,
      chosen_catalog_card_id: up.chosenCatalogCardId,
      alternate_catalog_card_ids: up.alternateCatalogCardIds,
      will_live_in_specialty: up.willLiveInSpecialty,
      // Never set by this path before 0021 either: a decision's wishlist row is not held for a binder.
      held_for_binder_id: null,
    });
  }

  // Audit (dev-spec §4 — one row per user decision). `line_id`/`line_slot_id` are traceability only
  // (UIL-078) — nothing here or anywhere else reads them back to decide behaviour (that is
  // `line_slot.resolved_decision_kind`'s job, not this table's) — and 0021 taught `insert_decision` to
  // carry them so moving this write inside the transaction did not quietly drop them.
  ops.push({
    op: "insert_decision",
    haul_id: null,
    copy_id: null,
    line_id: derived.resolution.lineId,
    line_slot_id: derived.resolution.slotId,
    decision: writes.decision.decision,
    reason: writes.decision.reason,
    resolved_by: "user",
  });

  await applyWriteOps(db, { ops });
}
