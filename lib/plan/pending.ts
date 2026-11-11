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
import type { PlanItem } from "./types";
import {
  catalogCardRepo,
  copyRepo,
  placementDecisionRepo,
  type DbClient,
  type Row,
} from "@/lib/repo";
import { BULK_PULL_DECISION } from "@/lib/sync/removal-source";

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
 *
 * `except` (UIL-114): copies the caller already holds, left out BEFORE the catalog is read. The Haul Plan
 * asks this every 30 s for cards that arrived while it was open, and almost always the answer is none, so
 * then the check reads her unplaced copies and nothing else: no decision lookup, no catalog join.
 */
export async function loadPendingPlacements(
  db: DbClient,
  opts: { except?: ReadonlySet<string> } = {},
): Promise<PendingPlacement[]> {
  const except = opts.except;
  const unplaced = (await copyRepo.listUnplaced(db)).filter((c) => !except?.has(c.id));
  if (unplaced.length === 0) return [];

  /**
   * Pending = no decision yet, OR the latest decision is a pull from bulk (Karvi, 2026-11-11): a bulk copy she
   * asked the Sync page to pull back into her haul has an older decision (the one that sent it to bulk) and a
   * newer one that pulled it out. Only the latest says where it stands. Any other latest decision keeps the copy
   * out of the queue exactly as before, so no card that was out of the queue comes back into it.
   */
  const latest = await placementDecisionRepo.listLatestByCopy(
    db,
    unplaced.map((c) => c.id),
  );
  const pending = unplaced.filter((c) => {
    const d = latest.get(c.id);
    return !d || d.decision === BULK_PULL_DECISION;
  });
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

/**
 * The plan's reason for a card pulled out of a bulk box (Karvi, 2026-11-11): the pull's note, ahead of the
 * cascade's own reason. The row is otherwise an ordinary plan row — same action, same destination, same layout —
 * so the Haul Plan gains no new kind of row. PURE; the reason is display text and never part of the placement
 * digest (lib/plan/spotlight.ts), so this cannot change where the card is written.
 */
export function withBulkPullNotes<T extends { items: PlanItem[] }>(
  plan: T,
  latest: ReadonlyMap<string, { decision: string; reason: string }>,
): T {
  return {
    ...plan,
    items: plan.items.map((it) => {
      const d = latest.get(it.incomingId);
      return d && d.decision === BULK_PULL_DECISION
        ? { ...it, reason: `${d.reason} ${it.reason}` }
        : it;
    }),
  };
}
