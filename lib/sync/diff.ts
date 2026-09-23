/**
 * Desired-vs-current snapshot diff (docs/sync-architecture.md §1.7).
 *
 * PURE — no Supabase, no fetch, no Date. Inputs in, classification out. This is the count-level
 * truth the reconciler builds concrete Copy mutations from: it never touches placement, it only
 * decides, per presence key, whether the collection should gain, lose, or hold copies, and pairs
 * remove/add on the SAME card into variant migrations so a variant change reads as an update, not
 * a retire+recreate (§1.6).
 *
 * Idempotency (§1.7, proved by construction): a key is `UNCHANGED` iff `desired == current`.
 * Re-diffing the same desired map against a current map that already equals it classifies every
 * key `UNCHANGED`, produces no migrations, and yields an empty operation set. Snapshot-diff against
 * a desired end-state — not an event log — is what makes re-importing the same CSV a no-op.
 */
import type { SyncClass } from "./types";

/** A count of copies desired/held for one `(catalogCardId, dexVariantRaw)` presence key. */
export interface PresenceCount {
  catalogCardId: string;
  dexVariantRaw: string;
  count: number;
}

/** Map from a stable presence-key string to its count. */
export type PresenceMap = Map<string, PresenceCount>;

/**
 * Stable string form of a presence key. The NUL separator can't appear in a tcgdex id or variant. Written
 * as an escape, not a raw byte: a raw NUL in source makes `grep` treat the file as binary and report
 * "matches" without the line, which hid this exact line during UIL analysis.
 */
export function presenceKey(catalogCardId: string, dexVariantRaw: string): string {
  return `${catalogCardId}\u0000${dexVariantRaw}`;
}

/** Aggregate presence facts into a map, summing counts for repeated keys. */
export function toPresenceMap(entries: PresenceCount[]): PresenceMap {
  const map: PresenceMap = new Map();
  for (const e of entries) {
    if (e.count <= 0) continue;
    const key = presenceKey(e.catalogCardId, e.dexVariantRaw);
    const existing = map.get(key);
    if (existing) existing.count += e.count;
    else
      map.set(key, {
        catalogCardId: e.catalogCardId,
        dexVariantRaw: e.dexVariantRaw,
        count: e.count,
      });
  }
  return map;
}

/** Per-key classification before the variant-migration pass folds pairs together. */
export interface DiffEntry {
  key: string;
  catalogCardId: string;
  dexVariantRaw: string;
  desiredCount: number;
  currentCount: number;
  /** UNCHANGED | ADDED | REMOVED | CHANGED. VARIANT_UPDATE lives in `migrations`, not here. */
  class: Exclude<SyncClass, "VARIANT_UPDATE">;
  /** desiredCount − currentCount. Positive = gain copies, negative = lose copies. */
  delta: number;
}

/**
 * A remove-on-one-variant paired with an add-on-another of the SAME card, to be executed as a
 * placement-preserving variant change rather than a retire + recreate (§1.6). Count-level only;
 * the reconciler decides which physical copies migrate.
 */
export interface VariantMigration {
  catalogCardId: string;
  fromVariantRaw: string;
  toVariantRaw: string;
  count: number;
}

export interface SyncDiff {
  entries: DiffEntry[];
  migrations: VariantMigration[];
  counts: {
    added: number;
    removed: number;
    changed: number;
    unchanged: number;
    variantUpdate: number;
  };
  /**
   * Fast-path iff the diff can ONLY add unplaced copies — zero removals, zero decreases, zero
   * variant migrations (sync-ui-spec §B.1). Additions can't disturb existing placement, so gating
   * them buys friction, not safety. Anything that could move a placement forces the preview.
   */
  fastPath: boolean;
}

/** Classify each presence key desired-vs-current, then pair variant migrations (§1.7 steps 3–4). */
export function diff(desired: PresenceMap, current: PresenceMap): SyncDiff {
  const entries: DiffEntry[] = [];
  const keys = new Set<string>([...desired.keys(), ...current.keys()]);

  for (const key of keys) {
    const d = desired.get(key);
    const a = current.get(key);
    const desiredCount = d?.count ?? 0;
    const currentCount = a?.count ?? 0;
    const catalogCardId = d?.catalogCardId ?? a!.catalogCardId;
    const dexVariantRaw = d?.dexVariantRaw ?? a!.dexVariantRaw;
    const delta = desiredCount - currentCount;

    let cls: DiffEntry["class"];
    if (desiredCount === currentCount) cls = "UNCHANGED";
    else if (currentCount === 0) cls = "ADDED";
    else if (desiredCount === 0) cls = "REMOVED";
    else cls = "CHANGED";

    entries.push({
      key,
      catalogCardId,
      dexVariantRaw,
      desiredCount,
      currentCount,
      class: cls,
      delta,
    });
  }

  // Deterministic order so plans and previews are stable across runs.
  entries.sort((x, y) => x.key.localeCompare(y.key));

  const migrations = pairVariantMigrations(entries);

  const counts = {
    added: entries.filter((e) => e.class === "ADDED").length,
    removed: entries.filter((e) => e.class === "REMOVED").length,
    changed: entries.filter((e) => e.class === "CHANGED").length,
    unchanged: entries.filter((e) => e.class === "UNCHANGED").length,
    variantUpdate: migrations.reduce((n, m) => n + m.count, 0),
  };

  const hasRemovalOrDecrease = entries.some((e) => e.delta < 0);
  const fastPath = !hasRemovalOrDecrease && migrations.length === 0;

  return { entries, migrations, counts, fastPath };
}

/**
 * Variant-migration pass (§1.6, §1.7 step 4). Within a single `catalogCardId`, greedily pair the
 * copies a variant lost against the copies a sibling variant gained in the SAME sync. Each paired
 * copy is a variant change that carries placement across; only the unpaired remainder is a true
 * remove or a true add. Deterministic (sorted variants), so the preview and re-runs are stable.
 */
function pairVariantMigrations(entries: DiffEntry[]): VariantMigration[] {
  const byCard = new Map<string, DiffEntry[]>();
  for (const e of entries) {
    if (e.delta === 0) continue;
    const list = byCard.get(e.catalogCardId) ?? [];
    list.push(e);
    byCard.set(e.catalogCardId, list);
  }

  const migrations: VariantMigration[] = [];
  for (const [catalogCardId, list] of byCard) {
    const losing = list
      .filter((e) => e.delta < 0)
      .map((e) => ({ variant: e.dexVariantRaw, remaining: -e.delta }))
      .sort((a, b) => a.variant.localeCompare(b.variant));
    const gaining = list
      .filter((e) => e.delta > 0)
      .map((e) => ({ variant: e.dexVariantRaw, remaining: e.delta }))
      .sort((a, b) => a.variant.localeCompare(b.variant));

    let gi = 0;
    for (const from of losing) {
      while (from.remaining > 0 && gi < gaining.length) {
        const to = gaining[gi];
        const n = Math.min(from.remaining, to.remaining);
        migrations.push({
          catalogCardId,
          fromVariantRaw: from.variant,
          toVariantRaw: to.variant,
          count: n,
        });
        from.remaining -= n;
        to.remaining -= n;
        if (to.remaining === 0) gi++;
      }
    }
  }
  return migrations;
}

/* ----------------------- copies she removed that Dex still lists (UIL-089) ----------------------- */

/** One `removed_presence` row: how many of this exact key she has removed while Dex still listed it. */
export interface RemovedPresence {
  catalogCardId: string;
  dexVariantRaw: string;
  count: number;
}

/**
 * Subtract what she has REMOVED from what Dex says she owns (UIL-089).
 *
 * Presence is a count, so a copy she removed while Dex still lists the card reads as `desired 1 /
 * current 0` on the very next import and comes straight back. She traded it away; the app cannot keep
 * handing it to her. This is the one place that knows, which is the whole reason the memory is keyed
 * exactly like `presence_group`: the subtraction is `max(0, dex - removed)` and nothing has to agree with
 * anything else.
 *
 * Subtracting to zero DELETES the entry rather than storing a zero, because `diff` already reads an absent
 * key as zero and `toPresenceMap` drops zero counts — one representation of "none", not two.
 *
 * THE `forget` LIST IS GATED ON A FULL EXPORT, and that gate is load-bearing. A retry import reconciles
 * only against the handful of keys it just promoted (`lib/sync/pipeline.ts`), so its `desired` map is
 * almost entirely empty — treating "absent from desired" as "Dex stopped listing it" there would forget
 * every memory she has on the first retry. Only a full export is evidence of absence.
 */
export function applyRemovedMemory(
  desired: PresenceMap,
  removed: readonly RemovedPresence[],
  fullExport: boolean,
): { desired: PresenceMap; forget: RemovedPresence[] } {
  const out: PresenceMap = new Map(
    [...desired].map(([k, v]) => [k, { ...v }] as [string, PresenceCount]),
  );
  const forget: RemovedPresence[] = [];

  for (const m of removed) {
    const key = presenceKey(m.catalogCardId, m.dexVariantRaw);
    const entry = out.get(key);
    if (!entry) {
      // Dex no longer lists this key at all. On a full export that means the disagreement is over and the
      // memory would otherwise suppress a genuine future re-acquisition forever.
      if (fullExport) forget.push(m);
      continue;
    }
    const left = entry.count - m.count;
    if (left > 0) entry.count = left;
    else out.delete(key);
  }

  return { desired: out, forget };
}
