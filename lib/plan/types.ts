/**
 * M6 haul-intake + placement-plan types (dev-spec §5 M6; system-design §5, §7B).
 *
 * The plan is the deliverable: the M3 cascade run over a whole haul, then GROUPED to mirror the
 * physical sort — colour band in rainbow order, basics vs non-basics within the band, then action.
 * That grouping is functional (worked top-to-bottom in the same order the cards are stacked), not
 * cosmetic, so it lives in pure, unit-tested code (`group.ts`) alongside these shapes.
 *
 * These types are I/O-free and shared between the server actions, the client screen, and the tests.
 */

import type { CascadeResult, Variant } from "@/lib/engine";

/**
 * The seven worklist actions, mirroring the prototype's `ACT` set (design/prototype.html). The row
 * order inside a band sub-group is this array's order (`ACTION_ORDER`).
 */
export type PlanActionKind = "PULL" | "FILL" | "NEWLINE" | "SWAP" | "SPEC" | "FRONT" | "BULK";

/** One incoming card after the cascade, flattened for display + grouping. Pure data. */
export interface PlanItem {
  /** Draft/haul id of the incoming card — correlates back to the cascade result at commit. */
  incomingId: string;
  tcgdexId: string;
  name: string;
  setId: string | null;
  localId: string | null;
  variant: Variant;
  /** TCGdex stage ("Basic" | "Stage1" | "Stage2" | …) or null for a Trainer/Energy. */
  stage: string | null;
  /** Physical sort split: Basics come before non-basics within a band. */
  isBasic: boolean;
  /** DB colour-band key (e.g. "red", "dark_blue") — the engine runs in DB-key space (see adapt.ts). */
  bandKey: string;
  action: PlanActionKind;
  /** Human destination string, e.g. "BINDER 1 · BACK · RED". Cosmetic; not used for grouping. */
  destination: string;
  reason: string;
  /** True when the cascade emitted proposals (cap / block / termination / swap / collection-vs-line). */
  needsDecision: boolean;
}

/** A planned card paired with its full cascade result — the commit input (not sent to the client). */
export interface PlannedCard {
  incomingId: string;
  tcgdexId: string;
  variant: Variant;
  /**
   * An existing unplaced `copy.id` this entry ROUTES rather than creates (UIL-003; see
   * lib/plan/pending.ts). Null for ordinary typed intake.
   */
  existingCopyId?: string | null;
  result: CascadeResult;
}

/** A basics or non-basics run inside a band, rows already action-ordered. */
export interface PlanSubgroup {
  kind: "basic" | "nonbasic";
  label: string;
  rows: PlanItem[];
}

/** One band's slice of the plan — present even at zero cards so its rainbow slot is reserved. */
export interface PlanBandGroup {
  bandKey: string;
  count: number;
  subgroups: PlanSubgroup[];
}
