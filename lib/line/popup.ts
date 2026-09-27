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

import type { Language } from "@/lib/catalog/locale";
import type { Locale } from "@/lib/sync/types";
import type { CardIdentity, ExistingLineBlock, MoveDestination, MoveOptions } from "./types";

/* --------------------------------------- what she chooses --------------------------------------- */

/** Her choice in the popup: the ONE input every back-half write takes. */
export type LineChoice =
  /**
   * Start a new line here. `pulls` are the owned copies she TICKED to move into it (UIL-061; empty = none).
   * `stages` is her choice for EVERY stage left unfilled, by stage index (UIL-121: nothing is decided for her), and
   * `thirdPocket` what fills the last pocket when the line is complete with fewer than LINE_ROW_POCKETS cards.
   */
  | {
      mode: "start";
      binderId: string;
      band: string;
      pulls: string[];
      stages: Record<number, StageDecision>;
      thirdPocket?: ThirdPocketChoice;
    }
  /**
   * Join an existing line's open slot. `foreignLocale` is her second confirm for a line in another language;
   * `thirdPocket` her choice when this card completes a short line whose last pocket she has not decided.
   */
  | {
      mode: "join";
      lineId: string;
      slotId: string;
      foreignLocale?: true;
      thirdPocket?: ThirdPocketChoice;
    }
  /**
   * A copy for a filled slot: keep the one that's there (nothing in the line moves). NOT a line write: the builder
   * refuses it, and the incoming card's placement is the screen's. `incoming` is where she sent it on Keep when the
   * popup offered her the picker (the Senior BA: a holo kept out of a line gets it, bulk suggested); absent, the
   * screen's own default (the Haul Plan: today's front half).
   */
  | { mode: "replace"; lineId: string; slotId: string; keep: true; incoming?: MoveDestination }
  /**
   * … or swap it in, in one write with no gap, sending the card coming out to `outgoing` (anywhere; bulk is the
   * suggestion). An `outgoing` back half needs `outgoingLine`, the line the card coming out joins or starts.
   * `foreignLocale` is her second confirm when the incoming card is in another language than the line.
   */
  | {
      mode: "replace";
      lineId: string;
      slotId: string;
      keep: false;
      outgoing: MoveDestination;
      outgoingLine?: OutgoingLineChoice;
      foreignLocale?: true;
    };

/** Where a card coming out of a line goes when that is another back half: a line it starts or joins. */
export type OutgoingLineChoice = Extract<LineChoice, { mode: "start" } | { mode: "join" }>;

/* --------------------------------------- her choice for each stage --------------------------------------- */

/**
 * What she chose for one unfilled stage of a line (UIL-121, Karvi 2026-09-27: nothing is written for her). Chase a card
 * (one in the catalog, or a placeholder card she makes because the catalog lacks it), leave the stage empty, or record
 * what physically fills its pocket. Checked on the server by `validateStageDecision` (./stage-choice).
 */
export type StageDecision =
  | { kind: "chase"; catalogCardId: string }
  | { kind: "chase"; newStandIn: StandInDraft }
  | { kind: "empty" }
  | { kind: "filler"; filler: FillerChoice };

/**
 * A pocket's filler: a basic energy (untracked), or one of her copies, which becomes a block there. `from` is where
 * she picked the card from (default her bulk box; Backfill also offers her haul): the server holds the card to it.
 */
export type FillerChoice =
  { material: "energy" } | { material: "card"; copyId: string; from?: FillerSource };

/** Where a filler card can come from: her bulk box (every screen), or her haul (Backfill, after the bulk box). */
export type FillerSource = "bulk" | "haul";

/** What fills a complete short line's third pocket (UIL-121 Q4): a filler, or nothing. */
export type ThirdPocketChoice = FillerChoice | { material: "empty" };

/**
 * A placeholder card she makes from the popup: a CATALOG-ONLY stand-in (no copy; UIL-108's form). Its dex id, stage,
 * types and card class are the stage's, set on the server; only what she typed travels.
 */
export interface StandInDraft {
  name: string;
  setName: string | null;
  localId: string | null;
  language: Language;
}

/** A printing she can chase for a stage: the species in the line's language, same colour first (UIL-121 Q2). */
export interface StageOption {
  card: CardIdentity;
  sameColour: boolean;
  /** A specialty-class printing: it lives in the specialty binder. */
  special: boolean;
  priceMarket: number | null;
}

/** One of her spare copies that could fill a pocket, and where it is now ("Bulk box", "This haul"). */
export interface FillerCardOption {
  copyId: string;
  card: CardIdentity;
  where: string;
  /** Its source, sent back with her pick. Absent: the bulk box. */
  from?: FillerSource;
}

/** Pockets in one row of her binder page (3x3). A complete line with fewer cards has a third pocket to fill. */
export const LINE_ROW_POCKETS = 3;

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
 *   wanted    an open slot with no card yet (a placeholder; on her wishlist only if SHE adds it: Karvi, UIL-119)
 *   blocked   a slot no card can fill
 *   coming    UIL-121: an open slot whose card is still waiting in THIS haul. She is not asked about it now; it joins
 *             when she places that card (Karvi's ruling: she is asked about a missing stage only after the last card
 *             she has for the line)
 */
export type LineStageState = "incoming" | "here" | "pullable" | "wanted" | "blocked" | "coming";

export interface LinePopupStage {
  stageIndex: number;
  stage: string;
  state: LineStageState;
  /** The card shown in the slot: the incoming, the one already here, the pull candidate, or the wanted target. */
  card: CardIdentity | null;
  /** `here`: the copy filling the slot. */
  copyId?: string;
  /** `pullable`: the owned copy, and where it is now ("KB-001 · Front · Red"). */
  pull?: {
    copyId: string;
    fromLabel: string;
    /**
     * The line this card fills now, which a pull leaves one short (UIL-061's "in another line", restored for every
     * screen). Absent for a card in a front half, the bulk box or the haul.
     */
    leaves?: { lineName: string; stage: string };
  };
  /** The stage's species (UIL-121): what her choice for an unfilled stage is checked against. */
  dexId?: number;
  /**
   * An existing line's open stage (UIL-121): what she chose for it, or null when she has not yet. The card shown is
   * her chase's only when she chose one; an engine's stored pick is never shown as hers.
   */
  choice?: "chase" | "empty" | "filler" | null;
  /** `coming`: the copy waiting in this haul that will fill it. */
  coming?: { copyId: string };
  /**
   * An unfilled stage's suggestion (UIL-121): the cheapest same-colour printing in the line's language, else the
   * special one when that is all there is (`special`). SHOWN, never selected: she chooses.
   */
  suggestion?: { card: CardIdentity; special: boolean } | null;
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
  /**
   * The line's stored status now (UIL-121: read it through `lineReadsClosed`, never as a string), for a screen's
   * forecast of whether her confirm leaves the line done. Null while the line is only being started.
   */
  status?: string | null;
  /**
   * UIL-121: the line is shorter than LINE_ROW_POCKETS and she has not yet said what fills its third pocket, so a
   * confirm that completes it asks. Absent on a new line (its pocket is always undecided).
   */
  thirdPocketOpen?: boolean;
}

/** UIL-096: every line this family already has, anywhere, so she sees it before starting a second one. */
export interface LinePopupExistingLine extends ExistingLineBlock {
  binderName: string;
  bandDisplay: string;
  /** The open slot this card could take, or null when that stage is already filled there. */
  joinSlotId: string | null;
  /** Same binder, same band, same language as this card: the natural one to join. */
  sameHere: boolean;
  /** The line's most evolved card she holds there (else its top target), so the tile leads with an image. */
  face?: CardIdentity | null;
}

/** One side of a replace: a card, its copy, and where it is now in her words ("KB-003 · Back · Red"). */
export interface LinePopupReplaceCard {
  copyId: string;
  card: CardIdentity;
  where: string;
}

/** A replace (v3 section 5): the two cards for the one slot, side by side, and where the one coming out goes. */
export interface LinePopupReplace {
  slotId: string;
  stageIndex: number;
  /** The card in the slot now. */
  current: LinePopupReplaceCard;
  /** The card that could take its place. */
  incoming: LinePopupReplaceCard;
  /** Opens on Keep unless false (the holo upgrade). */
  defaultKeep: boolean;
  /** Where the card coming out goes unless she picks elsewhere: the bulk box. */
  suggestedOutgoing: MoveDestination;
}

/** Everything the popup renders. Built server-side from fresh state (`loadLinePopupModel`), never trusted back. */
export interface LinePopupModel {
  mode: "start" | "add" | "replace";
  copyId: string;
  card: CardIdentity & { locale: Locale };
  line: LinePopupLine;
  stages: LinePopupStage[];
  existingLines: LinePopupExistingLine[];
  /** Present exactly when `mode` is "replace". */
  replace?: LinePopupReplace;
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
  position?: {
    index: number;
    total: number;
    /**
     * Another line card is still waiting after this one. The SCREEN knows (Confirm & next wraps back to cards she
     * skipped, so "last" is not index === total); absent, it falls back to index < total.
     */
    next?: boolean;
  };
  /** Defaults per mode ("Start line", "Add to line", "Swap them"); a step-through appends "· next ▶". */
  confirmLabel?: string;
  busy?: boolean;
  error?: string | null;
  /** The incoming card's label: "Moving in" on the Move sheet (default), "New · this haul" on the Haul Plan. */
  incomingLabel?: string;
  /** "Add to that line" on an existing line: the screen reloads the model for that proposal. */
  onSwitch?(proposal: LineProposal): void;
  /**
   * The band row (the Move sheet): the bands she can pick, and the screen's handler, which reloads the model for
   * that band (an open slot for this card there makes it an Add). Absent where the band is already decided.
   */
  bands?: readonly { key: string; display: string }[];
  onBand?(band: string): void;
  /**
   * A replace: the choices for where a card goes (the same as the Move sheet's). ONE prop for both pickers: the card
   * coming out on Swap, and the incoming card on Keep when `keepDestination` is set too.
   */
  moveOptions?: MoveOptions;
  /** A replace, on Keep: offer the picker for the incoming card, pre-set here (a holo kept out of a line: bulk). */
  keepDestination?: MoveDestination;
  /** A replace, on Keep: the screen's words for where the incoming card goes ("… KB-003 · Front · Red, same as today"). */
  keepLabel?: string;
  /**
   * A replace, on Keep, when the incoming card goes to a place the screen has already decided (the Haul Plan's extra
   * copy: today's front half), with no picker: "Shelve · <card> from this haul → <keepTo>" (v3 section 5's Keep).
   */
  keepTo?: string;
  /** A replace: "Another line…" for the card coming out; absent, that choice is greyed. */
  outgoingLineModel?(proposal: LineProposal): Promise<LinePopupModel>;
  /**
   * An Add whose card is another colour than the line (UIL-069, v3 section 5's two-option pattern, UX Dev + Senior
   * BA). Neither option is picked at first and Confirm waits for one; "What moves", the Confirm label and the
   * incoming slot's tag follow the pick. Absent: today's Add.
   */
  colourChoice?: LinePopupColourChoice;
}

/** UIL-069 inside the popup: add to the line in ITS colour, or file the card by its own colour, not in a line. */
export interface LinePopupColourChoice {
  cardBand: { key: string; display: string };
  lineBand: { key: string; display: string };
  /** The screen's sub-lines: "takes the line's colour · KB-004 · Back · Green, into its Stage 1 slot". */
  addSub: string;
  /** "KB-001 · Front · Red · not in a line". */
  ownSub: string;
  /** Controlled; null until she picks. */
  picked: "line" | "own" | null;
  onPick(pick: "line" | "own"): void;
  /** Her confirm on "own": the screen's front-half write, not a LineChoice (the popup's onConfirm is not called). */
  onConfirmOwn(): void;
}

/* --------------------------------------- small shared rules --------------------------------------- */

/** "Stage 1" for the engine's "Stage1"; "Basic" stays "Basic". */
export function stageLabel(stage: string): string {
  return stage === "Stage1" ? "Stage 1" : stage === "Stage2" ? "Stage 2" : stage;
}

/** A line and the stage a card would leave empty, for "· leaves the CHARMANDER LINE one short (its Basic goes empty)". */
export interface LeavesLine {
  lineName: string;
  stage: string;
}

/** The warning, in one place, for the line popup's pulls and the Move sheet (UIL-061). */
export function leavesLineText(l: LeavesLine): string {
  return `leaves the ${l.lineName} one short (its ${l.stage} goes empty)`;
}

/** Where a card still in her haul is, in her words: produced by the popup's loaders, read by the popup itself. */
export const IN_THE_HAUL = "Still in the haul";

/**
 * A line's status from the slots it holds (UIL-121, Karvi: "only 2 stages: open or closed"): CLOSED when every slot
 * is filled, else OPEN. Nothing is capped for her any more; `_capped` is accepted and ignored until the engine stops
 * reporting it. 0030's assert_line_slots enforces the same: every slot filled ⇒ closed. The one derivation every
 * line writer uses.
 */
export function lineStatusFor(slotStates: readonly string[], _capped = false): "open" | "closed" {
  void _capped;
  return slotStates.length > 0 && slotStates.every((s) => s === "filled") ? "closed" : "open";
}

/**
 * Whether a stored status reads CLOSED. 'complete' and 'terminated' are pre-0030 words for it, still written by the
 * writers that have not moved yet; 'capped' reads open. Every reader asks this rather than comparing strings.
 */
export function lineReadsClosed(status: string | null | undefined): boolean {
  return status === "closed" || status === "complete" || status === "terminated";
}

/**
 * A line's status from her stage choices (UIL-121, the Senior BA's Q1 ruling): CLOSED when no stage waits, that is,
 * every slot holds a card, was left empty, or holds a filler. A chased stage keeps it OPEN, and so does a stage she has
 * not decided yet. Every line writer that knows the choices derives the status here, never from the browser.
 */
export function lineStatusOf(
  stages: readonly { state: string; stageChoice?: string | null }[],
): "open" | "closed" {
  const settled = (s: { state: string; stageChoice?: string | null }) =>
    s.state === "filled" || s.stageChoice === "empty" || s.stageChoice === "filler";
  return stages.length > 0 && stages.every(settled) ? "closed" : "open";
}

/** The one word a screen shows for a line's status (Lines, Lookup): OPEN or CLOSED, whatever word is stored. */
export function lineStatusShown(status: string | null | undefined): "open" | "closed" {
  return lineReadsClosed(status) ? "closed" : "open";
}

/** The choice a proposal opens on: nothing is ever pre-ticked, and Keep is the default for a replace. */
export function defaultChoiceFor(proposal: LineProposal): LineChoice {
  switch (proposal.kind) {
    case "start":
      return {
        mode: "start",
        binderId: proposal.binderId ?? "",
        band: proposal.band,
        pulls: [],
        stages: {},
      };
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
