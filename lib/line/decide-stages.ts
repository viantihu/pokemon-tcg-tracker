/**
 * Lines' "Choose" (UIL-121 A2c): her choice for an EXISTING line's open stages, and for a complete short line's third
 * pocket, as one write. Karvi, 2026-09-27: nothing is written for her; she decides each empty stage (chase a card,
 * leave it empty, a filler) or decides it later. This is where a stage she left "Not decided" (in the popup, or on a
 * line from before her choices existed) gets decided, and where she changes her mind.
 *
 * Checked through the shared rule (./stage-choice) on fresh state. Changing a stage takes out what it had: a filler's
 * block comes out (a spare card back to her bulk box), and a chase that is no longer a chase closes its wish. The
 * line's status follows her choices (`lineStatusOf`). PURE: the caller reads the state and applies the writes.
 */

import { buildChain, type CatalogCard, type TypeColorMap } from "@/lib/engine";
import { localeOfId } from "@/lib/catalog/locale";
import type { Row, WriteOp } from "@/lib/repo";
import { stageStateFor, typeOfBand } from "./line-choice";
import { lineReadsClosed, lineStatusOf, type StageDecision, type ThirdPocketChoice } from "./popup";
import {
  hasThirdPocket,
  stageWriteOps,
  thirdPocketWriteOps,
  validateStageDecision,
  validateThirdPocket,
} from "./stage-choice";

/** Her choices on Lines: by stage index, and the third pocket. Only the stages she is deciding or changing. */
export interface DecideStagesChoice {
  lineId: string;
  stages: Record<number, StageDecision>;
  thirdPocket?: ThirdPocketChoice;
}

/** Fresh state for one line. */
export interface DecideStagesState {
  line: Row<"evolution_line">;
  slots: Row<"line_slot">[];
  blocks: Row<"binder_block">[];
  catalog: CatalogCard[];
  copiesById: Map<string, Row<"copy">>;
  typeColorMap: TypeColorMap;
}

/** Her words, for the two refusals this adds to the shared rule's. */
export const DECIDE_REFUSAL = {
  filled: "That stage already holds a card. Move or replace the card instead.",
  noStage: "That line has no such stage any more. Reload and choose again.",
} as const;

/** A copy out of a pocket, back to her bulk box. */
const toBulk = (copyId: string): WriteOp => ({
  op: "update_copy",
  id: copyId,
  patch: { role: "bulk", binder_id: null, binder_half: null, color_band: null, line_slot_id: null },
});

export function buildDecideStagesOps(st: DecideStagesState, choice: DecideStagesChoice): WriteOp[] {
  const { line, slots, blocks } = st;
  const cardOf = new Map(st.catalog.map((c) => [c.tcgdexId, c]));
  // The line's species chain, from a card that is in it (a filled stage), else from its root's printing.
  const anchor =
    slots
      .map((s) => (s.copy_id ? st.copiesById.get(s.copy_id)?.catalog_card_id : null))
      .find(Boolean) ?? st.catalog.find((c) => c.dexId.includes(line.root_dex_id))?.tcgdexId;
  const anchorCard = anchor ? cardOf.get(anchor) : undefined;
  const chain = anchorCard
    ? buildChain({ id: "line", card: anchorCard, variant: "normal" }, st.catalog)
    : [];
  const lineLocale = anchorCard ? localeOfId(anchorCard.tcgdexId) : "en";
  const shared = stageStateFor(st.catalog, st.copiesById);
  const requiredType = typeOfBand(line.color_band, st.typeColorMap);

  const ops: WriteOp[] = [];
  const after = new Map(slots.map((s) => [s.id, { state: s.state, stageChoice: s.stage_choice }]));

  for (const [key, d] of Object.entries(choice.stages)) {
    const index = Number(key);
    const slot = slots.find((s) => s.stage_index === index);
    const node = chain[index];
    if (!slot || !node) throw new Error(DECIDE_REFUSAL.noStage);
    if (slot.state === "filled") throw new Error(DECIDE_REFUSAL.filled);

    // What the stage had comes out first: a filler's block (a spare card back to bulk).
    for (const b of blocks.filter((x) => x.line_slot_id === slot.id)) {
      ops.push({ op: "delete_binder_block", id: b.id, line_id: line.id });
      if (b.copy_id) ops.push(toBulk(b.copy_id));
    }

    if (d.kind === "later") {
      // Back to "Not decided": an open slot with no choice, no card named, on no wishlist.
      ops.push(
        { op: "resolve_wishlist_for_slot", line_slot_id: slot.id },
        {
          op: "update_slot",
          id: slot.id,
          patch: {
            state: "placeholder",
            target_catalog_card_id: null,
            note: null,
            stage_choice: null,
          },
        },
      );
      after.set(slot.id, { state: "placeholder", stageChoice: null });
      continue;
    }
    const w = validateStageDecision(
      shared,
      {
        lineId: line.id,
        slotId: slot.id,
        stageIndex: index,
        stage: slot.stage,
        dexId: node.dexId,
        speciesName: node.name,
        lineLocale,
        binderId: line.binder_id ?? "",
        requiredType,
      },
      d,
    );
    ops.push(...stageWriteOps(slot.id, w));
    after.set(slot.id, {
      state: w.slotPatch.state ?? "placeholder",
      stageChoice: w.slotPatch.stage_choice ?? null,
    });
  }

  // The third pocket: a complete line shorter than three pockets. Changing it takes out what filled it.
  const finals = [...after.values()];
  if (choice.thirdPocket) {
    const complete = finals.every((f) => f.state === "filled");
    const t = {
      lineId: line.id,
      binderId: line.binder_id ?? "",
      slotCount: slots.length,
      completeAfterWrite: complete,
    };
    if (!hasThirdPocket(t)) validateThirdPocket(shared, t, choice.thirdPocket); // refuses, in her words
    for (const b of blocks.filter((x) => x.line_slot_id === null && x.purpose === "line-filler")) {
      ops.push({ op: "delete_binder_block", id: b.id, line_id: line.id });
      if (b.copy_id) ops.push(toBulk(b.copy_id));
    }
    if (choice.thirdPocket.material === "later") {
      ops.push({ op: "update_line", id: line.id, patch: { extra_pocket: null } });
    } else {
      const pocket = validateThirdPocket(shared, t, choice.thirdPocket);
      if (pocket) ops.push(...thirdPocketWriteOps(line.id, pocket));
    }
  }

  const nowClosed = lineStatusOf(finals) === "closed";
  if (nowClosed !== lineReadsClosed(line.status)) {
    ops.push({ op: "update_line", id: line.id, patch: { status: nowClosed ? "closed" : "open" } });
  }
  return ops;
}
