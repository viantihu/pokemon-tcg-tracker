/**
 * The pending-placement queue: copies that exist but have never been routed (UIL-003).
 *
 * WHY THIS EXISTS. Sync deliberately creates new copies UNPLACED and hands them to the routing
 * cascade (sync-architecture §1.1 "create — a genuinely new copy lands unplaced in the routing
 * cascade"; lib/sync/exec.ts step 3), and sync-ui-spec §B.6 requires a "Place-now handoff … so
 * 'added' doesn't dead-end in a list". The Haul Plan is that destination, but it had no way to read
 * existing copies — it only ever built new ones from typed entry. This module is the read half; the
 * write half is `commitCardPlacement`'s existing-copy branch (shared with `buildHaulCommitPayload`,
 * which both the per-card and — formerly — the whole-haul commit built on), which ROUTES those copy
 * rows instead of inserting duplicates of them.
 *
 * WHAT COUNTS AS PENDING. A copy with no placement at all (`role: 'bulk'`, no binder, no line slot)
 * AND no `placement_decision` row. The decision row is the discriminator, and it has to be: the
 * cascade can legitimately route a card TO bulk (duplicate, system-design §5 step 3), which leaves
 * exactly the same placement columns as an untouched sync add. What separates them is that a routed
 * copy has an audit row and an unrouted one does not. That also makes the queue self-clearing —
 * committing a placement writes the decision, so the card leaves the queue whatever its destination.
 *
 * I/O lives here; the plan/commit logic it feeds stays pure.
 */

import type { Variant } from "@/lib/engine";
import {
  catalogCardRepo,
  copyRepo,
  placementDecisionRepo,
  type DbClient,
  type Row,
} from "@/lib/repo";

/** One unrouted copy, paired with the catalog printing it is a copy of. */
export interface PendingPlacement {
  /** The EXISTING `copy.id`. The commit routes this row; it never creates another. */
  copyId: string;
  tcgdexId: string;
  variant: Variant;
  /** Raw Dex variant string when the copy came from a sync — display only, never re-derived here. */
  dexVariantRaw: string | null;
  /** When the copy entered the collection (sync stamps this), oldest first. */
  acquiredAt: string | null;
  card: Row<"catalog_card">;
}

/**
 * Every copy waiting to be placed, oldest first. Skips a copy whose catalog row has since vanished
 * from the mirror (the FK is `on delete restrict`, so this is defensive only) rather than surfacing a
 * card the plan could not describe.
 *
 * `placement_decision` IS QUEUE STATE, NOT ONLY AN AUDIT LOG (UIL-042). "Pending" is defined by the
 * ABSENCE of a decision row: an unplaced copy with no row is "still waiting", and the only thing that
 * takes it out of this queue is a decision row being written by a commit. So deleting or pruning
 * `placement_decision` rows does not tidy history — it re-queues every affected card as if it had never
 * been placed, which is exactly what happened when 702 rows were cleared by hand on Testing
 * (2026-09-14). There is deliberately no separate "pending" flag to keep in step with this: the row is
 * the flag. Never clear that table; never archive it out of the live database.
 */
export async function loadPendingPlacements(db: DbClient): Promise<PendingPlacement[]> {
  const unplaced = await copyRepo.listUnplaced(db);
  if (unplaced.length === 0) return [];

  const decided = await placementDecisionRepo.listDecidedCopyIds(
    db,
    unplaced.map((c) => c.id),
  );
  const pending = unplaced.filter((c) => !decided.has(c.id));
  if (pending.length === 0) return [];

  const cards = await catalogCardRepo.listByIds(
    db,
    pending.map((c) => c.catalog_card_id),
  );
  const cardById = new Map(cards.map((c) => [c.tcgdex_id, c]));

  const out: PendingPlacement[] = [];
  for (const c of pending) {
    const card = cardById.get(c.catalog_card_id);
    if (!card) continue;
    out.push({
      copyId: c.id,
      tcgdexId: c.catalog_card_id,
      variant: (c.variant as Variant) ?? "normal",
      dexVariantRaw: c.dex_variant_raw,
      acquiredAt: c.acquired_at,
      card,
    });
  }
  return out;
}
