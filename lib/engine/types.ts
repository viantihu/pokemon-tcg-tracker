/**
 * M3 placement engine — shared domain types.
 *
 * These mirror the domain model in `docs/system-design.md` §4 in camelCase. The engine is a set of
 * PURE functions: catalog/copy records go in, placement decisions come out. It performs no I/O — no
 * Supabase, no fetch, no `Date.now()`. Clocks and market prices are injected (see `EngineContext`).
 *
 * The engine deliberately does NOT import from `lib/repo/*` (DB row shapes) or `lib/catalog/*`
 * (network client). Callers translate between DB rows and these types.
 */

/** M2-derived class. Specialty = ex/V/VMAX/VSTAR/GX/Radiant/Prime/full art/illustration rare/gold. */
export type CardClass = "standard" | "specialty";

/** Physical printing variant (system-design §4 `variants`). */
export type Variant = "normal" | "holo" | "reverse" | "firstEdition" | "wPromo";

/** Where a physical copy currently lives (system-design §4 `Copy.role`). */
export type Role = "shelved" | "bulk" | "block";

/** General binders have two halves; specialty binders are treated as a single section. */
export type BinderHalf = "front" | "back";

export type BinderType = "general" | "specialty";

/** Evolution line lifecycle (system-design §4 `EvolutionLine.status`). */
export type LineStatus = "open" | "capped" | "complete" | "terminated";

/** Per-stage slot state (system-design §4 `LineSlot.state`). */
export type SlotState = "filled" | "placeholder" | "block";

/** TCGdex card category. Pokémon carry `types`; Trainers/Energy do not. */
export type CardCategory = "Pokemon" | "Trainer" | "Energy";

/** TCGdex variant availability flags, mirrored from the catalog. */
export interface CardVariants {
  normal: boolean;
  holo: boolean;
  reverse: boolean;
  firstEdition: boolean;
  wPromo: boolean;
}

/**
 * A catalog printing (system-design §4 `CatalogCard`). `cardClass`, `artworkGroupId` and
 * `isDigitalOnly` are M2-derived and arrive already populated. Ids are stored EXACTLY as TCGdex
 * returns them (no zero-pad normalization).
 */
export interface CatalogCard {
  tcgdexId: string;
  name: string;
  /** Species key(s). `dexId` is the species key, never the name (system-design §4). Trainers: []. */
  dexId: number[];
  setId: string | null;
  setName?: string | null;
  localId: string | null;
  /**
   * The printed set total — the `/182` in "099/182" (UIL-077). Nullable because TCGdex does not report
   * an official count for every set; `formatCollectorNumber` renders the bare number when it is absent.
   */
  setCardCountOfficial?: number | null;
  rarity: string | null;
  /** Pokémon energy types (usually one). Trainers/Energy: empty. */
  types: string[];
  /** "Basic" | "Stage1" | "Stage2" | "VMAX" | ... — null for Trainer/Energy. */
  stage: string | null;
  /** Previous-stage species NAME (TCGdex convention), or null for a Basic / non-Pokémon. */
  evolveFrom: string | null;
  illustrator: string | null;
  hp?: number | null;
  variants: CardVariants;
  /** M2-derived perceptual-hash cluster; holo + reverse of one printing share a group. */
  artworkGroupId: string | null;
  cardClass: CardClass;
  isDigitalOnly: boolean;
  priceLow?: number | null;
  /** Market price (TCGplayer/Cardmarket via the mirror). Used to rank alternates ascending. */
  priceMarket: number | null;
  /** Present for Trainers/Energy so bands can route them to White. */
  category?: CardCategory;
  /** "Supporter" | "Item" | "Stadium" | "Tool" for Trainers. */
  trainerType?: string | null;
}

/** A physical card already owned, with its catalog record resolved. */
export interface OwnedCopy {
  id: string;
  card: CatalogCard;
  variant: Variant;
  role: Role;
  binderId: string | null;
  binderHalf: BinderHalf | null;
  colorBand: string | null;
  lineSlotId: string | null;
}

/** The card being routed through the cascade (not yet placed). */
export interface IncomingCard {
  /** Temp/haul copy id, used only for the audit reason and result correlation. */
  id: string;
  card: CatalogCard;
  variant: Variant;
}

export interface Binder {
  id: string;
  name: string;
  type: BinderType;
  isActive: boolean;
  /** Optional capacity hints for front-half band suggestion; omit for "unknown". */
  freeFrontHalfByBand?: Record<string, number>;
  /** Optional free back-half pocket count, used for new-line binder assignment (decision §3). */
  freeBackHalf?: number;
}

/** An ordered stage of an existing evolution line (system-design §4 `LineSlot`). */
export interface LineSlotRecord {
  id: string;
  stageIndex: number;
  stage: string;
  state: SlotState;
  copyId: string | null;
  /** Species at this slot. Lets the engine match an incoming card to the right slot by dexId. */
  dexId: number | null;
  targetCatalogCardId: string | null;
}

export interface EvolutionLine {
  id: string;
  rootDexId: number;
  colorBand: string;
  binderId: string | null;
  status: LineStatus;
  slots: LineSlotRecord[];
}

/** A running custom set. Collection membership beats every other cascade rule (system-design §3). */
export interface Collection {
  id: string;
  name: string;
  /** Specialty binder(s) currently holding the collection. */
  currentBinderIds: string[];
  /** Catalog cards claimed by the collection. */
  targetCatalogCardIds: string[];
}

/** Energy-type → band. Confirmed table in system-design §4. */
export type TypeColorMap = Record<string, string>;
