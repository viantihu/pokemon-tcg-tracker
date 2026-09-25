/**
 * Preview view-model builder (docs/sync-ui-spec.md §B.2). PURE — turns a reconcile plan plus catalog
 * enrichment into the sectioned, most-consequential-first diff the Sync screen renders. Kept out of
 * the React component so the section shaping, the removal-consequence phrasing, and the addition
 * aggregation are unit-testable without a DOM (the project's "UI test" convention).
 */
import type { ReconcilePlan, RemovalConsequence } from "./reconcile";
import type { UnresolvedRow } from "./reconcile";
import type { SyncCounts } from "./undo";
import { presenceKey } from "./diff";
import { isNoop, migrationKey, requiresPreview } from "./apply";

/** Catalog display facts for one card, joined from the mirror. */
export interface CardMeta {
  name: string;
  /** Set name, for naming a card she has to go and find (UIL-102's flag fixes). */
  setName?: string | null;
  imageUrl: string | null;
  localId: string | null;
  /** Printed set total, for the full "099/182" form (UIL-077). Null when TCGdex reports none. */
  setCardCountOfficial: number | null;
  bandKey: string;
}

export type PreviewKind = "noop" | "fastpath" | "gated";

export interface RemovalRow {
  copyId: string;
  catalogCardId: string;
  presenceKey: string;
  name: string;
  imageUrl: string | null;
  localId: string | null;
  setCardCountOfficial: number | null;
  bandKey: string;
  dexVariantRaw: string;
  consequence: RemovalConsequence;
  consequenceLabel: string;
  needsReview: boolean;
  placementLabel: string;
}

export interface VariantRow {
  copyId: string;
  catalogCardId: string;
  migrationKey: string;
  name: string;
  imageUrl: string | null;
  localId: string | null;
  setCardCountOfficial: number | null;
  bandKey: string;
  fromVariantRaw: string;
  toVariantRaw: string;
}

/**
 * A card whose stored flag was corrected (UIL-102), NAMED so she can find it: the Actions log cannot carry
 * card names, so this list is how she learns which cards to check. Nothing is re-placed.
 */
export interface FlagFixRow {
  copyId: string;
  catalogCardId: string;
  name: string;
  setName: string | null;
  imageUrl: string | null;
  localId: string | null;
  setCardCountOfficial: number | null;
  bandKey: string;
  dexVariantRaw: string;
  /** "recorded as Normal, now Holo". */
  change: string;
  /** Set only for a copy placed while it carried the wrong flag: where to look, and why. */
  placedNote: string | null;
}

/** A stored flag in her words — the Dex spelling of each of the five (reconcile.ts `deriveVariantFlag`). */
export function flagLabel(flag: string): string {
  switch (flag) {
    case "normal":
      return "Normal";
    case "holo":
      return "Holo";
    case "reverse":
      return "Reverse Holo";
    case "firstEdition":
      return "1st Edition";
    case "wPromo":
      return "W Promo";
    default:
      return flag;
  }
}

export interface AdditionRow {
  catalogCardId: string;
  name: string;
  imageUrl: string | null;
  localId: string | null;
  setCardCountOfficial: number | null;
  bandKey: string;
  dexVariantRaw: string;
  count: number;
}

export interface UnresolvedRowView {
  dexId: string;
  dexName: string;
  dexSetName: string;
  dexNumber: string;
  dexVariantRaw: string;
  quantity: number;
  reason: UnresolvedRow["reason"];
}

export interface SyncPreview {
  kind: PreviewKind;
  summary: {
    removed: number;
    variantChanges: number;
    /** Stored flags corrected (UIL-102). */
    flagFixes: number;
    added: number;
    waiting: number;
    unchanged: number;
    summaryLine: string;
  };
  sections: {
    removals: RemovalRow[];
    variantChanges: VariantRow[];
    flagFixes: FlagFixRow[];
    additions: AdditionRow[];
    unresolved: { newParks: UnresolvedRowView[]; stillWaiting: number; forgottenDismissed: number };
    unchanged: number;
  };
  /**
   * Per presence key, the copies currently in that group (with a placement label) — the candidate
   * set for the "which copy left on a shrink" override (sync-ui-spec §B.3). Only present for keys
   * with a removal; the UI offers a swap when there are more copies than the shrink retires.
   */
  retireOptions: Record<string, { copyId: string; label: string }[]>;
}

const CONSEQUENCE_LABEL: Record<RemovalConsequence, string> = {
  "line-slot-freed": "frees a line slot → placeholder",
  "shelved-cleared": "was shelved — front-half slot cleared",
  "bulk-removed": "was in the bulk box — removed",
  "unplaced-removed": "was unplaced — nothing to free",
  "block-review": "recorded as a binder block — needs your call",
};

const UNKNOWN_CARD: CardMeta = {
  name: "(unknown card)",
  imageUrl: null,
  localId: null,
  setCardCountOfficial: null,
  bandKey: "white",
};

/** The persistent summary line (sync-ui-spec §B.2), only listing the sections that have content. */
export function summaryLine(s: SyncPreview["summary"]): string {
  const parts: string[] = [];
  if (s.removed > 0) parts.push(`${s.removed} removed`);
  if (s.variantChanges > 0) parts.push(`${s.variantChanges} variant changes`);
  if (s.flagFixes > 0) {
    parts.push(`${s.flagFixes} variant flag${s.flagFixes === 1 ? "" : "s"} corrected`);
  }
  if (s.added > 0) parts.push(`${s.added} added`);
  if (s.waiting > 0) parts.push(`${s.waiting} waiting on catalog`);
  parts.push(`${s.unchanged} unchanged`);
  return parts.join(" · ");
}

export interface PreviewEnrichment {
  cardMetaById: Record<string, CardMeta>;
  /** Human placement label per copyId (e.g. "Binder 1 · front · Lightning"). */
  placementByCopyId: Record<string, string>;
  /** Copies in each presence group (by key), with their placement label — for the shrink override. */
  groupCopies: Record<string, { copyId: string; label: string }[]>;
  newParks: UnresolvedRow[];
  stillWaiting: number;
  counts: SyncCounts;
  /** Dismissed rows this import forgets because the file no longer lists them (UIL-104). */
  forgottenDismissed?: number;
}

/** Build the full preview view-model from a (possibly override-adjusted) plan (PURE). */
export function buildPreview(plan: ReconcilePlan, enr: PreviewEnrichment): SyncPreview {
  const meta = (id: string): CardMeta => enr.cardMetaById[id] ?? UNKNOWN_CARD;

  const removals: RemovalRow[] = plan.retires.map((r) => {
    const m = meta(r.catalogCardId);
    return {
      copyId: r.copyId,
      catalogCardId: r.catalogCardId,
      presenceKey: presenceKey(r.catalogCardId, r.dexVariantRaw),
      name: m.name,
      imageUrl: m.imageUrl,
      localId: m.localId,
      setCardCountOfficial: m.setCardCountOfficial,
      bandKey: m.bandKey,
      dexVariantRaw: r.dexVariantRaw,
      consequence: r.consequence,
      consequenceLabel: CONSEQUENCE_LABEL[r.consequence],
      needsReview: r.needsReview,
      placementLabel: enr.placementByCopyId[r.copyId] ?? "",
    };
  });

  const variantChanges: VariantRow[] = plan.variantUpdates.map((v) => {
    const m = meta(v.catalogCardId);
    return {
      copyId: v.copyId,
      catalogCardId: v.catalogCardId,
      migrationKey: migrationKey(v.catalogCardId, v.fromVariantRaw, v.toVariantRaw),
      name: m.name,
      imageUrl: m.imageUrl,
      localId: m.localId,
      setCardCountOfficial: m.setCardCountOfficial,
      bandKey: m.bandKey,
      fromVariantRaw: v.fromVariantRaw,
      toVariantRaw: v.toVariantRaw,
    };
  });

  const flagFixes: FlagFixRow[] = (plan.flagFixes ?? []).map((f) => {
    const m = meta(f.catalogCardId);
    const was = flagLabel(f.fromVariant);
    const where = enr.placementByCopyId[f.copyId];
    return {
      copyId: f.copyId,
      catalogCardId: f.catalogCardId,
      name: m.name,
      setName: m.setName ?? null,
      imageUrl: m.imageUrl,
      localId: m.localId,
      setCardCountOfficial: m.setCardCountOfficial,
      bandKey: m.bandKey,
      dexVariantRaw: f.dexVariantRaw,
      change: `recorded as ${was}, now ${flagLabel(f.toVariant)}`,
      // The Senior BA's wording. Nothing is moved: she decides whether the pocket is still right.
      placedNote: f.placed
        ? `was placed while recorded as ${was}; check its pocket${where ? ` (${where})` : ""}`
        : null,
    };
  });

  // Additions are aggregated per (card, variant) so N new copies read as one "×N" row.
  const addMap = new Map<string, AdditionRow>();
  for (const c of plan.creates) {
    const key = presenceKey(c.catalogCardId, c.dexVariantRaw);
    const existing = addMap.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      const m = meta(c.catalogCardId);
      addMap.set(key, {
        catalogCardId: c.catalogCardId,
        name: m.name,
        imageUrl: m.imageUrl,
        localId: m.localId,
        setCardCountOfficial: m.setCardCountOfficial,
        bandKey: m.bandKey,
        dexVariantRaw: c.dexVariantRaw,
        count: 1,
      });
    }
  }
  const additions = [...addMap.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.dexVariantRaw.localeCompare(b.dexVariantRaw),
  );

  const newParks: UnresolvedRowView[] = enr.newParks.map((u) => ({
    dexId: u.dexId,
    dexName: u.dexName,
    dexSetName: u.dexSetName,
    dexNumber: u.dexNumber,
    dexVariantRaw: u.dexVariantRaw,
    quantity: u.quantity,
    reason: u.reason,
  }));

  const summary = {
    removed: plan.retires.length,
    variantChanges: plan.variantUpdates.length,
    flagFixes: flagFixes.length,
    added: plan.creates.length,
    waiting: enr.stillWaiting,
    unchanged: enr.counts.unchanged,
    summaryLine: "",
  };
  summary.summaryLine = summaryLine(summary);

  const kind: PreviewKind = isNoop(enr.counts)
    ? "noop"
    : requiresPreview(plan)
      ? "gated"
      : "fastpath";

  // Offer a which-copy-left swap only for keys that actually have a removal.
  const retireOptions: Record<string, { copyId: string; label: string }[]> = {};
  for (const r of removals) {
    if (!retireOptions[r.presenceKey])
      retireOptions[r.presenceKey] = enr.groupCopies[r.presenceKey] ?? [];
  }

  return {
    kind,
    summary,
    sections: {
      removals,
      variantChanges,
      flagFixes,
      additions,
      unresolved: {
        newParks,
        stillWaiting: enr.stillWaiting,
        forgottenDismissed: enr.forgottenDismissed ?? 0,
      },
      unchanged: enr.counts.unchanged,
    },
    retireOptions,
  };
}

/**
 * What the preview says about dismissed rows this import forgets (UIL-104 — never silent). Exported so the
 * screen and its test read the same sentence.
 */
export function forgottenDismissedLine(n: number): string {
  return n === 1
    ? "1 dismissed row is no longer in your Dex file and will be forgotten."
    : `${n} dismissed rows are no longer in your Dex file and will be forgotten.`;
}
