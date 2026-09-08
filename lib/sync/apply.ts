/**
 * Fast-path gating + preview overrides (docs/sync-ui-spec.md §B.1, §B.3). PURE — no Supabase, no
 * fetch, no Date. This is the M9 decision layer on top of M4's frozen `reconcile` plan: it decides
 * whether a sync may auto-apply, phrases the fast-path notification, and folds the two preview
 * overrides (which-copy-left, reject-a-variant-migration) back into a concrete plan the executor
 * runs. The reconcile/diff contracts (lib/sync/{reconcile,diff}.ts) are untouched.
 */
import type {
  CreateOp,
  CurrentGroup,
  CopySnapshot,
  ReconcilePlan,
  RemovalConsequence,
  RetireOp,
  VariantUpdateOp,
} from "./reconcile";
import { deriveVariantFlag } from "./reconcile";
import { presenceKey } from "./diff";

/**
 * The removal-rule mapping (sync-architecture §1.6), re-derived here for override-created retires.
 * Mirrors reconcile's private `removalConsequence` — kept in lock-step, not imported, so the frozen
 * module's surface stays closed.
 */
export function consequenceOf(c: CopySnapshot): {
  consequence: RemovalConsequence;
  needsReview: boolean;
} {
  if (c.role === "block") return { consequence: "block-review", needsReview: true };
  if (c.lineSlotId) return { consequence: "line-slot-freed", needsReview: false };
  if (c.role === "shelved" && c.binderId)
    return { consequence: "shelved-cleared", needsReview: false };
  if (c.role === "bulk") return { consequence: "bulk-removed", needsReview: false };
  return { consequence: "unplaced-removed", needsReview: false };
}

/**
 * The fast-path rule (sync-ui-spec §B.1): a sync may auto-apply iff it can ONLY add unplaced copies.
 * Any retire (`REMOVED`/`CHANGED(−)`) or variant migration could move a placement, so it gates.
 * New `UNRESOLVED` parks and self-heal promotions do not disqualify it — neither touches placement.
 */
export function requiresPreview(plan: Pick<ReconcilePlan, "retires" | "variantUpdates">): boolean {
  return plan.retires.length > 0 || plan.variantUpdates.length > 0;
}

/** Whether a plan changes anything at all — an empty plan is a true no-op (idempotent re-import). */
export function isNoop(counts: {
  creates: number;
  retires: number;
  variantUpdates: number;
  parks: number;
  drops: number;
  promotions: number;
  dedupeUpdates: number;
}): boolean {
  return (
    counts.creates === 0 &&
    counts.retires === 0 &&
    counts.variantUpdates === 0 &&
    counts.parks === 0 &&
    counts.drops === 0 &&
    counts.promotions === 0 &&
    counts.dedupeUpdates === 0
  );
}

/**
 * The non-blocking fast-path notification text (sync-ui-spec §B.1):
 * "6 new cards added · 5 waiting on catalog · tap to place."
 */
export function fastPathNotification(added: number, waiting: number): string {
  const parts: string[] = [];
  parts.push(added === 1 ? "1 new card added" : `${added} new cards added`);
  if (waiting > 0) parts.push(`${waiting} waiting on catalog`);
  parts.push("tap to place");
  return parts.join(" · ");
}

/** A migration is keyed by the card + the from→to variant pair it carries placement across. */
export function migrationKey(catalogCardId: string, from: string, to: string): string {
  return `${catalogCardId} ${from} ${to}`;
}

/**
 * The two overrides the preview allows (sync-ui-spec §B.3). Both are optional; an empty object is
 * identical to the pure reconcile plan.
 */
export interface SyncOverrides {
  /**
   * Which physical copies leave on a shrink, per presence key (`presenceKey(cardId, variantRaw)`).
   * The chosen copyIds REPLACE reconcile's least-committed default; the count must match, else the
   * override is ignored (defensive — a stale UI can't retire the wrong number of copies).
   */
  retireChoice?: Record<string, string[]>;
  /**
   * Variant migrations she rejects (`migrationKey(cardId, from, to)`). A rejected pairing splits
   * back into a true remove (removal rule) + a true add to the cascade — placement is released, not
   * carried (sync-ui-spec §B.3, §D).
   */
  rejectedMigrations?: string[];
}

/**
 * Fold the preview overrides into a concrete plan (PURE). Needs the current groups to look up the
 * copy snapshots an override names (to recompute the removal consequence and validate counts).
 * Returns a NEW plan; the input is not mutated.
 */
export function applyOverrides(
  plan: ReconcilePlan,
  current: CurrentGroup[],
  overrides: SyncOverrides | undefined,
): ReconcilePlan {
  if (!overrides || (!overrides.retireChoice && !overrides.rejectedMigrations?.length)) {
    return plan;
  }

  const copyById = new Map<string, CopySnapshot>();
  const groupByKey = new Map<string, CurrentGroup>();
  for (const g of current) {
    groupByKey.set(presenceKey(g.catalogCardId, g.dexVariantRaw), g);
    for (const c of g.copies) copyById.set(c.copyId, c);
  }

  let retires: RetireOp[] = [...plan.retires];
  let variantUpdates: VariantUpdateOp[] = [...plan.variantUpdates];
  const creates: CreateOp[] = [...plan.creates];

  // 1. Reject variant migrations → split each into a true retire + a true add.
  const rejected = new Set(overrides.rejectedMigrations ?? []);
  if (rejected.size > 0) {
    const kept: VariantUpdateOp[] = [];
    for (const vu of variantUpdates) {
      const key = migrationKey(vu.catalogCardId, vu.fromVariantRaw, vu.toVariantRaw);
      if (!rejected.has(key)) {
        kept.push(vu);
        continue;
      }
      const from = copyById.get(vu.copyId);
      const { consequence, needsReview } = from
        ? consequenceOf(from)
        : { consequence: "unplaced-removed" as RemovalConsequence, needsReview: false };
      retires.push({
        kind: "retire",
        copyId: vu.copyId,
        catalogCardId: vu.catalogCardId,
        dexVariantRaw: vu.fromVariantRaw,
        consequence,
        needsReview,
      });
      creates.push({
        kind: "create",
        catalogCardId: vu.catalogCardId,
        dexVariantRaw: vu.toVariantRaw,
        variant: deriveVariantFlag(vu.toVariantRaw),
      });
    }
    variantUpdates = kept;
  }

  // 2. Which-copy-left overrides → swap the retired copyIds for a key (count must match).
  const retireChoice = overrides.retireChoice ?? {};
  if (Object.keys(retireChoice).length > 0) {
    const byKey = new Map<string, RetireOp[]>();
    for (const r of retires) {
      const key = presenceKey(r.catalogCardId, r.dexVariantRaw);
      const list = byKey.get(key) ?? [];
      list.push(r);
      byKey.set(key, list);
    }
    const swapped: RetireOp[] = [];
    for (const [key, ops] of byKey) {
      const choice = retireChoice[key];
      const group = groupByKey.get(key);
      // Only honour a choice that names exactly as many valid copies as the shrink retires.
      if (
        choice &&
        group &&
        choice.length === ops.length &&
        choice.every((id) => copyById.has(id))
      ) {
        for (const copyId of choice) {
          const c = copyById.get(copyId)!;
          const { consequence, needsReview } = consequenceOf(c);
          swapped.push({
            kind: "retire",
            copyId,
            catalogCardId: group.catalogCardId,
            dexVariantRaw: group.dexVariantRaw,
            consequence,
            needsReview,
          });
        }
      } else {
        swapped.push(...ops);
      }
    }
    retires = swapped;
  }

  return {
    ...plan,
    creates,
    retires,
    variantUpdates,
  };
}
