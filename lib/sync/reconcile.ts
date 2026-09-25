/**
 * PresenceGroup count-delta reconciliation over stable Copy records (docs/sync-architecture.md
 * §1.4–§1.6).
 *
 * PURE — no Supabase, no fetch, no Date.now(); the clock is injected. Inputs: the resolved+scoped
 * Dex rows and a snapshot of the app's current presence groups (with each copy's placement). Output:
 * a concrete plan of copy creates / retires / variant-updates plus the unresolved rows to park. The
 * route applies the plan and does the I/O; this module only decides.
 *
 * The invariant this serves: *unchanged card, untouched placement*. Dex owns presence (which cards,
 * which variant, how many); the app owns placement. So the plan moves the copy COUNT toward Dex's
 * number by adding at the margin and retiring the least-committed copies (§1.5), and it never
 * rebuilds a group. Placement is touched only through the two narrow doors — create (unplaced) and
 * retire (released under the removal rule, §1.6) — and a variant change carries placement across
 * rather than retire+recreate.
 */
import type { Role } from "@/lib/engine";
import {
  applyRemovedMemory,
  diff,
  presenceKey,
  toPresenceMap,
  type PresenceCount,
  type RemovedPresence,
  type SyncDiff,
} from "./diff";
import { OWNED_TYPE } from "./csv";

/** The app's five-flag display/placement variant (0002_domain.sql copy.variant check). */
export type CopyVariant = "normal" | "holo" | "reverse" | "firstEdition" | "wPromo";

/**
 * Map a raw Dex `Variant` string to the app's five-flag display variant (§1.4). The raw string is
 * what identity keys on and is stored verbatim on the copy; this derived flag is display/placement
 * only (rainbow band, dup detection). Subtypes the five flags can't express collapse to their base
 * (Poké Ball / Friend Ball / Quick Ball Holo → reverse; Cosmos Holo → holo), and stamped-promo
 * overlays with no flag (Trick or Trade, Expansion Stamp) fall back to `normal` — lossy but
 * non-destructive, since the raw string still distinguishes them (limitation L3).
 */
export function deriveVariantFlag(dexVariantRaw: string): CopyVariant {
  const v = dexVariantRaw.trim().toLowerCase();
  switch (v) {
    case "normal":
      return "normal";
    case "holo":
    case "cosmos holo":
      return "holo";
    case "reverse holo":
    case "poké ball holo":
    case "poke ball holo":
    case "friend ball holo":
    case "quick ball holo":
      return "reverse";
    case "1st edition":
    case "first edition":
      return "firstEdition";
    case "w promo":
    case "wpromo":
      return "wPromo";
    default:
      // Trick or Trade 2023, Expansion Stamp, and any future subtype: base display, raw kept.
      return "normal";
  }
}

/** Why a resolved row could not be matched to a catalog card (sync-ui-spec §A.2). */
export type UnresolvedReason = "UNKNOWN_SET" | "UNKNOWN_CARD";

/** Raw Dex fields carried into the Unresolved queue so nothing is lost (sync-ui-spec §A.3). */
export interface UnresolvedRow {
  dexId: string;
  dexSetName: string;
  dexSeries: string;
  dexNumber: string;
  dexName: string;
  dexVariantRaw: string;
  quantity: number;
  locale: string;
  reason: UnresolvedReason;
}

/**
 * One owned-or-not row after CSV parse + deterministic resolve + catalog lookup. `catalogCardId`
 * is set when the row matched a mirror card; otherwise it is null and `reason` says why. `type`
 * is the Dex `Type` column — reconcile scope-filters on it FIRST so wishlist rows can never be
 * counted as owned presence (§1.2).
 */
export interface ResolvedRow {
  type: string;
  catalogCardId: string | null;
  dexVariantRaw: string;
  quantity: number;
  reason?: UnresolvedReason;
  raw: {
    dexId: string;
    setName: string;
    series: string;
    number: string;
    name: string;
    locale: string;
  };
}

/** Placement-bearing snapshot of one existing Copy (§1.5). `copyId` is app-generated and stable. */
export interface CopySnapshot {
  copyId: string;
  /** `Role`, not a literal list: the list went stale when UIL-088 added 'haul' (UIL-093). */
  role: Role;
  binderId: string | null;
  binderHalf: "front" | "back" | null;
  colorBand: string | null;
  /** Non-null when this copy fills an evolution-line slot. */
  lineSlotId: string | null;
  /** ISO timestamp; the shrink tiebreak retires the most recently created copy first (§1.6). */
  createdAt: string;
  /**
   * The flag the copy CARRIES (`copy.variant`), audited against its group's Dex variant (UIL-102).
   * `loadCurrentGroups` always sets it; a hand-built snapshot may leave it out, and is then not audited.
   */
  variant?: string;
}

/** One current presence group and its ordered copies (§1.5). */
export interface CurrentGroup {
  catalogCardId: string;
  dexVariantRaw: string;
  copies: CopySnapshot[];
}

/** What retiring a copy releases (§1.6). Drives the preview's "consequence" column (sync-ui §B.2). */
export type RemovalConsequence =
  | "line-slot-freed" // slot reverts to placeholder; the line stays intact and keeps its color
  | "shelved-cleared" // front-half binder/half assignment cleared
  | "bulk-removed" // bulk box has no structure to preserve; removed silently
  | "unplaced-removed" // never placed (e.g. the phantom copy): releases nothing
  | "block-review"; // repurposed binder block: NEVER auto-revert — flag for her review

export interface CreateOp {
  kind: "create";
  catalogCardId: string;
  dexVariantRaw: string;
  variant: CopyVariant;
}

export interface RetireOp {
  kind: "retire";
  copyId: string;
  catalogCardId: string;
  dexVariantRaw: string;
  consequence: RemovalConsequence;
  /** True only for block copies: the plan flags, it does not auto-revert (§1.6). */
  needsReview: boolean;
}

export interface VariantUpdateOp {
  kind: "variant_update";
  copyId: string;
  catalogCardId: string;
  fromVariantRaw: string;
  toVariantRaw: string;
  toVariant: CopyVariant;
  /** Always true: the whole point is that placement is carried across, not released (§1.6). */
  placementPreserved: true;
}

/**
 * A copy whose stored flag disagrees with its own Dex variant (UIL-102): the key is right, the flag is
 * wrong. Not a migration — the copy stays in its group, only `copy.variant` is corrected — and never a
 * placement: a copy placed under the wrong flag keeps its pocket, and `placed` is how the preview tells her
 * to check it.
 */
export interface FlagFixOp {
  kind: "flag_fix";
  copyId: string;
  catalogCardId: string;
  dexVariantRaw: string;
  fromVariant: string;
  toVariant: CopyVariant;
  /** True when the copy sits anywhere but her haul — placed while it carried the wrong flag. */
  placed: boolean;
}

export interface ReconcilePlan {
  creates: CreateOp[];
  retires: RetireOp[];
  variantUpdates: VariantUpdateOp[];
  /** Copies whose stored flag is not the one their Dex variant derives (UIL-102). */
  flagFixes: FlagFixOp[];
  /** Count of keys the sync leaves completely alone — proof it isn't churning placement. */
  unchanged: number;
  unresolved: UnresolvedRow[];
  fastPath: boolean;
  diff: SyncDiff;
  /**
   * `removed_presence` rows whose key this export no longer lists, to delete in the apply's own
   * transaction (UIL-089). Dex has stopped claiming the card, so the disagreement the memory recorded is
   * over; keeping it would suppress a genuine future re-acquisition forever. Empty on a retry import,
   * which has no evidence of absence — see `applyRemovedMemory`.
   */
  forgetRemoved: RemovedPresence[];
}

export interface ReconcileInput {
  rows: ResolvedRow[];
  current: CurrentGroup[];
  /**
   * Copies she has REMOVED that Dex still lists (UIL-089), subtracted from desired presence so the import
   * does not hand them back. Absent means none, which is the state of a collection nobody has removed
   * from — so every existing caller stays correct without knowing about this.
   */
  removed?: readonly RemovedPresence[];
  /**
   * True when `rows` came from a WHOLE Dex export, false for a retry that promoted a few parked rows.
   * Only used to decide whether a memory whose key is absent may be forgotten: a retry's `desired` map is
   * nearly empty by design, so absence proves nothing there. Defaults to false, the safe answer.
   */
  fullExport?: boolean;
  /** Injected clock (purity). Currently unused by the plan itself; reserved for dated decisions. */
  clock?: () => Date;
}

/**
 * Scope filter FIRST (§1.2), then build the desired presence map and the unresolved parks. Wishlist
 * / custom-list rows (`Type != "collection"`) are dropped here and can never become owned presence —
 * this is the step that prevents the silent collection corruption called out in the architecture.
 */
/**
 * A Dex row's quantity as presence counts it: a whole number, never negative, 0 when unreadable. Shared by
 * the import and the Sync page's manual match (UIL-099 E2), so one row cannot count two different ways.
 */
export function dexQuantity(quantity: number): number {
  return Number.isFinite(quantity) ? Math.max(0, Math.trunc(quantity)) : 0;
}

export function buildDesiredPresence(rows: ResolvedRow[]): {
  desired: ReturnType<typeof toPresenceMap>;
  unresolved: UnresolvedRow[];
} {
  const owned = rows.filter((r) => r.type === OWNED_TYPE);

  const counts: PresenceCount[] = [];
  const unresolved: UnresolvedRow[] = [];
  for (const r of owned) {
    const qty = dexQuantity(r.quantity);
    if (r.catalogCardId) {
      counts.push({ catalogCardId: r.catalogCardId, dexVariantRaw: r.dexVariantRaw, count: qty });
    } else {
      unresolved.push({
        dexId: r.raw.dexId,
        dexSetName: r.raw.setName,
        dexSeries: r.raw.series,
        dexNumber: r.raw.number,
        dexName: r.raw.name,
        dexVariantRaw: r.dexVariantRaw,
        quantity: qty,
        locale: r.raw.locale,
        reason: r.reason ?? "UNKNOWN_CARD",
      });
    }
  }

  return { desired: toPresenceMap(counts), unresolved };
}

/** How committed a copy's placement is; the shrink retires the LEAST committed first (§1.5). */
function commitRank(c: CopySnapshot): number {
  if (c.role === "block") return 3; // a repurposed block is the most committed — special-cased below
  if (c.lineSlotId) return 2; // holds an evolution-line slot
  if (c.role === "shelved" && c.binderId) return 1; // shelved in a binder
  return 0; // bulk, or shelved-but-never-placed
}

/** Retire order: least-committed first; tiebreak = most recently created first (§1.5, §1.6). */
function byRetireOrder(a: CopySnapshot, b: CopySnapshot): number {
  return commitRank(a) - commitRank(b) || b.createdAt.localeCompare(a.createdAt);
}

/** Migration prefers the MOST-committed departing copy, so the best placement is the one carried. */
function byMigratePreference(a: CopySnapshot, b: CopySnapshot): number {
  return commitRank(b) - commitRank(a) || a.createdAt.localeCompare(b.createdAt);
}

function removalConsequence(c: CopySnapshot): {
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
 * Reconcile a resolved snapshot against current app state into a concrete plan.
 *
 * Order (§1.7 step 5): variant migrations first (carry placement), then adds (unplaced), then
 * retires (least-committed released under the removal rule). UNCHANGED keys are never touched.
 */
export function reconcile(input: ReconcileInput): ReconcilePlan {
  const { desired: dexDesired, unresolved } = buildDesiredPresence(input.rows);
  // What Dex says she owns, minus what she has told the app she no longer has (UIL-089).
  const { desired, forget: forgetRemoved } = applyRemovedMemory(
    dexDesired,
    input.removed ?? [],
    input.fullExport ?? false,
  );

  const groupByKey = new Map<string, CurrentGroup>();
  const currentCounts: PresenceCount[] = [];
  for (const g of input.current) {
    groupByKey.set(presenceKey(g.catalogCardId, g.dexVariantRaw), g);
    currentCounts.push({
      catalogCardId: g.catalogCardId,
      dexVariantRaw: g.dexVariantRaw,
      count: g.copies.length,
    });
  }
  const currentMap = toPresenceMap(currentCounts);

  const d = diff(desired, currentMap);

  // Per losing variant, the exact copies leaving the group: the |delta| least-committed ones.
  const departingByKey = new Map<string, CopySnapshot[]>();
  for (const e of d.entries) {
    if (e.delta >= 0) continue;
    const group = groupByKey.get(e.key);
    const copies = group ? [...group.copies] : [];
    copies.sort(byRetireOrder);
    departingByKey.set(e.key, copies.slice(0, -e.delta));
  }

  // How many copies migrate OUT of / INTO each key, from the count-level pairing.
  const migrateOut = new Map<string, number>();
  const migrateIn = new Map<string, number>();
  for (const m of d.migrations) {
    const fromKey = presenceKey(m.catalogCardId, m.fromVariantRaw);
    const toKey = presenceKey(m.catalogCardId, m.toVariantRaw);
    migrateOut.set(fromKey, (migrateOut.get(fromKey) ?? 0) + m.count);
    migrateIn.set(toKey, (migrateIn.get(toKey) ?? 0) + m.count);
  }

  // For each losing key, split its departing copies into a migration pool (most-committed) and a
  // retire pool (the rest). The migration pool is consumed in `migrations` order below.
  const migratePool = new Map<string, CopySnapshot[]>();
  const retires: RetireOp[] = [];
  for (const [key, departing] of departingByKey) {
    const nMigrate = migrateOut.get(key) ?? 0;
    const preferred = [...departing].sort(byMigratePreference);
    const toMigrate = preferred.slice(0, nMigrate);
    const migrateIds = new Set(toMigrate.map((c) => c.copyId));
    migratePool.set(key, toMigrate);

    const group = groupByKey.get(key)!;
    for (const c of departing) {
      if (migrateIds.has(c.copyId)) continue;
      const { consequence, needsReview } = removalConsequence(c);
      retires.push({
        kind: "retire",
        copyId: c.copyId,
        catalogCardId: group.catalogCardId,
        dexVariantRaw: group.dexVariantRaw,
        consequence,
        needsReview,
      });
    }
  }

  // Execute the count-level migrations against concrete copies, carrying placement across.
  const variantUpdates: VariantUpdateOp[] = [];
  for (const m of d.migrations) {
    const fromKey = presenceKey(m.catalogCardId, m.fromVariantRaw);
    const pool = migratePool.get(fromKey) ?? [];
    for (let i = 0; i < m.count; i++) {
      const c = pool.shift();
      if (!c) break;
      variantUpdates.push({
        kind: "variant_update",
        copyId: c.copyId,
        catalogCardId: m.catalogCardId,
        fromVariantRaw: m.fromVariantRaw,
        toVariantRaw: m.toVariantRaw,
        toVariant: deriveVariantFlag(m.toVariantRaw),
        placementPreserved: true,
      });
    }
  }

  /**
   * FLAG AUDIT (UIL-102). A copy's `variant` flag is DERIVED from its Dex variant (`deriveVariantFlag`),
   * and the holo-swap rule reads the flag, not the Dex string — so a copy carrying the wrong one is placed
   * as the wrong card. The Sync page's manual match wrote "normal" for every row until UIL-102, and no
   * import ever looked. Every copy that STAYS in its group is checked; a retiring copy is going, and a
   * migrating one is re-flagged by its own migration.
   */
  const leaving = new Set<string>([
    ...retires.map((r) => r.copyId),
    ...variantUpdates.map((v) => v.copyId),
  ]);
  const flagFixes: FlagFixOp[] = [];
  for (const g of input.current) {
    const want = deriveVariantFlag(g.dexVariantRaw);
    for (const c of g.copies) {
      if (c.variant === undefined || c.variant === want || leaving.has(c.copyId)) continue;
      flagFixes.push({
        kind: "flag_fix",
        copyId: c.copyId,
        catalogCardId: g.catalogCardId,
        dexVariantRaw: g.dexVariantRaw,
        fromVariant: c.variant,
        toVariant: want,
        placed: c.role !== "haul",
      });
    }
  }

  // Adds: for each gaining key, create (delta − migrated-in) new unplaced copies for the cascade.
  const creates: CreateOp[] = [];
  for (const e of d.entries) {
    if (e.delta <= 0) continue;
    const createCount = e.delta - (migrateIn.get(e.key) ?? 0);
    for (let i = 0; i < createCount; i++) {
      creates.push({
        kind: "create",
        catalogCardId: e.catalogCardId,
        dexVariantRaw: e.dexVariantRaw,
        variant: deriveVariantFlag(e.dexVariantRaw),
      });
    }
  }

  return {
    creates,
    retires,
    variantUpdates,
    flagFixes,
    unchanged: d.counts.unchanged,
    unresolved,
    fastPath: d.fastPath,
    diff: d,
    forgetRemoved,
  };
}
