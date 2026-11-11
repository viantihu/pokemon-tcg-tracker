/**
 * The Sync preview's two removal questions, as view logic (Karvi, 2026-11-11). PURE — the screen holds the
 * state, this decides what it means, so it is testable without a DOM (the project's UI-test convention).
 *
 *   "Where did this one leave from?" — asked per removed copy when the copies sit in more than one place.
 *   "Pull one from a bulk box to fill its spot?" — offered when the copy left a binder pocket or line slot and a
 *   duplicate is in bulk. Optional: unanswered means no.
 *
 * The server checks the same rules again (`unansweredRemovals`, `resolveBulkPulls`); this module only keeps the
 * screen from offering an Apply the server would refuse.
 */
import type { SyncOverrides } from "./apply";
import type { RefillOption, RemovalRow, SyncPreview } from "./preview";

/** One removal row's place among its key's rows (0 for the first copy of a card that leaves). */
export function rowIndexes(rows: readonly Pick<RemovalRow, "presenceKey">[]): number[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const i = seen.get(r.presenceKey) ?? 0;
    seen.set(r.presenceKey, i + 1);
    return i;
  });
}

export function isAsked(preview: SyncPreview, key: string): boolean {
  return preview.removalAsks?.[key]?.ambiguous ?? false;
}

/** Her answer for one row ("" = not answered yet). */
export function answerFor(overrides: SyncOverrides, key: string, index: number): string {
  return overrides.retireChoice?.[key]?.[index] ?? "";
}

/** Record her answer for one row, keeping the key's other rows' answers. */
export function pickWhere(
  preview: SyncPreview,
  overrides: SyncOverrides,
  key: string,
  index: number,
  copyId: string,
): SyncOverrides {
  const leaving = preview.removalAsks?.[key]?.leaving ?? 1;
  const prev = overrides.retireChoice?.[key] ?? [];
  const next = Array.from({ length: leaving }, (_, i) => (i === index ? copyId : (prev[i] ?? "")));
  return { ...overrides, retireChoice: { ...(overrides.retireChoice ?? {}), [key]: next } };
}

/**
 * The place choices for one row: one entry per PLACE (copies in the same place are interchangeable, so the
 * label is listed once), never a copy another row of the same card already picked.
 */
export function whereOptions(
  preview: SyncPreview,
  overrides: SyncOverrides,
  key: string,
  index: number,
): { copyId: string; label: string }[] {
  const taken = new Set((overrides.retireChoice?.[key] ?? []).filter((id, i) => id && i !== index));
  const mine = answerFor(overrides, key, index);
  const byLabel = new Map<string, string>();
  for (const o of preview.removalAsks?.[key]?.options ?? []) {
    if (taken.has(o.copyId)) continue;
    const label = o.label || "Not placed yet";
    // First copy in a place stands for it — unless her current pick is another copy there.
    if (!byLabel.has(label) || o.copyId === mine) byLabel.set(label, o.copyId);
  }
  return [...byLabel].map(([label, copyId]) => ({ copyId, label }));
}

/** The copy this row says left: her answer when asked, else the one the app already knows. */
export function leavingCopyFor(
  preview: SyncPreview,
  overrides: SyncOverrides,
  row: Pick<RemovalRow, "presenceKey" | "copyId">,
  index: number,
): string {
  return isAsked(preview, row.presenceKey)
    ? answerFor(overrides, row.presenceKey, index)
    : row.copyId;
}

/** Every copy leaving this sync, as her answers stand. */
function leavingIds(preview: SyncPreview, overrides: SyncOverrides): Set<string> {
  const rows = preview.sections.removals;
  const idx = rowIndexes(rows);
  return new Set(rows.map((r, i) => leavingCopyFor(preview, overrides, r, idx[i])).filter(Boolean));
}

/**
 * The refill offer for one row, or null when there is none: the copy that left must have held a binder pocket or
 * a line slot, and a bulk duplicate must be free (not leaving, not already pulled for another row).
 */
export function refillOffer(
  preview: SyncPreview,
  overrides: SyncOverrides,
  row: Pick<RemovalRow, "presenceKey" | "copyId" | "consequence">,
  index: number,
): { retiredCopyId: string; options: RefillOption[] } | null {
  const retiredCopyId = leavingCopyFor(preview, overrides, row, index);
  if (!retiredCopyId) return null;
  const ask = preview.removalAsks?.[row.presenceKey];
  const option = ask?.options.find((o) => o.copyId === retiredCopyId);
  const refillable = option
    ? option.refillable
    : row.consequence === "shelved-cleared" || row.consequence === "line-slot-freed";
  if (!refillable) return null;
  const leaving = leavingIds(preview, overrides);
  const pulledElsewhere = new Set(
    Object.entries(overrides.bulkPulls ?? {})
      .filter(([retired]) => retired !== retiredCopyId)
      .map(([, bulk]) => bulk),
  );
  const options = (preview.refillOptions?.[row.presenceKey] ?? []).filter(
    (o) => !leaving.has(o.copyId) && !pulledElsewhere.has(o.copyId),
  );
  return options.length > 0 ? { retiredCopyId, options } : null;
}

/** Record her refill answer for one departed copy ("" = no, leave it in the box). */
export function pickRefill(
  overrides: SyncOverrides,
  retiredCopyId: string,
  bulkCopyId: string,
): SyncOverrides {
  const next = { ...(overrides.bulkPulls ?? {}) };
  if (bulkCopyId) next[retiredCopyId] = bulkCopyId;
  else delete next[retiredCopyId];
  return { ...overrides, bulkPulls: next };
}

/** Rows whose "where did it leave from?" is still unanswered. Apply waits while this is above zero. */
export function unansweredCount(preview: SyncPreview, overrides: SyncOverrides): number {
  const rows = preview.sections.removals;
  const idx = rowIndexes(rows);
  return rows.filter(
    (r, i) => isAsked(preview, r.presenceKey) && !answerFor(overrides, r.presenceKey, idx[i]),
  ).length;
}

/**
 * The overrides to send: only the answers that still apply. A refill for a copy she later said did NOT leave,
 * or for a bulk copy she then said DID leave, is dropped here so a changed mind is never refused by the server.
 */
export function overridesToSend(preview: SyncPreview, overrides: SyncOverrides): SyncOverrides {
  const leaving = leavingIds(preview, overrides);
  const rows = preview.sections.removals;
  const idx = rowIndexes(rows);
  const offered = new Map<string, Set<string>>();
  rows.forEach((r, i) => {
    const offer = refillOffer(preview, overrides, r, idx[i]);
    if (offer) offered.set(offer.retiredCopyId, new Set(offer.options.map((o) => o.copyId)));
  });
  const bulkPulls: Record<string, string> = {};
  for (const [retired, bulk] of Object.entries(overrides.bulkPulls ?? {})) {
    if (leaving.has(retired) && offered.get(retired)?.has(bulk)) bulkPulls[retired] = bulk;
  }
  return { ...overrides, bulkPulls };
}
