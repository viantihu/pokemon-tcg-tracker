/**
 * Sync pipeline orchestration (docs/sync-ui-spec.md §A.5, §B.1–§B.2; sync-architecture §1.7). I/O
 * ALLOWED — reads the mirror + current state through `lib/repo`, then calls the FROZEN pure engine
 * (`reconcile`) and the M9 pure layers (`buildPreview`). It does NOT mutate; it produces the plan
 * bundle the executor applies and the view-model the screen renders.
 *
 * Two modes share one path:
 *   - IMPORT  (a CSV): desired presence comes from the export; WAITING entries are reconciled
 *     against it — an entry whose row now resolves is archived (its cards are counted via the CSV
 *     ADDED, never double-counted), an entry the export dropped is silently removed (A.7).
 *   - RETRY   (no CSV): each WAITING entry is re-resolved against the refreshed catalog + learned
 *     aliases; a hit is promoted as an ADDED (self-heal, A.5) and the entry archived.
 */
import { normalizeLocale } from "@/lib/catalog/locale";
import type { DbClient, Row } from "@/lib/repo";
import {
  binderRepo,
  catalogCardRepo,
  colorBandRepo,
  copyRepo,
  dexPresenceRepo,
  lastSyncSnapshotRepo,
  presenceGroupRepo,
  removedPresenceRepo,
  setAliasRepo,
  typeColorMapRepo,
  unresolvedEntryRepo,
} from "@/lib/repo";
import { band, type Role } from "@/lib/engine";
import { toCatalogCard } from "@/lib/plan";
import { decodeDexCsv, filterOwned, parseDexCsv } from "./csv";
import { resolveDexId, SET_ALIAS_SEED } from "./resolve";
import { createPrefetchedCatalogLookup } from "./catalog-lookup";
import {
  reconcile,
  type CurrentGroup,
  type ReconcilePlan,
  type ResolvedRow,
  type UnresolvedRow,
} from "./reconcile";
import type { DexRow } from "./types";
import type { RemovedPresence } from "./diff";
import { latestSnapshotId } from "./apply-guard";
import { dexRecordFromRows, type DexRecord } from "./count-check";
import type { DexRecordRow } from "@/lib/repo/write-ops";
import type { SyncCounts } from "./undo";
import { buildPreview, type CardMeta, type PreviewEnrichment, type SyncPreview } from "./preview";

export type SyncMode = "import" | "retry";

/** The serializable bundle the preview hands to `applySync` — everything the executor needs. */
export interface SyncPlanBundle {
  mode: SyncMode;
  /**
   * The collection's sync state when this preview was computed: the latest undo snapshot's id, or null when
   * she has never synced (UIL-099 E5). The apply refuses unless it is still the latest, so a second tab, a
   * double click or a retry cannot apply one preview twice. See lib/sync/apply-guard.ts.
   */
  baseSnapshotId: string | null;
  /**
   * What this IMPORT's file says, for the Dex record (UIL-100): replaces the record in the apply's
   * transaction. Null/absent on a retry, which only ADDS the rows it promotes (`dexAdds`).
   */
  dexRecord?: DexRecord | null;
  /** The rows a RETRY promotes into the record (UIL-100); empty on an import. */
  dexAdds?: DexRecordRow[];
  plan: ReconcilePlan;
  current: CurrentGroup[];
  queue: {
    /** CSV rows still unresolved this sync — upserted (deduped on rawKey) at apply. */
    parks: UnresolvedRow[];
    /** WAITING entries to mark RESOLVED (their cards now counted via an ADDED create). */
    archiveEntryIds: string[];
    /** WAITING entries the export no longer contains — dropped silently at apply (A.7). */
    dropEntryIds: string[];
    /** Count of cards still waiting on the catalog after this sync. */
    stillWaiting: number;
  };
  counts: SyncCounts;
}

export interface SyncRun {
  bundle: SyncPlanBundle;
  preview: SyncPreview;
}

// NUL separator as an escape, not a raw byte (see lib/sync/diff.ts presenceKey for why).
const key = (dexId: string, variantRaw: string) => `${dexId}\u0000${variantRaw}`;

function toResolvedRow(
  r: DexRow,
  catalogCardId: string | null,
  reason?: ResolvedRow["reason"],
): ResolvedRow {
  return {
    type: r.Type,
    catalogCardId,
    dexVariantRaw: r.Variant,
    quantity: parseQuantity(r.Quantity),
    reason,
    raw: {
      dexId: r.Id,
      setName: r.Set,
      series: r.Series,
      number: r.Number,
      name: r.Name,
      locale: r.Locale,
    },
  };
}

/** ~safe quantity parse; a blank or garbage cell counts as one copy (never negative). */
export function parseQuantity(raw: string): number {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** SET_ALIAS_SEED plus persisted learned aliases, keyed `${locale}:${dexCode}`. */
export async function loadAliasMap(db: DbClient): Promise<Record<string, string>> {
  const learned = await setAliasRepo.list(db);
  const map: Record<string, string> = { ...SET_ALIAS_SEED };
  for (const a of learned) map[`${a.locale}:${a.dex_code}`] = a.tcgdex_set_id;
  return map;
}

/**
 * Current presence groups with each copy's placement snapshot (the reconciler's `current`).
 *
 * Paged rather than a single page (UIL-031): a truncated read here is not merely incomplete, it is
 * WRONG — the reconciler would conclude she owns fewer copies than she does and add duplicates for
 * cards she already has. `list()`'s cap-detection guard (UIL-031) would only turn that into a thrown
 * error; `listAll` avoids the truncation happening at all, which is what this path actually needs.
 */
export async function loadCurrentGroups(db: DbClient): Promise<CurrentGroup[]> {
  const [groups, copies] = await Promise.all([presenceGroupRepo.listAll(db), copyRepo.listAll(db)]);
  const byGroup = new Map<string, Row<"copy">[]>();
  for (const c of copies) {
    if (!c.presence_group_id) continue;
    const list = byGroup.get(c.presence_group_id) ?? [];
    list.push(c);
    byGroup.set(c.presence_group_id, list);
  }
  return groups.map((g) => ({
    catalogCardId: g.catalog_card_id,
    dexVariantRaw: g.dex_variant_raw,
    copies: (byGroup.get(g.id) ?? []).map((c) => ({
      copyId: c.id,
      // `Role`, not a hand-written union: the literal list here silently went stale when UIL-088
      // added 'haul', so the cast was asserting something untrue of rows flowing through it (UIL-093).
      role: c.role as Role,
      binderId: c.binder_id,
      binderHalf: c.binder_half as "front" | "back" | null,
      colorBand: c.color_band,
      lineSlotId: c.line_slot_id,
      createdAt: c.created_at,
    })),
  }));
}

/** Rebuild the minimal Dex row a WAITING entry needs to be re-resolved on a retry. */
export function entryAsDexRow(e: Row<"unresolved_entry">): Pick<DexRow, "Id" | "Locale" | "Set"> {
  return {
    Id: e.dex_id,
    Locale: normalizeLocale(e.locale) === "ja" ? "Japanese" : (e.locale ?? ""),
    Set: e.dex_set_name ?? "",
  };
}

/**
 * Run the full pipeline for an import (CSV bytes) or a retry-only sweep (bytes = null). Reads state,
 * calls the frozen reconciler, and returns the apply bundle + the rendered preview.
 */
export async function runSyncPipeline(db: DbClient, bytes: Uint8Array | null): Promise<SyncRun> {
  const mode: SyncMode = bytes ? "import" : "retry";
  /**
   * The sync state this preview is computed against (UIL-099 E5) — read FIRST, strictly before any state the
   * plan is built from (the Tech Lead's B2). Read after, an apply landing between the two reads would pair a
   * pre-apply plan with a post-apply base, pass the freshness check and apply stale `creates`. Read before,
   * the same interleaving pairs an OLD base with a newer plan, which is refused: the ordering errs safe.
   * Awaited on its own, not folded into the `Promise.all` below, because that order is the whole point.
   */
  const baseSnapshotId = latestSnapshotId(await lastSyncSnapshotRepo.list(db));
  const [aliasMap, waiting, current, manualMatches] = await Promise.all([
    loadAliasMap(db),
    unresolvedEntryRepo.listWaiting(db),
    loadCurrentGroups(db),
    bytes ? unresolvedEntryRepo.listManualMatches(db) : Promise.resolve([]),
  ]);
  // UIL-089: copies she removed that Dex still lists, subtracted from desired presence below so a card she
  // traded away is not handed back on every sync. Read separately rather than added to the tuple above:
  // that `Promise.all` already mixes a conditional `Promise.resolve([])` in, and a fifth element collapses
  // its tuple inference — `waiting` silently became `{}[]`, which typechecked here and would have thrown at
  // the first field access.
  const removed: RemovedPresence[] = (await removedPresenceRepo.listAll(db)).map((r) => ({
    catalogCardId: r.catalog_card_id,
    dexVariantRaw: r.dex_variant_raw,
    count: r.count,
  }));
  // UIL-082: a row she matched by hand resolves to that card FIRST, before the catalog is asked. The
  // catalog could not resolve it when she matched it and usually still cannot; without this memory
  // the next import re-parked the row as a fresh WAITING entry and, since no row then resolved to the
  // matched card, proposed retiring the very copies the match created. The match also wins when the
  // catalog later CAN resolve the row: it is her explicit override (a UIL-060 stand-in depends on
  // exactly that), released by dismissing or forgetting the entry, never by a sync.
  const manualByKey = new Map(
    manualMatches.map((e) => [key(e.dex_id, e.dex_variant_raw), e.manual_match_id as string]),
  );
  const resolvedRows: ResolvedRow[] = [];
  const archiveEntryIds: string[] = [];
  const dropEntryIds: string[] = [];

  if (bytes) {
    const dexRows = filterOwned(parseDexCsv(decodeDexCsv(bytes)));
    // `resolveDexId` is pure, so hoisting it out of the loop changes nothing except letting us know
    // every `(setId, localId)` the pass will ask for BEFORE the first query. That is what makes the
    // prefetch possible; the loop below still walks the rows one at a time, in order, so the
    // learned-alias drain within a pass is untouched (see lib/sync/catalog-lookup.ts).
    const resolvedIds = dexRows.map((r) => resolveDexId(r, aliasMap));
    const lookup = await createPrefetchedCatalogLookup(
      db,
      resolvedIds.map((r) => ({ setId: r.setId, candidates: r.localIdCandidates })),
    );

    const csvKeys = new Set<string>();
    const resolvedCsvKeys = new Set<string>();
    for (const [i, r] of dexRows.entries()) {
      const resolved = resolvedIds[i];
      const rk = key(r.Id, r.Variant);
      const manual = manualByKey.get(rk);
      const hit = manual ? { catalogCardId: manual } : await lookup(r, resolved);
      csvKeys.add(rk);
      if (hit.catalogCardId) resolvedCsvKeys.add(rk);
      resolvedRows.push(toResolvedRow(r, hit.catalogCardId, hit.reason));
    }
    // Reconcile the queue against this export.
    for (const e of waiting) {
      const rk = key(e.dex_id, e.dex_variant_raw);
      if (resolvedCsvKeys.has(rk)) archiveEntryIds.push(e.id);
      else if (!csvKeys.has(rk)) dropEntryIds.push(e.id);
      // still-unresolved-in-CSV → dedupe-updated via `parks` at apply.
    }
  } else {
    // Retry-only: promote every WAITING entry that now resolves (self-heal, A.5). Same prefetch, same
    // serial walk — a retry sweep over a large queue paid the identical per-row round trip.
    const retryRows = waiting.map((e) => entryAsDexRow(e));
    const retryResolved = retryRows.map((row) => resolveDexId(row, aliasMap));
    const lookup = await createPrefetchedCatalogLookup(
      db,
      retryResolved.map((r) => ({ setId: r.setId, candidates: r.localIdCandidates })),
    );
    for (const [i, e] of waiting.entries()) {
      const row = retryRows[i];
      const resolved = retryResolved[i];
      const hit = await lookup(row, resolved);
      if (hit.catalogCardId) {
        resolvedRows.push({
          type: "collection",
          catalogCardId: hit.catalogCardId,
          dexVariantRaw: e.dex_variant_raw,
          quantity: e.quantity,
          raw: {
            dexId: e.dex_id,
            setName: e.dex_set_name ?? "",
            series: e.dex_series ?? "",
            number: e.dex_number ?? "",
            name: e.dex_name ?? "",
            locale: e.locale ?? "",
          },
        });
        archiveEntryIds.push(e.id);
      }
    }
  }

  /**
   * A RETRY's desired count for a key is what the Dex record ALREADY holds for it plus the row it promotes
   * (UIL-100). Without the record term, a promoted row whose key another Dex row already fills read as
   * "desired = this row only", and the diff retired the other row's copies — unreviewed, since a retry
   * applies with no preview (the Tech Lead's card-entry audit, finding 3). The record is exactly that other
   * row's quantity, so adding it back makes the retry purely additive, as it was always meant to be.
   * Before her first recorded import the record is empty and nothing changes.
   */
  const dexAdds: DexRecordRow[] = [];
  if (!bytes && resolvedRows.length > 0) {
    const promoted = dexRecordFromRows(resolvedRows);
    dexAdds.push(...promoted.rows);
    const recordByKey = new Map(
      (await dexPresenceRepo.listAll(db)).map((r) => [
        key(r.catalog_card_id, r.dex_variant_raw),
        r,
      ]),
    );
    for (const add of promoted.rows) {
      const existing = recordByKey.get(key(add.catalog_card_id, add.dex_variant_raw));
      if (!existing) continue;
      resolvedRows.push({
        type: "collection",
        catalogCardId: existing.catalog_card_id,
        dexVariantRaw: existing.dex_variant_raw,
        quantity: existing.quantity,
        raw: { dexId: "", setName: "", series: "", number: "", name: "", locale: "" },
      });
    }
  }

  // An IMPORT is a full-snapshot reconciliation (a card gone from the export is a real REMOVED). A
  // RETRY is purely additive — it must NOT diff against the whole collection, or every card the tiny
  // promoted set omits would classify REMOVED. So retry reconciles only against the promoted keys
  // (normally empty current, since a WAITING card never has a placed copy — A.6).
  const reconcileCurrent = bytes
    ? current
    : (() => {
        const promotedKeys = new Set(
          resolvedRows.map((r) => key(r.catalogCardId ?? "", r.dexVariantRaw)),
        );
        return current.filter((g) => promotedKeys.has(key(g.catalogCardId, g.dexVariantRaw)));
      })();

  const plan = reconcile({
    rows: resolvedRows,
    current: reconcileCurrent,
    clock: () => new Date(),
    removed,
    // Only a WHOLE export is evidence that Dex has stopped listing a key. A retry reconciles against the
    // handful of keys it just promoted, so "absent from desired" there would forget every memory she has
    // (UIL-089; `applyRemovedMemory` states the same gate from the other side).
    fullExport: bytes !== null,
  });
  const parks = plan.unresolved;

  // Classify parks against existing WAITING for the no-op check: benign retry-bumps of an identical
  // unresolved row are NOT a collection change (idempotent re-import stays a no-op).
  const waitingByKey = new Map(waiting.map((e) => [key(e.dex_id, e.dex_variant_raw), e]));
  // A row she dismissed stays dismissed when the file lists it again (lib/sync/exec.ts refreshes it in place),
  // so it is neither a new waiting card nor one still waiting — only an import reads this.
  const dismissedKeys = bytes
    ? new Set(
        (await unresolvedEntryRepo.listDismissed(db)).map((e) => key(e.dex_id, e.dex_variant_raw)),
      )
    : new Set<string>();
  let newParks = 0;
  let meaningfulUpdates = 0;
  const parkKeys = new Set<string>();
  for (const p of parks) {
    const rk = key(p.dexId, p.dexVariantRaw);
    if (dismissedKeys.has(rk)) continue;
    parkKeys.add(rk);
    const prior = waitingByKey.get(rk);
    if (!prior) newParks += 1;
    else if (prior.quantity !== p.quantity || prior.reason !== p.reason) meaningfulUpdates += 1;
  }

  const stillWaiting = bytes ? parkKeys.size : waiting.length - archiveEntryIds.length;

  const counts: SyncCounts = {
    creates: plan.creates.length,
    retires: plan.retires.length,
    variantUpdates: plan.variantUpdates.length,
    parks: newParks,
    drops: dropEntryIds.length,
    promotions: archiveEntryIds.length,
    dedupeUpdates: meaningfulUpdates,
    unchanged: plan.unchanged,
  };

  const bundle: SyncPlanBundle = {
    mode,
    baseSnapshotId,
    // Built from the rows BEFORE any retry augmentation above, which only ever runs without bytes.
    dexRecord: bytes ? dexRecordFromRows(resolvedRows) : null,
    dexAdds,
    plan,
    current: reconcileCurrent,
    queue: { parks, archiveEntryIds, dropEntryIds, stillWaiting },
    counts,
  };

  const enrichment = await loadEnrichment(db, plan, reconcileCurrent, parks, stillWaiting, counts);
  const preview = buildPreview(plan, enrichment);

  return { bundle, preview };
}

/** Join catalog display facts + placement labels for the cards/copies the plan touches. */
async function loadEnrichment(
  db: DbClient,
  plan: ReconcilePlan,
  current: CurrentGroup[],
  parks: UnresolvedRow[],
  stillWaiting: number,
  counts: SyncCounts,
): Promise<PreviewEnrichment> {
  const cardIds = new Set<string>();
  for (const c of plan.creates) cardIds.add(c.catalogCardId);
  for (const r of plan.retires) cardIds.add(r.catalogCardId);
  for (const v of plan.variantUpdates) cardIds.add(v.catalogCardId);

  const [cards, binders, bands, typeMapRows] = await Promise.all([
    Promise.all([...cardIds].map((id) => catalogCardRepo.getByPk(db, id))),
    binderRepo.list(db),
    colorBandRepo.listOrdered(db),
    typeColorMapRepo.list(db),
  ]);

  const binderNameById = new Map(binders.map((b) => [b.id, b.name]));
  const bandDisplayByKey = new Map(bands.map((b) => [b.band, b.display_name]));
  const typeColorMap: Record<string, string> = {};
  for (const t of typeMapRows) typeColorMap[t.card_type] = t.band;

  const cardMetaById: Record<string, CardMeta> = {};
  for (const row of cards) {
    if (!row) continue;
    cardMetaById[row.tcgdex_id] = {
      name: row.name,
      imageUrl: row.image_url,
      localId: row.local_id,
      setCardCountOfficial: row.set_card_count_official,
      bandKey: band(toCatalogCard(row), typeColorMap) ?? "white",
    };
  }

  // Placement label per copyId + the per-group copy list (for the which-copy-left override).
  const placementByCopyId: Record<string, string> = {};
  const groupCopies: Record<string, { copyId: string; label: string }[]> = {};
  for (const g of current) {
    const gKey = `${g.catalogCardId} ${g.dexVariantRaw}`;
    const list: { copyId: string; label: string }[] = [];
    for (const c of g.copies) {
      const binderName = c.binderId ? (binderNameById.get(c.binderId) ?? "Binder") : null;
      const bandDisplay = c.colorBand ? (bandDisplayByKey.get(c.colorBand) ?? c.colorBand) : null;
      let label: string;
      if (c.role === "block") label = "binder block";
      else if (c.lineSlotId)
        label = [binderName, c.binderHalf, "line slot"].filter(Boolean).join(" · ");
      else if (c.role === "shelved" && c.binderId)
        label = [binderName, c.binderHalf, bandDisplay].filter(Boolean).join(" · ");
      else if (c.role === "bulk") label = "bulk box";
      else label = "unplaced";
      placementByCopyId[c.copyId] = label;
      list.push({ copyId: c.copyId, label });
    }
    groupCopies[gKey] = list;
  }

  return { cardMetaById, placementByCopyId, groupCopies, newParks: parks, stillWaiting, counts };
}
