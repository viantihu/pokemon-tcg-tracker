/**
 * M5 backfill — shared shapes (dev-spec §5 M5; system-design §7A).
 *
 * Backfill loads the EXISTING physical collection through the app, re-runnable per binder. Unlike
 * haul intake (M6), placement is not computed by the cascade — the collector is transcribing what
 * is already on the shelf, so each destination is explicit. The one thing that stays automatic is
 * the colour band, derived from card type (system-design §7A: "she never types it").
 *
 * These types are I/O-free and shared between the pure planners (`plan.ts`), the resolver
 * (`resolve.ts`), the commit executors (`commit.ts`), the server actions, and the tests.
 */

import type { SlotState, Variant } from "@/lib/engine";
import type { Insert } from "@/lib/repo";

/* --------------------------------- context -------------------------------- */

/** A binder the collector can backfill into. */
export interface BackfillBinder {
  id: string;
  name: string;
  type: "general" | "specialty";
  isActive: boolean;
}

/** A running collection a specialty card can be tagged into. */
export interface BackfillCollection {
  id: string;
  name: string;
}

/** A colour band option for the back-half "choose a colour" control (rainbow order). */
export interface BandOption {
  key: string;
  display: string;
}

/* ------------------------------- back-half line --------------------------- */

/**
 * One resolved stage of a species chain for the back-half walk. Catalog facts (does a same-colour
 * printing exist? only specialty?) come from the mirror via the reused engine helpers, so the
 * collector can mark FILLED / placeholder / block with the same evidence the cascade would use.
 */
export interface BackLineStageInfo {
  stageIndex: number;
  /** "Basic" | "Stage1" | "Stage2" | … (TCGdex verbatim). */
  stage: string;
  dexId: number;
  name: string;
  /** A same-colour standard-or-specialty printing exists for this stage → placeholder is possible. */
  sameColorPrintingExists: boolean;
  /** Only specialty-class same-colour printings exist → a placeholder here caps the line. */
  specialtyOnly: boolean;
  /** Cheapest same-colour printing — the wishlist target when this stage is a placeholder. */
  suggestedTargetId: string | null;
  /** Remaining same-colour printings, market price ascending. */
  alternateTargetIds: string[];
}

/** The resolved chain for a chosen species + colour, ready for the line form. */
export interface ResolvedBackLine {
  rootDexId: number;
  speciesName: string;
  bandKey: string;
  /** Energy type stored on wishlist items for this line (reverse-mapped from the chosen band). */
  requiredType: string | null;
  /** Stage index of the printing the collector picked to start the line (−1 if not in the chain). */
  seedStageIndex: number;
  stages: BackLineStageInfo[];
}

/* --------------------------------- commits -------------------------------- */

/** A front-half copy being transcribed (band auto-computed server-side from the card's type). */
export interface FrontHalfCard {
  tcgdexId: string;
  variant: Variant;
}

export interface FrontHalfCommit {
  binderId: string;
  half: "front" | "back";
  cards: FrontHalfCard[];
}

/** One stage's decision in the back-half line walk. */
export interface BackLineStageInput {
  stageIndex: number;
  stage: string;
  dexId: number;
  decision: SlotState; // "filled" | "placeholder" | "block"
  /** FILLED: the exact printing the collector owns + its variant. */
  filledTcgdexId?: string | null;
  filledVariant?: Variant;
  /** placeholder: wishlist target + ranked alternates + specialty-only flag. */
  targetCatalogCardId?: string | null;
  alternateCatalogCardIds?: string[];
  specialtyOnly?: boolean;
  /** block: how the pocket run was filled, and — for a repurposed duplicate — WHICH card. */
  blockMaterial?: "basicEnergy" | "repurposedDuplicate";
  blockCopyTcgdexId?: string | null;
  blockCopyVariant?: Variant;
  pocketCount?: number;
}

export interface BackLineCommit {
  binderId: string;
  bandKey: string;
  rootDexId: number;
  requiredType: string | null;
  /** When true the line is terminated: the strip is read-only and offers no fillable slot. */
  terminated: boolean;
  stages: BackLineStageInput[];
}

/** A specialty copy being transcribed, optionally tagged into one or more collections. */
export interface SpecialtyCard {
  tcgdexId: string;
  variant: Variant;
  collectionIds: string[];
}

export interface SpecialtyCommit {
  binderId: string;
  cards: SpecialtyCard[];
}

/* --------------------------------- writes --------------------------------- */

/**
 * The full set of rows a backfill step writes, with explicit ids so relationships are wired without
 * a DB round-trip and the whole thing is deterministic + unit-testable. The executor applies them in
 * FK-safe order (`copy.line_slot_id` is deferred — circular with `line_slot`, see commit.ts).
 */
export interface BackfillWrites {
  lines: Insert<"evolution_line">[];
  /** Copies are inserted with `line_slot_id` NULL; the links below patch it after slots exist. */
  copies: Insert<"copy">[];
  slots: Insert<"line_slot">[];
  blocks: Insert<"binder_block">[];
  wishlist: Insert<"wishlist_item">[];
  decisions: Insert<"placement_decision">[];
  /** copy.id → line_slot.id, applied after both rows exist (circular FK). */
  copyLineSlotLinks: { copyId: string; slotId: string }[];
  /** collection.id → catalog_card ids to union into its `target_catalog_card_ids`. */
  collectionTags: { collectionId: string; catalogCardId: string }[];
}

export interface CommitCounts {
  copies: number;
  lines: number;
  slots: number;
  blocks: number;
  wishlist: number;
  decisions: number;
}

/** Empty write set — planners start here and push. */
export function emptyWrites(): BackfillWrites {
  return {
    lines: [],
    copies: [],
    slots: [],
    blocks: [],
    wishlist: [],
    decisions: [],
    copyLineSlotLinks: [],
    collectionTags: [],
  };
}

/** Per-table counts of a write set (for the commit summary). */
export function countWrites(w: BackfillWrites): CommitCounts {
  return {
    copies: w.copies.length,
    lines: w.lines.length,
    slots: w.slots.length,
    blocks: w.blocks.length,
    wishlist: w.wishlist.length,
    decisions: w.decisions.length,
  };
}
