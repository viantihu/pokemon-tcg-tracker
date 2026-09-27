/**
 * What the Haul Plan PROPOSES for a card headed into a back half (UIL-117, mockup v3 section 1): the cascade's
 * result as the popup's `LineProposal`, whose `kind` is the row badge. Karvi: "The user must always authorize all
 * moves." So every one of these waits for her tap; none is placed by the cascade on its own any more.
 *
 *   NEWLINE (step "line-new")                          start    green   "Starts X line"
 *   FILL (an existing line's open slot)                add      yellow  "Adds to X line"
 *   a copy for a FILLED stage ("lines tracked once")   replace  pink    "Could replace a card", opens on Keep
 *   a holo over a copy that sits in a line slot        replace  pink    pre-set to Swap, the old copy to bulk
 *
 * Everything else (front half, bulk, specialty, a holo over a front-half copy) has no line and no proposal, and
 * behaves as it does today.
 *
 * PURE: the slot lookups come in as functions over the plan context's line rows, so this is pinned without a
 * database.
 */

import type { CascadeResult } from "@/lib/engine";
import type { LineProposal } from "@/lib/line/popup";

export interface LineLookups {
  /** The slot at this stage of this line, or null when the line (or the stage) is gone. */
  slotIdAt(lineId: string, stageIndex: number): string | null;
  /** The line a slot belongs to, or null when the slot is gone. */
  lineOfSlot(slotId: string): string | null;
  /** A line's name, as the popup names it: its top stage's card ("Charizard"). Optional for hand-built lookups. */
  lineName?(lineId: string): string | null;
  /** A species' card name by dex id ("Charizard"), for a line not written yet. Optional for hand-built lookups. */
  dexName?(dexId: number): string | null;
}

export function lineProposalFor(result: CascadeResult, l: LineLookups): LineProposal | null {
  if (result.step === "line-new" && result.newLine) {
    return { kind: "start", binderId: result.newLine.binderId, band: result.newLine.colorBand };
  }
  if (result.step === "line-existing") {
    const open = result.filledExistingSlot;
    if (open) {
      const slotId = l.slotIdAt(open.lineId, open.stageIndex);
      return slotId ? { kind: "add", lineId: open.lineId, slotId } : null;
    }
    const filled = result.filledStage;
    if (filled) {
      const slotId = l.slotIdAt(filled.lineId, filled.stageIndex);
      return slotId ? { kind: "replace", lineId: filled.lineId, slotId, defaultKeep: true } : null;
    }
    return null;
  }
  const inherited = result.step === "duplicate" ? result.swap?.incomingInherits.lineSlotId : null;
  if (inherited) {
    const lineId = l.lineOfSlot(inherited);
    return lineId ? { kind: "replace", lineId, slotId: inherited, defaultKeep: false } : null;
  }
  return null;
}

/**
 * A card that waits for her OK before it is written (UIL-117): its placement is in a line, or it could replace the
 * card in one. Read off the cascade result itself, NOT off the proposal, so a line or slot the proposal could not
 * name still counts: the rule fails safe.
 */
export function isLineCard(result: CascadeResult): boolean {
  // A holo over a copy in a line slot targets that slot (`back-half-line`, lineId "inherited"), so the first test
  // covers it; a copy for a filled stage is placed in a front half, so it needs the second.
  return result.target.kind === "back-half-line" || !!result.filledStage;
}

/**
 * The name the row badge gives a line (v3 section 1: "＋ Starts Charizard line", "◆ Adds to Toedscruel line"): its
 * top stage, the way the popup names it. Null for a replace, which stays generic, and when it cannot be named.
 */
export function lineNameFor(result: CascadeResult, l: LineLookups): string | null {
  if (result.step === "line-new" && result.newLine) {
    const top = result.newLine.slots.at(-1);
    return top ? (l.dexName?.(top.dexId) ?? null) : null;
  }
  const open = result.step === "line-existing" ? result.filledExistingSlot : null;
  return open ? (l.lineName?.(open.lineId) ?? null) : null;
}
