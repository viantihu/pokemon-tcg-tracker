/**
 * The line popup's shared vocabulary (UIL-117, mockup v3): what a screen PROPOSES for a card headed into a back
 * half, what she CHOOSES in the popup, and the model the popup renders. Every screen that can send a card into a
 * back half (Haul Plan, the Move sheet on Lines / Lookup / Collections, Backfill, a Lines Replace) speaks these
 * types, so there is one popup and one way a line gets written (`buildLineChoiceOps`, ./line-choice.ts).
 *
 * Karvi's rules this encodes: every move into a back half goes through the popup and needs her OK; a pull of a
 * card she already owns is never ticked for her (UIL-061); a replace opens on "keep the one that's there"; a card
 * coming out of a line can go anywhere, with the bulk box suggested; joining a line in another language takes a
 * second, explicit confirm (the Senior BA's Q1 ruling).
 *
 * Pure: types and small helpers only, no I/O.
 */

import type { Locale } from "@/lib/sync/types";
import type { CardIdentity, ExistingLineBlock, MoveDestination } from "./types";

/* --------------------------------------- what she chooses --------------------------------------- */

/** Her choice in the popup: the ONE input every back-half write takes. */
export type LineChoice =
  /** Start a new line here. `pulls` are the owned copies she TICKED to move into it (UIL-061; empty = none). */
  | { mode: "start"; binderId: string; band: string; pulls: string[] }
  /** Join an existing line's open slot. `foreignLocale` is her second confirm for a line in another language. */
  | { mode: "join"; lineId: string; slotId: string; foreignLocale?: true }
  /** A copy for a filled slot: keep the one that's there (nothing in the line moves) … */
  | { mode: "replace"; lineId: string; slotId: string; keep: true }
  /** … or swap it in, sending the card coming out to `outgoing` (anywhere; bulk is the suggestion). */
  | { mode: "replace"; lineId: string; slotId: string; keep: false; outgoing: MoveDestination };

/* --------------------------------------- what a screen proposes --------------------------------------- */

/**
 * A screen's proposal for a back-half card, before she chooses. Its `kind` is the row badge (v3 section 1):
 * `start` green, `add` yellow, `replace` pink. The popup opens pre-set to it, and nothing is written until she
 * confirms. A `replace` proposal opens on Keep unless `defaultKeep` is false (the holo upgrade, pre-set to swap
 * with the old copy going to bulk, today's rule).
 */
export type LineProposal =
  | { kind: "start"; binderId: string | null; band: string }
  | { kind: "add"; lineId: string; slotId: string }
  | { kind: "replace"; lineId: string; slotId: string; defaultKeep: boolean };

export type LineBadge = LineProposal["kind"];

/* --------------------------------------- what the popup shows --------------------------------------- */

/**
 * One stage of the line, as the popup lays it out (v3 sections 3-5):
 *   incoming  the card being placed ("New · this haul" / "Moving in")
 *   here      a card already filling the slot ("Already here")
 *   pullable  a card she owns elsewhere that could fill it: shown UNTICKED, "Pull it into this line"
 *   wanted    an open slot with no card yet (a placeholder; it goes on her wishlist as today)
 *   blocked   a slot no card can fill
 */
export type LineStageState = "incoming" | "here" | "pullable" | "wanted" | "blocked";

export interface LinePopupStage {
  stageIndex: number;
  stage: string;
  state: LineStageState;
  /** The card shown in the slot: the incoming, the one already here, the pull candidate, or the wanted target. */
  card: CardIdentity | null;
  /** `here`: the copy filling the slot. */
  copyId?: string;
  /** `pullable`: the owned copy, and where it is now ("KB-001 · Front · Red"). */
  pull?: { copyId: string; fromLabel: string };
}

/** The line the popup is about: a new one being started, or the existing one being added to or replaced in. */
export interface LinePopupLine {
  /** Null while it is only being started. */
  lineId: string | null;
  binderId: string | null;
  binderName: string;
  bandKey: string;
  bandDisplay: string;
  locale: Locale;
  /** Filled slots now, and after the confirm, of `total`. */
  filledBefore: number;
  filledAfter: number;
  total: number;
}

/** UIL-096: every line this family already has, anywhere, so she sees it before starting a second one. */
export interface LinePopupExistingLine extends ExistingLineBlock {
  binderName: string;
  bandDisplay: string;
  /** The open slot this card could take, or null when that stage is already filled there. */
  joinSlotId: string | null;
  /** Same binder, same band, same language as this card: the natural one to join. */
  sameHere: boolean;
}

/** Everything the popup renders. Built server-side from fresh state (`loadLinePopupModel`), never trusted back. */
export interface LinePopupModel {
  mode: "start" | "add" | "replace";
  copyId: string;
  card: CardIdentity & { locale: Locale };
  line: LinePopupLine;
  stages: LinePopupStage[];
  existingLines: LinePopupExistingLine[];
}

/* --------------------------------------- the popup's own props --------------------------------------- */

/** app/(ui)/_components/LinePopup.tsx. The stepping ("Confirm & next") belongs to the screen, not the popup. */
export interface LinePopupProps {
  model: LinePopupModel;
  value: LineChoice;
  onChange(choice: LineChoice): void;
  onConfirm(choice: LineChoice): void;
  onCancel(): void;
  /** "Line card k of N in this haul" (v3). Absent outside a step-through. */
  position?: { index: number; total: number };
  /** Defaults per mode ("Start line", "Add to line", "Swap them"); a step-through appends "· next ▶". */
  confirmLabel?: string;
  busy?: boolean;
  error?: string | null;
  /** The incoming card's label: "Moving in" on the Move sheet (default), "New · this haul" on the Haul Plan. */
  incomingLabel?: string;
  /** "Add to that line" on an existing line: the screen reloads the model for that proposal. */
  onSwitch?(proposal: LineProposal): void;
}

/* --------------------------------------- small shared rules --------------------------------------- */

/**
 * A line's status from the slots it holds: `complete` only when every slot is filled (the Senior BA's rule, which
 * 0028 now enforces), `capped` when the engine capped it, else `open`. The one derivation every line writer uses.
 */
export function lineStatusFor(
  slotStates: readonly string[],
  capped = false,
): "open" | "capped" | "complete" {
  if (slotStates.length > 0 && slotStates.every((s) => s === "filled")) return "complete";
  return capped ? "capped" : "open";
}

/** The choice a proposal opens on: nothing is ever pre-ticked, and Keep is the default for a replace. */
export function defaultChoiceFor(proposal: LineProposal): LineChoice {
  switch (proposal.kind) {
    case "start":
      return { mode: "start", binderId: proposal.binderId ?? "", band: proposal.band, pulls: [] };
    case "add":
      return { mode: "join", lineId: proposal.lineId, slotId: proposal.slotId };
    case "replace":
      return proposal.defaultKeep
        ? { mode: "replace", lineId: proposal.lineId, slotId: proposal.slotId, keep: true }
        : {
            mode: "replace",
            lineId: proposal.lineId,
            slotId: proposal.slotId,
            keep: false,
            outgoing: { kind: "bulk" },
          };
  }
}
