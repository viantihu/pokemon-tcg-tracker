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
 *   - REPLACE (PR 3) swaps the card into a FILLED slot in one write, so the line never shows a gap: the card coming
 *     out goes to her `outgoing` destination (anywhere; bulk suggested), or into another line when that is a back
 *     half (`outgoingLine`, built by these same rules), and gets its own audit row. Checked like a join: the card
 *     must be the slot's species, and one in another language takes her confirm and a same-language card below.
 *     A Keep writes nothing for the line, so it never reaches here.
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
import { isStandInId, localeOfId, standInIdFor } from "@/lib/catalog/locale";
import type { Row, WriteOp } from "@/lib/repo";
import {
  buildExistingLineJoinOps,
  collectionTargetJoinOp,
  placementForMove,
  releaseSlotOps,
} from "./move";
import { lineReadsClosed, lineStatusOf, type LineChoice, type StageDecision } from "./popup";
import {
  stageWriteOps,
  thirdPocketWriteOps,
  validateStageDecision,
  validateThirdPocket,
  type StageCatalogCard,
  type StageState,
} from "./stage-choice";

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
  /** UIL-121: the blocks on each line, for a stage filler a joining card replaces. */
  blocksByLine: Map<string, Row<"binder_block">[]>;
  /** REPLACE into another back half: the same state for the card coming out, which `outgoingLine` places. */
  outgoing?: LineWriteState;
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
  /**
   * UIL-121: an older request with no line popup (a Move destination's `lineJoin`) carries no stage choices. Its
   * unfilled stages are written UNDECIDED (an open slot, nothing chosen for her) rather than refused, so a card
   * always moves; Lines' "Choose" asks her later. The popup's choices are always checked.
   */
  opts: { undecidedOk?: boolean } = {},
): LineChoiceWrite {
  if (state.copy.id !== copyId || state.incoming.id !== copyId) {
    throw new Error("That card changed while the line was open — reload the screen and try again.");
  }
  switch (choice.mode) {
    case "start":
      return startLine(state, choice, opts.undecidedOk === true);
    case "join":
      return joinLine(state, choice, opts.undecidedOk === true);
    case "replace":
      if (choice.keep) {
        // A Keep leaves the line as it is; the screen places the card. Refused so no caller thinks it wrote one.
        throw new Error(
          "Keeping the card that's there writes nothing to the line — place this card where it goes instead.",
        );
      }
      return replaceInLine(state, choice);
  }
}

/* ----------------------------------------------- start ----------------------------------------------- */

function startLine(
  state: LineWriteState,
  choice: Extract<LineChoice, { mode: "start" }>,
  undecidedOk: boolean,
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
  let ownSlotId: string | null = null;

  // Another card for this line still waiting in her haul: then nothing is asked on this confirm.
  const cardWaits = gen.slots.some(
    (sl) =>
      sl.stageIndex !== gen.incomingStageIndex &&
      !(sl.copyId && ticked.has(sl.copyId)) &&
      waitingInHaul(state, sl.dexId),
  );
  // UIL-121: every stage the line leaves unfilled is HER choice (chase a card, leave it empty, or a filler), checked
  // here on fresh state. Nothing is blocked, capped or wishlisted for her: an unfilled stage is inserted as an open
  // slot and then written as she chose.
  const st = stageStateOf(state);
  const requiredType = typeOfBand(choice.band, state.typeColorMap);
  const stageOps: WriteOp[] = [];
  const finalStages: { state: string; stageChoice?: string | null }[] = [];
  for (const slot of gen.slots) {
    const slotId = crypto.randomUUID();
    const isIncoming = slot.stageIndex === gen.incomingStageIndex;
    const proposedPull = !isIncoming && slot.copyId ? slot.copyId : null;
    const pulled = proposedPull !== null && ticked.has(proposedPull);
    const filled = isIncoming || pulled;
    if (isIncoming) ownSlotId = slotId;
    slotOps.push({
      op: "insert_slot",
      id: slotId,
      line_id: lineId,
      stage_index: slot.stageIndex,
      stage: slot.stage,
      state: filled ? "filled" : "placeholder",
      copy_id: isIncoming ? state.copy.id : pulled ? proposedPull : null,
      target_catalog_card_id: filled ? slot.targetCatalogCardId : null,
      note: filled ? (slot.note ?? null) : null,
    });
    if (pulled) pullOps.push(...pullInto(state, proposedPull!, slotId, choice));
    if (filled) {
      finalStages.push({ state: "filled" });
      continue;
    }
    // Not decided now: she chose "Decide later"; or it is not asked yet, because this is an older request with no
    // popup, or another card for this line still waits in her haul (Karvi's ruling: she is asked about what is
    // missing only once she places the LAST card she has for the line).
    const d = choice.stages?.[slot.stageIndex];
    if (d?.kind === "later" || (d === undefined && (undecidedOk || cardWaits))) {
      finalStages.push({ state: "placeholder", stageChoice: null });
      continue;
    }
    const write = validateStageDecision(
      st,
      {
        lineId,
        slotId,
        stageIndex: slot.stageIndex,
        stage: slot.stage,
        dexId: slot.dexId,
        speciesName: viability.chain[slot.stageIndex]?.name ?? "that card",
        lineLocale: localeOfId(state.incoming.card.tcgdexId),
        binderId: choice.binderId,
        requiredType,
      },
      choice.stages?.[slot.stageIndex],
    );
    stageOps.push(...stageWriteOps(slotId, write));
    finalStages.push({
      state: write.slotPatch.state ?? "placeholder",
      stageChoice: write.slotPatch.stage_choice,
    });
  }
  if (!ownSlotId) throw new Error("That card has no stage in this line — pick another line.");
  const pocket = validateThirdPocket(
    st,
    {
      lineId,
      binderId: choice.binderId,
      slotCount: gen.slots.length,
      completeAfterWrite:
        finalStages.every((f) => f.state === "filled") &&
        !(undecidedOk && !choice.thirdPocket) &&
        choice.thirdPocket?.material !== "later",
    },
    choice.thirdPocket?.material === "later" ? undefined : choice.thirdPocket,
  );

  const ops: WriteOp[] = [
    {
      op: "insert_line",
      id: lineId,
      root_dex_id: rootDexId,
      color_band: choice.band,
      binder_id: choice.binderId,
      half: "back",
      status: lineStatusOf(finalStages),
    },
    ...slotOps,
    ...pullOps,
    ...stageOps,
    ...(pocket ? thirdPocketWriteOps(lineId, pocket) : []),
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
      ops.push(...releaseSlotOps(leaving.id, lineReadsClosed(line?.status) ? line!.id : null));
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
  undecidedOk: boolean,
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

  const cardOf = (id: string) => state.copiesById.get(id)?.catalog_card_id ?? null;
  assertLanguageHolds(state, slots, slot, cardOf, choice.foreignLocale === true);

  // UIL-121: her choice for the line's other open stages she has not decided (Karvi's ruling: with the last card she
  // has placed, she is asked about what is still missing); then the line reads closed once no stage waits, and a card
  // that completes a short line asks what fills its third pocket, unless she has already said.
  const others = decideOtherStages(state, line, slots, slot.id, choice.stages, undecidedOk);
  const after = others.after;
  const nowClosed = lineStatusOf(after) === "closed";
  const closes = nowClosed && !lineReadsClosed(line.status);
  const pocket = validateThirdPocket(
    stageStateOf(state),
    {
      lineId: line.id,
      binderId: line.binder_id ?? "",
      slotCount: slots.length,
      // An older request with no popup leaves the pocket for Lines to ask about.
      completeAfterWrite:
        line.extra_pocket == null &&
        after.every((a) => a.state === "filled") &&
        !(undecidedOk && !choice.thirdPocket) &&
        choice.thirdPocket?.material !== "later",
    },
    choice.thirdPocket?.material === "later" ? undefined : choice.thirdPocket,
  );
  return {
    ops: [
      // A stage that held a filler: the card takes its pocket, so the filler comes out (a spare card back to the
      // bulk box), in the same write.
      ...fillerOutOps(state, line.id, slot),
      ...buildExistingLineJoinOps({
        copyId: state.copy.id,
        lineId: line.id,
        slotId: slot.id,
        slotIsLastOpen: closes,
      }).ops,
      ...others.ops,
      // A closed line she now chases a stage on reads open again.
      ...(!nowClosed && lineReadsClosed(line.status)
        ? [{ op: "update_line" as const, id: line.id, patch: { status: "open" } }]
        : []),
      ...(pocket ? thirdPocketWriteOps(line.id, pocket) : []),
    ],
    lineId: line.id,
    slotId: slot.id,
    placement: { binder_id: line.binder_id, binder_half: "back", color_band: line.color_band },
  };
}

/**
 * UIL-090's derivation: a line's language is its lowest filled stage's (else its lowest target's). A card in another
 * language takes her second confirm, and even then only where a card of the LINE's language already fills a LOWER
 * stage, so the line's language never flips (the Senior BA's ruling on Q1). Shared by join and replace.
 */
function assertLanguageHolds(
  state: LineWriteState,
  slots: Row<"line_slot">[],
  slot: Row<"line_slot">,
  cardOf: (copyId: string) => string | null,
  confirmed: boolean,
): void {
  const cardLocale = localeOfId(state.incoming.card.tcgdexId);
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
  if (cardLocale === lineLocale) return;
  if (!confirmed) {
    throw new Error(
      `That line is in another language (${languageName(lineLocale)}) than this card (${languageName(cardLocale)}). ` +
        "Confirm joining it anyway, or start a line in the card's own language.",
    );
  }
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

/* ----------------------------------------------- replace ----------------------------------------------- */

function replaceInLine(
  state: LineWriteState,
  choice: Extract<LineChoice, { mode: "replace"; keep: false }>,
): LineChoiceWrite {
  const line = state.lines.get(choice.lineId);
  const slots = state.slotsByLine.get(choice.lineId) ?? [];
  const slot = slots.find((s) => s.id === choice.slotId);
  if (!line || !slot)
    throw new Error("That line slot no longer exists — reload the screen and pick again.");
  if (slot.state !== "filled" || !slot.copy_id) {
    throw new Error("That slot is no longer filled — add this card to it instead of replacing.");
  }
  const outgoingId = slot.copy_id;
  if (outgoingId === state.copy.id) throw new Error("That card is already in this slot.");
  const outgoingRow = state.copiesById.get(outgoingId);
  if (!outgoingRow)
    throw new Error("The card in that slot is no longer in the collection — reload the screen.");

  const catalogById = new Map(state.catalog.map((c) => [c.tcgdexId, c]));
  const slotCard =
    catalogById.get(slot.target_catalog_card_id ?? "") ??
    catalogById.get(outgoingRow.catalog_card_id);
  if (!slotCard || !state.incoming.card.dexId.some((d) => slotCard.dexId.includes(d))) {
    throw new Error("That slot is for a different card — pick the slot for this card's own stage.");
  }

  const cardOf = (id: string) => state.copiesById.get(id)?.catalog_card_id ?? null;
  assertLanguageHolds(state, slots, slot, cardOf, choice.foreignLocale === true);

  // Where the card coming out goes: anywhere she picked, or into another line built by these same rules.
  const out = choice.outgoing;
  if (out.kind === "block")
    throw new Error("A card coming out of a line can't become a binder block here.");
  const intoBackHalf = out.kind === "shelf" && out.half === "back";
  if (intoBackHalf !== !!choice.outgoingLine) {
    throw new Error(
      intoBackHalf
        ? "The card coming out is going into a back half — pick the line it goes into."
        : "The card coming out isn't going into a back half — reload the screen and pick again.",
    );
  }
  const outOps: WriteOp[] = [];
  let outPatch = placementForMove(out);
  if (choice.outgoingLine) {
    if (!state.outgoing || state.outgoing.copy.id !== outgoingId) {
      throw new Error("The card coming out changed while the line was open — reload the screen.");
    }
    if (choice.outgoingLine.mode === "start" && choice.outgoingLine.pulls.includes(state.copy.id)) {
      throw new Error("The card going into this line can't also be pulled into the other one.");
    }
    const nested = buildLineChoiceOps(state.outgoing, outgoingId, choice.outgoingLine);
    outOps.push(...nested.ops);
    outPatch = { role: "shelved", ...nested.placement, line_slot_id: nested.slotId };
  }

  const ops: WriteOp[] = [
    // The other line (if any) first, so the pointer below names a slot that exists; then the card coming out
    // lets go of this slot BEFORE the incoming card is named in it, so the slot never names two cards.
    ...outOps,
    {
      op: "update_copy",
      id: outgoingId,
      patch: {
        role: outPatch.role,
        binder_id: outPatch.binder_id,
        binder_half: outPatch.binder_half,
        color_band: outPatch.color_band,
        line_slot_id: outPatch.line_slot_id,
      },
    },
    { op: "update_slot", id: slot.id, patch: { copy_id: state.copy.id } },
  ];
  const joinList = collectionTargetJoinOp(out, outgoingRow.catalog_card_id);
  if (joinList) ops.push(joinList);
  ops.push({
    op: "insert_decision",
    haul_id: null,
    copy_id: outgoingId,
    decision: "line-replaced-out",
    reason:
      `Swapped out of its ${line.color_band} line at your confirmation, for ${state.incoming.card.name}; ` +
      `now ${describePatch(outPatch)}.`,
    resolved_by: "user",
  });
  // UIL-121: a swap places her card in the line too, so the line's other open stages she has not decided are asked.
  const others = decideOtherStages(state, line, slots, slot.id, choice.stages, false);
  ops.push(...others.ops);
  const nowClosed = lineStatusOf(others.after) === "closed";
  if (nowClosed !== lineReadsClosed(line.status)) {
    ops.push({ op: "update_line", id: line.id, patch: { status: nowClosed ? "closed" : "open" } });
  }
  return {
    ops,
    lineId: line.id,
    slotId: slot.id,
    placement: { binder_id: line.binder_id, binder_half: "back", color_band: line.color_band },
  };
}

/** Her words for where a card went, for its audit row. */
function describePatch(p: ReturnType<typeof placementForMove>): string {
  if (p.role === "bulk") return "in the bulk box";
  if (p.binder_half === "back") return `in a ${p.color_band} line, back half`;
  if (p.binder_half === "front") return `in the front half · ${p.color_band}`;
  return "in a collection's binder";
}

/* ----------------------------------------------- UIL-121 ----------------------------------------------- */

/** Fresh state as her stage choices are checked against (lib/line/stage-choice). */
function stageStateOf(state: LineWriteState): StageState {
  const asStage = (c: CatalogCard): StageCatalogCard => ({
    tcgdexId: c.tcgdexId,
    name: c.name,
    dexId: c.dexId,
    cardClass: c.cardClass,
    setName: c.setName ?? null,
    localId: c.localId,
    locale: localeOfId(c.tcgdexId),
  });
  const byId = new Map(state.catalog.map((c) => [c.tcgdexId, c]));
  const norm = (v: string) => v.trim().toLowerCase();
  return {
    card: (id) => {
      const c = byId.get(id);
      return c ? asStage(c) : null;
    },
    copy: (id) => {
      const r = state.copiesById.get(id);
      return r ? { id: r.id, role: r.role } : null;
    },
    standIns: state.catalog.filter((c) => isStandInId(c.tcgdexId)).map(asStage),
    mirrorCandidates: (d) =>
      state.catalog
        .filter((c) => !isStandInId(c.tcgdexId) && norm(c.name) === norm(d.name))
        .map(asStage),
    newId: () => crypto.randomUUID(),
    newStandInId: standInIdFor,
  };
}

/** The line colour's representative type, for her wishlist's `required_type` and a placeholder card's type. */
function typeOfBand(bandKey: string, map: TypeColorMap): string | null {
  return Object.entries(map).find(([, b]) => b === bandKey)?.[0] ?? null;
}

/** A card joining a stage that held a filler: the filler's block comes out, and a spare card goes back to bulk. */
function fillerOutOps(state: LineWriteState, lineId: string, slot: Row<"line_slot">): WriteOp[] {
  if (slot.state !== "block") return [];
  const ops: WriteOp[] = [];
  for (const b of state.blocksByLine.get(lineId) ?? []) {
    if (b.line_slot_id !== slot.id) continue;
    ops.push({ op: "delete_binder_block", id: b.id, line_id: lineId });
    if (b.copy_id) {
      ops.push({
        op: "update_copy",
        id: b.copy_id,
        patch: {
          role: "bulk",
          binder_id: null,
          binder_half: null,
          color_band: null,
          line_slot_id: null,
        },
      });
    }
  }
  return ops;
}

/** A copy of this stage's species still waiting in her haul, in the line's language: its stage is not asked yet. */
function waitingInHaul(
  state: LineWriteState,
  dexId: number,
  locale = localeOfId(state.incoming.card.tcgdexId),
): boolean {
  const cardOf = new Map(state.catalog.map((c) => [c.tcgdexId, c]));
  return [...state.copiesById.values()].some(
    (c) =>
      c.id !== state.copy.id &&
      c.role === "haul" &&
      (cardOf.get(c.catalog_card_id)?.dexId ?? []).includes(dexId) &&
      localeOfId(c.catalog_card_id) === locale,
  );
}

/**
 * UIL-121, Karvi's ruling: once she places the last card she has for a line, she is asked about the stages still
 * missing. For a join or a swap, every OTHER open stage of the line she has not decided (a placeholder with no stage
 * choice) takes her choice, checked by the shared rule, unless its card is still waiting in her haul (it is asked
 * when that card is placed) or the request is an older one with no popup. The slots' states afterwards, for the
 * line's status, come back with the writes.
 */
function decideOtherStages(
  state: LineWriteState,
  line: Row<"evolution_line">,
  slots: Row<"line_slot">[],
  placedSlotId: string,
  decisions: Record<number, StageDecision> | undefined,
  undecidedOk: boolean,
): { ops: WriteOp[]; after: { state: string; stageChoice?: string | null }[] } {
  const chain = testViability(state.incoming, [], state.catalog, state.typeColorMap).chain;
  const cardOf = (id: string) => state.copiesById.get(id)?.catalog_card_id ?? null;
  const lineLocale = lineLocaleOf(slots.map(toRecord), cardOf);
  const st = stageStateOf(state);
  const ops: WriteOp[] = [];
  const after: { state: string; stageChoice?: string | null }[] = [];
  const isOpen = (s: Row<"line_slot">) => s.state === "placeholder" && s.stage_choice == null;
  // Another card for this line still waiting in her haul: nothing is asked on this confirm; the last one asks.
  const cardWaits = slots.some(
    (s) =>
      s.id !== placedSlotId &&
      isOpen(s) &&
      !!chain[s.stage_index] &&
      waitingInHaul(state, chain[s.stage_index].dexId, lineLocale),
  );
  for (const s of slots) {
    if (s.id === placedSlotId) {
      after.push({ state: "filled" });
      continue;
    }
    const node = chain[s.stage_index];
    const d = decisions?.[s.stage_index];
    if (
      !isOpen(s) ||
      !node ||
      d?.kind === "later" ||
      (d === undefined && (undecidedOk || cardWaits))
    ) {
      after.push({ state: s.state, stageChoice: s.stage_choice });
      continue;
    }
    const w = validateStageDecision(
      st,
      {
        lineId: line.id,
        slotId: s.id,
        stageIndex: s.stage_index,
        stage: s.stage,
        dexId: node.dexId,
        speciesName: node.name,
        lineLocale,
        binderId: line.binder_id ?? "",
        requiredType: typeOfBand(line.color_band, state.typeColorMap),
      },
      d,
    );
    ops.push(...stageWriteOps(s.id, w));
    after.push({
      state: w.slotPatch.state ?? "placeholder",
      stageChoice: w.slotPatch.stage_choice,
    });
  }
  return { ops, after };
}

const toRecord = (s: Row<"line_slot">): LineSlotRecord => ({
  id: s.id,
  stageIndex: s.stage_index,
  stage: s.stage,
  state: s.state as LineSlotRecord["state"],
  copyId: s.copy_id,
  dexId: null,
  targetCatalogCardId: s.target_catalog_card_id,
});
