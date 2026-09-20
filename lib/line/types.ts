/**
 * M7 line-detail + decision-card + move-panel view-model types (dev-spec §5 M7; system-design §6,
 * §8 screens 2 + 6; design/prototype.html scr-line + decision overlay + move overlay).
 *
 * These are I/O-free shapes shared between the pure builders (`view.ts`, `decisions.ts`, `move.ts`),
 * the server actions, the client screen, and the tests. The engine (`lib/engine`) stays the
 * authority on placement; this layer only *presents* persisted line state and *translates* a
 * user's confirm/override/move back into repo writes.
 */

import type { LineStatus, Role, SlotState } from "@/lib/engine";

/* ------------------------------- line detail ------------------------------- */

/** A card's display identity — enough for a `CardFace` thumbnail + full collector number. */
export interface CardIdentity {
  tcgdexId: string;
  name: string;
  setId: string | null;
  setName: string | null;
  /** The full printed collector number, stored EXACTLY as TCGdex returns it (no zero-pad). */
  localId: string | null;
  /**
   * Printed set total, for the full "099/182" form (UIL-077). Optional: null when TCGdex reports none,
   * absent only where a caller predates it — `formatCollectorNumber` falls back to the bare number.
   */
  setCardCountOfficial?: number | null;
  imageUrl: string | null;
  bandKey: string;
}

/** A ranked cheaper-first alternate printing for a placeholder (system-design §6 alternates). */
export interface AlternateView {
  tcgdexId: string;
  name: string;
  localId: string | null;
  /** Printed set total for the full "099/182" form (UIL-077); null when TCGdex reports none. */
  setCardCountOfficial?: number | null;
  priceMarket: number | null;
}

/** One stage of a line as an object on the strip — filled card / hunting sticky-note / dead block. */
export interface SlotView {
  slotId: string;
  stageIndex: number;
  /** "Basic" | "Stage1" | "Stage2" | … */
  stage: string;
  state: SlotState;
  /** Filled: the owned copy's card. Placeholder: the wishlist target. Block: the species (name only). */
  card: CardIdentity | null;
  /** Filled copies only — the physical card that can be moved. */
  copyId: string | null;
  variant: string | null;
  /** Placeholder: market price of the chosen target (for the restless "$x.xx" line). */
  priceMarket: number | null;
  /** Placeholder: only specialty printings exist → this stage lives in the specialty binder (cap). */
  willLiveInSpecialty: boolean;
  /** Placeholder: ranked cheaper-first alternates. */
  alternates: AlternateView[];
  note: string | null;
  /** Block: the wedge (repurposed duplicate) card label, or the "no page" note for a terminated line. */
  wedgeLabel: string | null;
  /** Filled + shelved copy → offer the move panel (placement override on ALL cards). */
  moveable: boolean;
}

export interface LineInfoBox {
  k: string;
  v: string;
}

/** The whole line as the emotional-center strip (scr-line). */
export interface LineView {
  lineId: string;
  rootDexId: number;
  /** e.g. "CHARMANDER LINE". */
  speciesLabel: string;
  bandKey: string;
  /** The binder holding the line's back half (seeds the move panel); null if unassigned. */
  binderId: string | null;
  /** e.g. "BINDER 1 · BACK". */
  binderLabel: string;
  status: LineStatus;
  counts: { filled: number; placeholder: number; block: number };
  slots: SlotView[];
  /** The torn-corner cap plate shown after the last slot when the line is capped. */
  cap: { targetLabel: string; note: string } | null;
  info: LineInfoBox[];
}

/* ------------------------------ decision cards ----------------------------- */

/** The confirm-or-override moments (system-design §6, §7B step 4; design decision overlay). */
export type DecisionKind =
  "ex-only-cap" | "root-block" | "block" | "termination" | "collection-vs-line" | "holo-swap";

/** A single ticked one-line evidence fact. `y` = yes/good, `n` = no/absent, `s` = neutral/context. */
export interface EvidenceRow {
  mark: "y" | "n" | "s";
  text: string;
}

/** A wishlist candidate shown with its art so a printing can be chosen before it is bought. */
export interface WishlistOption {
  tcgdexId: string;
  name: string;
  localId: string | null;
  /** Printed set total for the full "099/182" form (UIL-077); null when TCGdex reports none. */
  setCardCountOfficial?: number | null;
  setId: string | null;
  imageUrl: string | null;
  bandKey: string;
  priceMarket: number | null;
  badge?: string;
  willLiveInSpecialty: boolean;
}

/** One proposal the collector can pick. `recommended` marks the system's proposal (never auto-applied). */
export interface DecisionChoice {
  id: DecisionChoiceId;
  label: string;
  description: string;
  recommended?: boolean;
}

/**
 * The choices a decision offers, stable across kinds so the resolver is a total switch. Each maps
 * to a concrete set of repo writes in `resolveDecisionWrites`.
 */
export type DecisionChoiceId =
  | "confirm-cap"
  | "cap-no-wishlist"
  | "block-instead"
  | "confirm-root-block"
  | "root-block-no-wishlist"
  | "no-line"
  | "confirm-termination"
  | "make-line-anyway"
  | "collection-wins"
  | "collection-wins-no-target"
  | "leave-it";

/** A fully-assembled decision card view-model (design/prototype.html `DECS`). Pure data. */
export interface DecisionCard {
  /** Stable id, e.g. `${lineId}:${kind}:${stageIndex}`. */
  id: string;
  kind: DecisionKind;
  lineId: string | null;
  /** The slot the decision is about (cap/block/root-block), or null (termination/holo-swap). */
  slotStageIndex: number | null;
  /** Kind heading, e.g. "LINE CAP · EX-ONLY COMPLETION". */
  title: string;
  question: string;
  /** The card the question is about, shown rather than named. */
  card: CardIdentity | null;
  catalog: EvidenceRow[];
  owned: EvidenceRow[];
  why: string[];
  /** The proposed action, stated once. */
  proposal: string;
  /**
   * UIL-067: what PHYSICALLY happens to this copy if she confirms — which of the collection or the line
   * ends up with it, or that nothing is placed and the slot stays a placeholder / becomes a block. The one
   * fact the card never surfaced plainly; stated as its own line, above the choices.
   */
  outcome?: string;
  wishlist: WishlistOption[];
  choices: DecisionChoice[];
}

/* --------------------------------- writes ---------------------------------- */

/** A copy-placement patch produced by a decision resolution or a move (columns on `copy`). */
export interface CopyPlacementPatch {
  role: Role;
  binder_id: string | null;
  binder_half: "front" | "back" | null;
  color_band: string | null;
  line_slot_id: string | null;
}

/** A slot-state patch (filled → placeholder on removal, placeholder → block on override, …). */
export interface SlotPatch {
  slotId: string;
  state?: SlotState;
  copyId?: string | null;
  targetCatalogCardId?: string | null;
  note?: string | null;
  /**
   * The behavioural "she already answered this" marker (UIL-078) — set together, on the branches
   * that resolve a decision by accepting/adjusting its recommendation rather than handing off to a
   * different one. `deriveDecisions` checks `resolvedDecisionKind` against its own kind before
   * re-deriving; `resolvedDecisionChoice` rides along for the same precision but is not itself
   * checked. Lives on the slot deliberately, not on the `PlacementDecision` audit row — see
   * `lib/line/decisions.ts`'s header for why (UIL-042: an audit table must never be load-bearing for
   * behaviour a second time).
   */
  resolvedDecisionKind?: string | null;
  resolvedDecisionChoice?: string | null;
  /** The collection whose claim a `collection-vs-line` answer was about; null for other kinds. */
  resolvedDecisionCollectionId?: string | null;
}

/** A wishlist upsert keyed by slot: create/refresh the hunt for a stage. */
export interface WishlistUpsert {
  lineSlotId: string;
  requiredDexId: number | null;
  requiredType: string | null;
  requiredStage: string | null;
  chosenCatalogCardId: string | null;
  alternateCatalogCardIds: string[];
  willLiveInSpecialty: boolean;
}

/**
 * The complete set of repo writes a chosen decision implies — computed purely, applied by the I/O
 * layer. `decision` is the audit row (`PlacementDecision`, `resolved_by: 'user'`; dev-spec §4).
 */
export interface DecisionWrites {
  linePatch?: { status?: LineStatus };
  slotPatches: SlotPatch[];
  wishlistUpserts: WishlistUpsert[];
  /** Slot ids whose open wishlist items should be marked resolved (target dropped). */
  wishlistResolveSlotIds: string[];
  decision: { decision: string; reason: string };
}

/* ---------------------------------- move ----------------------------------- */

/**
 * The back half IS the lines area (UIL-056): a shelf destination whose half is `"back"` must resolve
 * to a line, or the card strands there exactly as `line_slot_id: null` always used to leave it. Join
 * an existing line's open slot, or start a new one. Deliberately allowed even when the engine's own
 * viability rule (>= 2 same-colour chain members) is not met — Karvi's own UX tip was "the user must
 * pick which card it is entering a line with," not "only when the engine would have made one itself";
 * gating manual creation on viability would strand her at a decision she cannot satisfy from a single
 * card. Absent entirely for a `"front"` half — no line concept applies there.
 */
export type LineJoinChoice = { mode: "existing"; lineId: string; slotId: string } | { mode: "new" };

/** Where a moved card lands (binder + half + band, into a collection, or the bulk box). */
export type MoveDestination =
  | {
      kind: "shelf";
      binderId: string;
      half: "front" | "back";
      band: string;
      lineJoin?: LineJoinChoice;
    }
  | { kind: "collection"; binderId: string; collectionId: string }
  | { kind: "bulk" }
  /**
   * UIL-030: use the card as the physical BINDER BLOCK for a line's block slot — a reserved run of
   * pockets the engine decided can never be filled. The copy takes role 'block' in the line's binder
   * back half and a `binder_block` row (line-terminated, repurposedDuplicate) is written with it, so the
   * open need closes and the duplicate's location is tracked.
   */
  | { kind: "block"; lineId: string; slotId: string; binderId: string };

/**
 * An OPEN binder-block need (UIL-030): a line_slot in state 'block' with no line-terminated binder_block
 * backing it yet. Computed server-side in lib/plan/context.ts; the Move panel lists these when a
 * bulk-bound duplicate is offered as a repurposed block.
 */
export interface BlockNeedCandidate {
  lineId: string;
  slotId: string;
  binderId: string;
  binderName: string;
  speciesLabel: string;
  stage: string;
  bandKey: string;
}

/** A move request from any surface that shows a card (plan spotlight, line slot, lookup). */
export interface MoveRequest {
  copyId: string;
  destination: MoveDestination;
}

/** Options the move panel offers — driven from the DB so a new binder/collection shows up at once. */
export interface MoveOptions {
  binders: { id: string; name: string; type: "general" | "specialty" }[];
  collectionsByBinder: Record<string, { id: string; name: string }[]>;
  bands: { key: string; display: string }[];
}

/**
 * An existing line this specific card could join — one open (placeholder/block) slot whose species
 * matches the card's own dexId, keyed by the line's band so the picker can filter as she changes the
 * band chip. Computed server-side (UIL-056) from lines already loaded for the screen; absent when no
 * line anywhere has a fitting open slot, in which case only "start a new line" is offered.
 *
 * `filledCount`/`totalCount` exist so two candidates with the same `speciesLabel` (same root species,
 * genuinely possible if the same (root, band) pair were ever duplicated) don't read as identical —
 * without them she would be picking blind between two otherwise-indistinguishable rows (UIL-001's
 * "no indication what it means" shape).
 */
export interface LineJoinCandidate {
  lineId: string;
  slotId: string;
  /** The line's own binder (UIL-064 part 1) — picking a candidate derives the destination binder
   *  from ITS line rather than asking her to pick one first. */
  binderId: string | null;
  bandKey: string;
  speciesLabel: string;
  stage: string;
  filledCount: number;
  totalCount: number;
}

/**
 * A line already exists for this card's species (chain root) in this band, but not as an open join
 * candidate — its matching slot is already filled (a duplicate copy of a stage already owned). The
 * cascade's own rule for this shape is "lines tracked once" (an extra copy of a filled stage does
 * NOT get a second line); this is that same rule surfacing on the manual path, so "start a new line"
 * is offered anyway (her call), but explained rather than left to read as an empty, broken list.
 */
export interface ExistingLineBlock {
  speciesLabel: string;
  filledCount: number;
  totalCount: number;
}

/** The client-facing line-screen payload (loaded server-side, rendered client-side). */
/** How the Lines screen orders its strips (UIL-074): colour + A–Z (default) or grouped by binder. */
export type LineViewMode = "color" | "binder";

export interface LineScreenData {
  /** The order `lines` is in — echoed so the strip renders group headings only when it applies. */
  view: LineViewMode;
  /** Ordered per `view` (lib/line/order.ts). */
  lines: LineView[];
  decisions: DecisionCard[];
  moveOptions: MoveOptions;
  /** Shelved copies with no line slot, offered a way in (UIL-056) — see `unlinedCards`. */
  unlinedCards: UnlinedCard[];
}

/** A shelved, line-less card shown so it has a way OFF the front half and INTO a line (UIL-056). */
export interface UnlinedCard {
  copyId: string;
  card: CardIdentity;
  currentLabel: string;
  /** This card's own dexId — fixed, used to match candidate lines' open slots. */
  dexId: number;
  /** Its CURRENT half, straight off `copy.binder_half` — a data field, not parsed out of
   *  `currentLabel` (UIL-064 part 3's "stranded in the back half" split keys off this). */
  binderHalf: "front" | "back" | null;
  /** This card's own type-derived band (`lib/engine` `band()`, same derivation the cascade uses) —
   *  the sane default for "start a new line"'s one remaining band pick (UIL-064 part 1), regardless
   *  of which band it happens to be shelved under right now. */
  naturalBandKey: string;
  /**
   * Existing lines this card could join, across every band, flat and sorted closest-to-complete
   * first (UIL-064 part 1) — each candidate already carries its own `bandKey` and `binderId`, so
   * picking one derives the whole destination instead of requiring band to be picked first. The
   * band-keyed `Record` this replaced was itself the reason a band had to be chosen before any line
   * ever appeared.
   */
  joinCandidates: LineJoinCandidate[];
  /** Set for a band with no open candidate BECAUSE a line for this family already exists there
   *  (see `ExistingLineBlock`) — absent, not just empty, when no line exists there at all. */
  existingLineByBand: Record<string, ExistingLineBlock>;
}
