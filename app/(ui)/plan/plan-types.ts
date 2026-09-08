/**
 * Client/server shared shapes for the plan screen (dev-spec §5 M6). No directive — safe to import
 * from both the server actions and the client screen; contains only serializable data types.
 */

import type { Variant } from "@/lib/engine";
import type { PlanBandGroup } from "@/lib/plan";

/** A catalog printing surfaced by the type-ahead, trimmed to what the intake UI needs. */
export interface LookupCard {
  tcgdexId: string;
  name: string;
  setId: string | null;
  setName: string | null;
  localId: string | null;
  stage: string | null;
  types: string[];
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
}

/** What `runHaulPlan` returns for rendering. */
export interface RunPlanResult {
  groups: PlanBandGroup[];
  /** Per-band card counts, in rainbow order — drives the band headers (incl. empty bands). */
  bands: { key: string; count: number }[];
  summary: { total: number; decisions: number; byAction: Record<string, number> };
}

export interface CommitCounts {
  copies: number;
  lines: number;
  slots: number;
  wishlist: number;
  decisions: number;
}

/** Argument to the commit server action. */
export interface CommitActionInput {
  source: "bulk-bin" | "pack-rip" | "show" | "trade";
  notes?: string | null;
  draft: { id: string; tcgdexId: string; variant: Variant }[];
}
