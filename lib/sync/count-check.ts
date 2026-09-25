/**
 * UIL-100 — the collection must add up to the Dex file.
 *
 * Karvi: "There needs to be some kind of validation in the sync that makes sure that the total number of
 * cards in the collection equal the dex import file. This will ensure that cards are not double counted
 * during the matching process or manual add process."
 *
 * TWO HALVES, ONE RULE. The database refuses any sync write that would leave a key disagreeing with the
 * record (`assert_presence_counts`, migration 0022), so a double can never be committed. This module is the
 * other half: the pure check the Sync page shows at rest, and the translation of a refusal into words she
 * can act on. Both use the SAME per-key rule — copies = max(0, dex − removed) — and here it is computed by
 * calling `applyRemovedMemory` itself, the function an import uses to subtract removals, so a card she
 * removed can never read as "missing" (tests/sync/count-check.test.ts pins the SQL against it).
 *
 * PURE: no Supabase, no fetch. The loader in app/(ui)/sync/actions.ts reads the rows and passes them in.
 */
import { applyRemovedMemory, presenceKey, toPresenceMap, type RemovedPresence } from "./diff";
import type { ResolvedRow } from "./reconcile";
import type { DexRecordRow, PresenceKeyRef } from "@/lib/repo/write-ops";

/** The file-level facts an import records alongside the per-key rows. */
export interface DexRecord {
  rows: DexRecordRow[];
  /** Sum of Quantity over the owned rows of the file, resolved or not. */
  fileTotal: number;
  rowCount: number;
}

/**
 * The record an import writes, from the rows it read: Dex's RAW quantity per resolved key (before removals —
 * removals are the check's to subtract, not the record's), plus the whole file's total. Quantities use the
 * same normalisation as `buildDesiredPresence` (max(0, trunc)), so the record and the plan agree to the card.
 */
export function dexRecordFromRows(rows: readonly ResolvedRow[]): DexRecord {
  const owned = rows.filter((r) => r.type === "collection");
  const qty = (q: number) => (Number.isFinite(q) ? Math.max(0, Math.trunc(q)) : 0);
  const map = toPresenceMap(
    owned
      .filter((r) => r.catalogCardId)
      .map((r) => ({
        catalogCardId: r.catalogCardId as string,
        dexVariantRaw: r.dexVariantRaw,
        count: qty(r.quantity),
      })),
  );
  return {
    rows: [...map.values()].map((p) => ({
      catalog_card_id: p.catalogCardId,
      dex_variant_raw: p.dexVariantRaw,
      quantity: p.count,
    })),
    fileTotal: owned.reduce((n, r) => n + qty(r.quantity), 0),
    rowCount: owned.length,
  };
}

/** What each key SHOULD hold: Dex's quantity minus what she removed, floored at zero — the import's rule. */
export function expectedByKey(
  record: readonly DexRecordRow[],
  removed: readonly RemovedPresence[],
): Map<string, number> {
  const dex = toPresenceMap(
    record.map((r) => ({
      catalogCardId: r.catalog_card_id,
      dexVariantRaw: r.dex_variant_raw,
      count: r.quantity,
    })),
  );
  // `fullExport: false`: this is a check, not an import — it must never decide to forget a memory.
  const { desired } = applyRemovedMemory(dex, removed, false);
  return new Map([...desired].map(([k, v]) => [k, v.count]));
}

/** One card that does not add up, in the terms the Sync page names it. */
export interface CountMismatch {
  catalogCardId: string;
  dexVariantRaw: string;
  /** What Dex says she owns (raw, before removals). */
  dex: number;
  /** Copies she removed while Dex still lists the card. */
  removed: number;
  /** Copies the app holds for this card and variant. */
  have: number;
  /** max(0, dex − removed). */
  expected: number;
  direction: "extra" | "missing";
}

export interface CountCheckInput {
  header: { fileTotal: number; rowCount: number; importedAt: string } | null;
  record: readonly DexRecordRow[];
  removed: readonly RemovedPresence[];
  /** Copies per presence group key. */
  groups: readonly { catalogCardId: string; dexVariantRaw: string; copies: number }[];
  /** Copies with no presence group: no key, so invisible to an import — named separately. */
  ungroupedCopies: number;
  waitingQuantity: number;
  dismissedQuantity: number;
}

export interface CountCheck {
  /** `none` until her first import after 0022 has written a record. */
  status: "none" | "ok" | "mismatch";
  fileTotal: number;
  /** Copies in presence groups — the cards the collection holds against Dex. */
  inCollection: number;
  waiting: number;
  dismissed: number;
  /** Removals that count against Dex's quantity (a removal can never subtract past zero). */
  removed: number;
  /** file = Σ record + waiting + dismissed: the record itself has not drifted from the file. */
  fileAddsUp: boolean;
  mismatches: CountMismatch[];
  ungroupedCopies: number;
}

/** The whole check, at rest: the headline sum and every card that disagrees. */
export function computeCountCheck(input: CountCheckInput): CountCheck {
  const inCollection = input.groups.reduce((n, g) => n + g.copies, 0);
  if (!input.header) {
    return {
      status: "none",
      fileTotal: 0,
      inCollection,
      waiting: input.waitingQuantity,
      dismissed: input.dismissedQuantity,
      removed: 0,
      fileAddsUp: true,
      mismatches: [],
      ungroupedCopies: input.ungroupedCopies,
    };
  }

  const expected = expectedByKey(input.record, input.removed);
  const dexByKey = new Map(
    input.record.map((r) => [presenceKey(r.catalog_card_id, r.dex_variant_raw), r.quantity]),
  );
  const removedByKey = new Map(
    input.removed.map((r) => [presenceKey(r.catalogCardId, r.dexVariantRaw), r.count]),
  );
  const haveByKey = new Map<string, number>();
  const keyParts = new Map<string, { catalogCardId: string; dexVariantRaw: string }>();
  for (const g of input.groups) {
    const k = presenceKey(g.catalogCardId, g.dexVariantRaw);
    haveByKey.set(k, (haveByKey.get(k) ?? 0) + g.copies);
    keyParts.set(k, { catalogCardId: g.catalogCardId, dexVariantRaw: g.dexVariantRaw });
  }
  for (const r of input.record) {
    keyParts.set(presenceKey(r.catalog_card_id, r.dex_variant_raw), {
      catalogCardId: r.catalog_card_id,
      dexVariantRaw: r.dex_variant_raw,
    });
  }

  const mismatches: CountMismatch[] = [];
  let removedCounted = 0;
  for (const [k, parts] of keyParts) {
    const dex = dexByKey.get(k) ?? 0;
    const removed = removedByKey.get(k) ?? 0;
    removedCounted += Math.min(dex, removed);
    const want = expected.get(k) ?? 0;
    const have = haveByKey.get(k) ?? 0;
    if (have !== want) {
      mismatches.push({
        ...parts,
        dex,
        removed,
        have,
        expected: want,
        direction: have > want ? "extra" : "missing",
      });
    }
  }
  mismatches.sort((a, b) =>
    a.catalogCardId === b.catalogCardId
      ? a.dexVariantRaw.localeCompare(b.dexVariantRaw)
      : a.catalogCardId.localeCompare(b.catalogCardId),
  );

  const recordTotal = input.record.reduce((n, r) => n + r.quantity, 0);
  const fileAddsUp =
    input.header.fileTotal === recordTotal + input.waitingQuantity + input.dismissedQuantity;

  return {
    status:
      mismatches.length === 0 && fileAddsUp && input.ungroupedCopies === 0 ? "ok" : "mismatch",
    fileTotal: input.header.fileTotal,
    inCollection,
    waiting: input.waitingQuantity,
    dismissed: input.dismissedQuantity,
    removed: removedCounted,
    fileAddsUp,
    mismatches,
    ungroupedCopies: input.ungroupedCopies,
  };
}

/* --------------------------------- the refusal --------------------------------- */

/** One key the database refused, straight from `assert_presence_counts`'s DETAIL. */
export interface RefusedKey extends PresenceKeyRef {
  dex: number;
  removed: number;
  have: number;
}

/** A card named for her: what the catalog calls it. */
export interface CardLabel {
  name: string;
  setName: string | null;
  localId: string | null;
}

/**
 * A sync write the database refused because it would not add up (UIL-100). Nothing was written. The message
 * names the cards in her words, says extra or missing, and says what to do next — never a dead end.
 */
export class CountMismatchError extends Error {
  readonly keys: RefusedKey[];
  readonly total: number;

  constructor(keys: RefusedKey[], total: number, labels: Map<string, CardLabel>, nextStep: string) {
    super(describeRefusal(keys, total, labels, nextStep));
    this.name = "CountMismatchError";
    this.keys = keys;
    this.total = total;
  }
}

/**
 * What she is told when the record and the queue no longer add up to the file (0024), in the SAME words the
 * Sync page uses at rest — so she never meets a refusal the page did not already warn her about.
 */
export const FILE_TOTAL_REMEDY = "Import your Dex file again to refresh the record.";

/**
 * A sync write the database refused because the file total would no longer add up (0024): the record would
 * grow without the same quantity leaving the queue — a card from her Dex file counted twice. Nothing was
 * written.
 */
export class FileTotalMismatchError extends Error {
  readonly fileTotal: number;
  readonly record: number;
  readonly queued: number;

  constructor(fileTotal: number, record: number, queued: number) {
    super(
      `Nothing was saved: this would count a card from your Dex file twice. ${FILE_TOTAL_REMEDY}`,
    );
    this.name = "FileTotalMismatchError";
    this.fileTotal = fileTotal;
    this.record = record;
    this.queued = queued;
  }
}

/** Is this RPC error 0024's file-total refusal? Returns its figures, or null for any other error. */
export function parseFileTotalRefusal(
  err: unknown,
): { fileTotal: number; record: number; queued: number } | null {
  const e = err as { message?: unknown; details?: unknown; detail?: unknown } | null;
  if (!e || typeof e.message !== "string" || !/file total check failed/.test(e.message))
    return null;
  const raw =
    typeof e.details === "string" ? e.details : typeof e.detail === "string" ? e.detail : "{}";
  try {
    const d = JSON.parse(raw) as { file_total?: number; record?: number; queued?: number };
    return { fileTotal: d.file_total ?? 0, record: d.record ?? 0, queued: d.queued ?? 0 };
  } catch {
    return { fileTotal: 0, record: 0, queued: 0 };
  }
}

/** Is this RPC error the count check's refusal? Returns the refused keys, or null for any other error. */
export function parseCountRefusal(err: unknown): { keys: RefusedKey[]; total: number } | null {
  const e = err as { message?: unknown; details?: unknown; detail?: unknown } | null;
  if (!e || typeof e.message !== "string") return null;
  const m = /presence count check failed on (\d+) key/.exec(e.message);
  if (!m) return null;
  const raw =
    typeof e.details === "string" ? e.details : typeof e.detail === "string" ? e.detail : "[]";
  let keys: RefusedKey[] = [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) keys = parsed as RefusedKey[];
  } catch {
    keys = [];
  }
  return { keys, total: Number(m[1]) };
}

function describeRefusal(
  keys: readonly RefusedKey[],
  total: number,
  labels: Map<string, CardLabel>,
  nextStep: string,
): string {
  const lines = keys.slice(0, 10).map((k) => {
    const label = labels.get(k.catalog_card_id);
    const where = label
      ? [label.name, [label.setName, label.localId].filter(Boolean).join(" ")]
          .filter(Boolean)
          .join(", ")
      : k.catalog_card_id;
    const want = Math.max(0, k.dex - k.removed);
    const dir = k.have > want ? "extra" : "missing";
    const removedNote = k.removed > 0 ? `, you removed ${k.removed}` : "";
    return `${where} (${k.dex_variant_raw}): Dex says ${k.dex}${removedNote}, this would leave ${k.have} (${dir})`;
  });
  const more = total > lines.length ? ` …and ${total - lines.length} more.` : "";
  return (
    `Nothing was changed: this would make your collection disagree with your Dex file. ` +
    `${lines.join("; ")}.${more} ${nextStep}`
  );
}

/* ------------------------------ what the Sync page shows ------------------------------ */

/** A mismatch with the card named, for the panel. */
export interface NamedCountMismatch extends CountMismatch {
  name: string;
  setName: string | null;
  localId: string | null;
}

/** The check as the Sync page renders it: the sum, and every card that does not add up, named. */
export interface CountCheckView extends Omit<CountCheck, "mismatches"> {
  mismatches: NamedCountMismatch[];
  /** When the file this check is against was imported; null before her first import after 0022. */
  importedAt: string | null;
}

/** The check before her first recorded import — also the neutral value for screen fixtures. */
export function emptyCountCheck(): CountCheckView {
  return {
    status: "none",
    fileTotal: 0,
    inCollection: 0,
    waiting: 0,
    dismissed: 0,
    removed: 0,
    fileAddsUp: true,
    mismatches: [],
    ungroupedCopies: 0,
    importedAt: null,
  };
}
