import type { BlockNeedCandidate } from "@/lib/line/types";
/**
 * Client/server shared shapes for the plan screen (dev-spec §5 M6). No directive — safe to import
 * from both the server actions and the client screen; contains only serializable data types.
 */

import type { CardCategory, Variant } from "@/lib/engine";
import type { CommitCounts, PlanBandGroup } from "@/lib/plan";

export type { CommitCounts };

/** A catalog printing surfaced by the type-ahead, trimmed to what the intake UI needs. */
export interface LookupCard {
  tcgdexId: string;
  name: string;
  setId: string | null;
  setName: string | null;
  localId: string | null;
  /** Printed set total, for the full "099/182" form (UIL-077). Null when TCGdex reports none. */
  setCardCountOfficial: number | null;
  stage: string | null;
  types: string[];
  /**
   * The engine's own reading of what kind of card this is (UIL-080). `catalog_card` stores neither
   * TCGdex `category` nor `trainerType`; `toCatalogCard` derives them, and they ride here so a screen
   * can call the canonical `band()` on a LookupCard instead of re-deriving a band from `types` alone —
   * which for a Trainer or Energy card is a DIFFERENT answer whenever the type→band map says so.
   */
  category: CardCategory;
  trainerType: string | null;
  cardClass: "standard" | "specialty";
  imageUrl: string | null;
  /** Which physical variants this printing exists in (the selector's choices). */
  variants: Variant[];
}

/** A copy waiting in her haul, as the plan screen works it. */
export interface DraftCard {
  /** The draft id — the copy id, stable across reloads — and the incoming id through the cascade. */
  id: string;
  card: LookupCard;
  variant: Variant;
  /**
   * The copy her Dex import created, which the commit PLACES (UIL-003). Required since UIL-098 part 2:
   * the Plan no longer takes in a hand-typed card, because a copy made anywhere but the import is a twin
   * the next import cannot see. Its variant is Dex-owned and read-only here (sync-architecture §1.1).
   */
  existingCopyId: string;
  /** Raw Dex variant string, shown as the row's variant. */
  dexVariantRaw?: string | null;
}

/** What `runHaulPlan` returns for rendering. */
export interface RunPlanResult {
  groups: PlanBandGroup[];
  /** UIL-030: open binder-block needs, for the Move panel when an item is offered as a block. */
  blockNeeds?: BlockNeedCandidate[];
  /** Per-band card counts, in rainbow order — drives the band headers (incl. empty bands). */
  bands: { key: string; count: number }[];
  summary: { total: number; decisions: number; byAction: Record<string, number> };
}

/** One draft entry as it crosses the client → server boundary. */
export interface DraftPayloadItem {
  id: string;
  tcgdexId: string;
  variant: Variant;
  /** The copy waiting in her haul (UIL-003). Required: the server refuses a row without one (UIL-098). */
  existingCopyId: string;
}
