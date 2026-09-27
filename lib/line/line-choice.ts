/**
 * The ONE way a line gets written (UIL-117): her `LineChoice` from the line popup, turned into `apply_write_ops` ops
 * against FRESH server-read state. Every screen that sends a card into a back half ends here, so the rules below
 * hold everywhere at once:
 *
 *   - START writes a new line around the card, pulling ONLY the owned copies she ticked (UIL-061: an unticked
 *     stage stays a placeholder, "left in place (not confirmed)"), each pull releasing the slot it leaves and
 *     leaving its own audit row, and derives the line's status from the slots it actually writes (a line is
 *     `complete` only when every slot is filled; 0028 enforces the same).
 *   - JOIN fills an existing line's open slot, checked against that slot: the card must be its species, and a
 *     line in another language takes her second confirm AND a same-language card already on a LOWER stage, so the
 *     line's derived language (UIL-090: lowest filled stage) never flips (the Senior BA's ruling).
 *   - REPLACE arrives in UIL-117 PR 3.
 *
 * Returns the line-side ops and the slot the moving card lands in. The caller writes the moving copy itself
 * (`buildMoveOps` for a Move, `emitIncomingCopy` for the Haul Plan) using `placement`, which is the LINE's binder and
 * band, never the browser's. Pure: no I/O, and nothing from the client is trusted beyond the choice itself.
 */

import {
  generateSlots,
  lineLocaleOf,
  testViability,
  type Band,
  type CatalogCard,
  type IncomingCard,
  type LineSlotRecord,
  type OwnedCopy,
  type TypeColorMap,
} from "@/lib/engine";
import { localeOfId } from "@/lib/catalog/locale";
import type { Row, WriteOp } from "@/lib/repo";
import { buildExistingLineJoinOps, releaseSlotOps } from "./move";
import { lineStatusFor, type LineChoice } from "./popup";

/** Everything `buildLineChoiceOps` reads, loaded fresh by the server just before the write. */
export interface LineWriteState {
  /** The copy being placed. */
  copy: Row<"copy">;
  /** Its card, engine-shaped (`incoming.id` is the copy's id). */
  incoming: IncomingCard;
  catalog: CatalogCard[];
  typeColorMap: TypeColorMap;
  /** Her other copies, engine-shaped: the pull candidates a new line can propose (START only). */
  owned: OwnedCopy[];
  /** Row data for every copy this write may touch (the pull candidates), for their current slot. */
  copiesById: Map<string, Row<"copy">>;
  /** The lines this write may touch: the one joined, and any line a pulled copy leaves. */
  lines: Map<string, Row<"evolution_line">>;
  slotsByLine: Map<string, Row<"line_slot">[]>;
}

export interface LineChoiceWrite {
  ops: WriteOp[];
  lineId: string;
  /** The slot the moving copy fills. */
  slotId: string;
  /** Where the moving copy goes: the LINE's binder and band, back half. */
  placement: { binder_id: string | null; binder_half: "back"; color_band: string };
}

const LANGUAGE: Record<string, string> = { en: "English", ja: "Japanese" };
const languageName = (l: string) => LANGUAGE[l] ?? l;
/** "an English" / "a Japanese": "Start an English line instead." */
const withArticle = (l: string) =>
  `${/^[aeiou]/i.test(languageName(l)) ? "an" : "a"} ${languageName(l)}`;

export function buildLineChoiceOps(
  state: LineWriteState,
  copyId: string,
  choice: LineChoice,
): LineChoiceWrite {
  if (state.copy.id !== copyId || state.incoming.id !== copyId) {
    throw new Error("That card changed while the line was open — reload the screen and try again.");
  }
  switch (choice.mode) {
    case "start":
      return startLine(state, choice);
    case "join":
      return joinLine(state, choice);
    case "replace":
      throw new Error("Replacing a card in a line is not available here yet.");
  }
}

/* ----------------------------------------------- start ----------------------------------------------- */

function startLine(
  state: LineWriteState,
  choice: Extract<LineChoice, { mode: "start" }>,
): LineChoiceWrite {
  if (!choice.binderId) throw new Error("Pick the binder the line goes in.");
  const owned = state.owned.filter((o) => o.id !== state.copy.id);
  // The engine's own chain walk and slot generation, as the cascade's new line uses, with the band SHE chose and
  // viability forced: starting a line from one card is her call, not a proposal the engine must be sure of.
  const chainViability = testViability(state.incoming, owned, state.catalog, state.typeColorMap);
  const viability = { ...chainViability, band: choice.band as Band, viable: true };
  const gen = generateSlots(state.incoming, viability, owned, state.catalog, state.typeColorMap);

  const proposedPulls = new Set(
    gen.slots.map((s) => s.copyId).filter((id): id is string => !!id && id !== state.copy.id),
  );
  for (const id of choice.pulls) {
    if (!proposedPulls.has(id)) {
      throw new Error(
        "One of the cards ticked to pull is no longer one this line can take — reload and pick again.",
      );
    }
  }
  const ticked = new Set(choice.pulls);

  const lineId = crypto.randomUUID();
  const rootDexId = viability.chain[0]?.dexId ?? state.incoming.card.dexId[0];
  const slotOps: WriteOp[] = [];
  const pullOps: WriteOp[] = [];
  const finalStates: string[] = [];
  let ownSlotId: string | null = null;

  for (const slot of gen.slots) {
    const slotId = crypto.randomUUID();
    const isIncoming = slot.stageIndex === gen.incomingStageIndex;
    const proposedPull = !isIncoming && slot.copyId ? slot.copyId : null;
    const pulled = proposedPull !== null && ticked.has(proposedPull);
    const declined = proposedPull !== null && !pulled;
    const state_ = isIncoming || pulled ? "filled" : declined ? "placeholder" : slot.state;
    finalStates.push(state_);
    if (isIncoming) ownSlotId = slotId;
    slotOps.push({
      op: "insert_slot",
      id: slotId,
      line_id: lineId,
      stage_index: slot.stageIndex,
      stage: slot.stage,
      state: state_,
      copy_id: isIncoming ? state.copy.id : pulled ? proposedPull : null,
      target_catalog_card_id: slot.targetCatalogCardId,
      note: declined ? "left in place (not confirmed)" : (slot.note ?? null),
    });
    if (pulled) pullOps.push(...pullInto(state, proposedPull!, slotId, choice));
  }
  if (!ownSlotId) throw new Error("That card has no stage in this line — pick another line.");

  const ops: WriteOp[] = [
    {
      op: "insert_line",
      id: lineId,
      root_dex_id: rootDexId,
      color_band: choice.band,
      binder_id: choice.binderId,
      half: "back",
      status: lineStatusFor(finalStates, gen.status === "capped"),
    },
    ...slotOps,
    ...pullOps,
  ];
  return {
    ops,
    lineId,
    slotId: ownSlotId,
    placement: { binder_id: choice.binderId, binder_half: "back", color_band: choice.band },
  };
}

/** A ticked pull: release the slot it leaves (only if that slot really holds it), shelve it here, audit it. */
function pullInto(
  state: LineWriteState,
  copyId: string,
  slotId: string,
  choice: Extract<LineChoice, { mode: "start" }>,
): WriteOp[] {
  const row = state.copiesById.get(copyId);
  if (!row)
    throw new Error(
      "A card ticked to pull is no longer in the collection — reload and pick again.",
    );
  const ops: WriteOp[] = [];
  if (row.line_slot_id) {
    const leaving = [...state.slotsByLine.values()].flat().find((s) => s.id === row.line_slot_id);
    if (leaving && leaving.copy_id === row.id) {
      const line = state.lines.get(leaving.line_id);
      ops.push(...releaseSlotOps(leaving.id, line?.status === "complete" ? line.id : null));
    }
  }
  ops.push(
    {
      op: "update_copy",
      id: copyId,
      patch: {
        role: "shelved",
        binder_id: choice.binderId,
        binder_half: "back",
        color_band: choice.band,
        line_slot_id: slotId,
      },
    },
    {
      op: "insert_decision",
      haul_id: null,
      copy_id: copyId,
      decision: "line-pull-confirmed",
      reason:
        `Moved into a new ${choice.band} line at your confirmation ` +
        `(was ${row.binder_half ?? "unplaced"}${row.color_band ? ` · ${row.color_band}` : ""}, role ${row.role}).`,
      resolved_by: "user",
    },
  );
  return ops;
}

/* ----------------------------------------------- join ----------------------------------------------- */

function joinLine(
  state: LineWriteState,
  choice: Extract<LineChoice, { mode: "join" }>,
): LineChoiceWrite {
  const line = state.lines.get(choice.lineId);
  const slots = state.slotsByLine.get(choice.lineId) ?? [];
  const slot = slots.find((s) => s.id === choice.slotId);
  if (!line || !slot)
    throw new Error("That line slot no longer exists — reload the screen and pick again.");
  if (slot.state === "filled") {
    throw new Error("That slot has already been filled — reload the screen and pick again.");
  }

  const catalogById = new Map(state.catalog.map((c) => [c.tcgdexId, c]));
  if (slot.target_catalog_card_id) {
    const target = catalogById.get(slot.target_catalog_card_id);
    const same = !!target && state.incoming.card.dexId.some((d) => target.dexId.includes(d));
    if (!same)
      throw new Error(
        "That slot is for a different card — pick the slot for this card's own stage.",
      );
  }

  // UIL-090's derivation: the line's language is its lowest filled stage's (else its lowest target's).
  const cardLocale = localeOfId(state.incoming.card.tcgdexId);
  const cardOf = (id: string) => state.copiesById.get(id)?.catalog_card_id ?? null;
  const lineLocale = lineLocaleOf(
    slots.map((s) => ({
      id: s.id,
      stageIndex: s.stage_index,
      stage: s.stage,
      state: s.state as LineSlotRecord["state"],
      copyId: s.copy_id,
      dexId: null,
      targetCatalogCardId: s.target_catalog_card_id,
    })),
    cardOf,
  );
  if (cardLocale !== lineLocale) {
    if (!choice.foreignLocale) {
      throw new Error(
        `That line is in another language (${languageName(lineLocale)}) than this card (${languageName(cardLocale)}). ` +
          "Confirm joining it anyway, or start a line in the card's own language.",
      );
    }
    // Only where it cannot flip the line: a card of the LINE's language already fills a lower stage.
    const anchored = slots.some(
      (s) =>
        s.state === "filled" &&
        s.stage_index < slot.stage_index &&
        s.copy_id !== null &&
        localeOfId(cardOf(s.copy_id) ?? "") === lineLocale,
    );
    if (!anchored) {
      throw new Error(
        `This would make the line read as ${languageName(cardLocale)}. Start ${withArticle(cardLocale)} line instead.`,
      );
    }
  }

  const slotIsLastOpen = slots.every((s) => s.id === slot.id || s.state === "filled");
  return {
    ops: buildExistingLineJoinOps({
      copyId: state.copy.id,
      lineId: line.id,
      slotId: slot.id,
      slotIsLastOpen,
    }).ops,
    lineId: line.id,
    slotId: slot.id,
    placement: { binder_id: line.binder_id, binder_half: "back", color_band: line.color_band },
  };
}
