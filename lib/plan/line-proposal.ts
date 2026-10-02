/**
 * What the Haul Plan PROPOSES for a card headed into a back half (UIL-117, mockup v3 section 1): the cascade's
 * result as the popup's `LineProposal`, whose `kind` is the row badge. Karvi: "The user must always authorize all
 * moves." So every one of these waits for her tap; none is placed by the cascade on its own any more.
 *
 *   NEWLINE (step "line-new")                          start    green   "Starts X line"
 *   FILL (an existing line's open slot)                add      yellow  "Adds to X line"
 *   an UPGRADE of the card in a line slot              replace  pink    pre-set to Swap, the old copy to bulk
 *     (a holo or reverse holo over one that is neither, any printing of the species: UIL-126)
 *
 * A PLAIN extra copy of a stage a line already holds is NOT a line card any more (UIL-126, Karvi's ruling): no badge,
 * no popup required, a front-half Done; the spotlight names the line (`extraCopyOfFor`) and offers her the swap.
 * Everything else (front half, bulk, specialty, an upgrade over a front-half copy) has no line and no proposal.
 *
 * PURE: the slot lookups come in as functions over the plan context's line rows, so this is pinned without a
 * database.
 */

import type { CascadeResult, CatalogCard } from "@/lib/engine";
import type { LineProposal } from "@/lib/line/popup";
import type { ExtraCopyOf } from "./types";

export interface LineLookups {
  /** "KB-003 · Back · Red", where a line lives. Optional for hand-built lookups. */
  lineWhere?(lineId: string): string | null;
  /** The card filling a slot, "Charmeleon 027/197". Optional for hand-built lookups. */
  heldAt?(slotId: string): string | null;
  /** The slot at this stage of this line, or null when the line (or the stage) is gone. */
  slotIdAt(lineId: string, stageIndex: number): string | null;
  /** The line a slot belongs to, or null when the slot is gone. */
  lineOfSlot(slotId: string): string | null;
  /** A line's name, as the popup names it: its top stage's card ("Charizard"). Optional for hand-built lookups. */
  lineName?(lineId: string): string | null;
  /**
   * A species' card name by dex id ("Charizard"), for a line not written yet: in the form and language of `like`, the
   * card that starts it (UIL-133: "Starts Arven's Toedscruel line"). Optional for hand-built lookups.
   */
  dexName?(dexId: number, like?: CatalogCard): string | null;
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
    // A plain extra copy for a filled stage has no proposal (UIL-126): see `extraCopyOfFor`.
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
 * A card that waits for her OK before it is written (UIL-117): its placement is in a line. Read off the cascade
 * result itself, NOT off the proposal, so a line or slot the proposal could not name still counts: the rule fails
 * safe. An upgrade of a card in a line slot targets that slot (`back-half-line`, lineId "inherited"), so it counts;
 * a PLAIN extra copy is placed in a front half and no longer does (UIL-126).
 */
export function isLineCard(result: CascadeResult): boolean {
  return result.target.kind === "back-half-line";
}

/**
 * The line a PLAIN extra copy duplicates, for the spotlight's note and its "Swap this one into the line…" (UIL-126).
 * Null for every other card, and when the slot cannot be found.
 */
export function extraCopyOfFor(result: CascadeResult, l: LineLookups): ExtraCopyOf | null {
  const filled = result.step === "line-existing" && !result.swap ? result.filledStage : null;
  if (!filled) return null;
  const slotId = l.slotIdAt(filled.lineId, filled.stageIndex);
  if (!slotId) return null;
  return {
    lineId: filled.lineId,
    slotId,
    lineName: l.lineName?.(filled.lineId) ?? null,
    where: l.lineWhere?.(filled.lineId) ?? "its line",
    held: l.heldAt?.(slotId) ?? "a card",
  };
}

/**
 * The name the row badge gives a line (v3 section 1: "＋ Starts Charizard line", "◆ Adds to Toedscruel line"): its
 * top stage, the way the popup names it. Null for a replace, which stays generic, and when it cannot be named.
 */
export function lineNameFor(
  result: CascadeResult,
  l: LineLookups,
  /** The card starting a new line: the line takes its form (UIL-133). */
  card?: CatalogCard,
): string | null {
  if (result.step === "line-new" && result.newLine) {
    const top = result.newLine.slots.at(-1);
    return top ? (l.dexName?.(top.dexId, card) ?? null) : null;
  }
  const open = result.step === "line-existing" ? result.filledExistingSlot : null;
  return open ? (l.lineName?.(open.lineId) ?? null) : null;
}
