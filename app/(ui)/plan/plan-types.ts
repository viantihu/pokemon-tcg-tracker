/**
 * Client/server shared shapes for the plan screen (dev-spec §5 M6). No directive — safe to import
 * from both the server actions and the client screen; contains only serializable data types.
 */

import type { CardCategory, Variant } from "@/lib/engine";
import type { CommitCounts, PlanBandGroup } from "@/lib/plan";
import type { MoveDestination } from "@/lib/line/types";

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

/** A card the collector has added to the current haul draft, with the chosen variant. */
export interface DraftCard {
  /** Client-generated draft id — becomes the incoming id through the cascade. */
  id: string;
  card: LookupCard;
  variant: Variant;
  /**
   * Set when the row is an existing unplaced copy waiting to be routed rather than a new card being
   * taken in (UIL-003). The commit updates that copy's placement instead of creating another one, so
   * placing sync's additions can never double her counts. Its variant is Dex-owned and read-only
   * here (sync-architecture §1.1).
   */
  existingCopyId?: string | null;
  /** Raw Dex variant string, shown instead of the variant selector on a routed row. */
  dexVariantRaw?: string | null;
}

/** What `runHaulPlan` returns for rendering. */
export interface RunPlanResult {
  groups: PlanBandGroup[];
  /** Per-band card counts, in rainbow order — drives the band headers (incl. empty bands). */
  bands: { key: string; count: number }[];
  summary: { total: number; decisions: number; byAction: Record<string, number> };
}

/** One draft entry as it crosses the client → server boundary. */
export interface DraftPayloadItem {
  id: string;
  tcgdexId: string;
  variant: Variant;
  /** An existing unplaced copy to route (UIL-003); absent for typed intake. */
  existingCopyId?: string | null;
}

/** Argument to the commit server action. */
export interface CommitActionInput {
  source: "bulk-bin" | "pack-rip" | "show" | "trade";
  notes?: string | null;
  draft: DraftPayloadItem[];
  /** Per-draft-id placement overrides from the spotlight move panel (M7). */
  overrides?: Record<string, MoveDestination>;
}
