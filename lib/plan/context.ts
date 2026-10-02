import type { BlockNeedCandidate } from "@/lib/line/types";
import { isOpenBlockNeed } from "@/lib/line/move";
import { bulkUnitForRoute, bulkUnitViews, type BulkUnitView } from "./bulk-units";
/**
 * Load the M3 engine context from the DB and run the cascade over a haul draft (dev-spec §5 M6).
 *
 * All the I/O for M6's cascade run lives here so the engine stays pure and the server actions stay
 * thin. Reads go through `lib/repo`. NOTE (perf, phase-1): the whole `catalog_card` mirror is loaded
 * for chain-building and alternate ranking. Locally the mirror holds only the seeded cards so this
 * is trivial; against a full ~23.5k mirror a production build should scope the query to the haul's
 * dexId neighbourhoods. Flagged, not premature-optimised.
 */

import { formatCollectorNumber } from "@/lib/catalog/collector-number";
import { localeOfId } from "@/lib/catalog/locale";
import {
  formOf,
  formsALine,
  assertBandConfig,
  band,
  lineFormOf,
  nameInForm,
  placeCard,
  type CardForm,
  type CascadeResult,
  type CatalogCard,
  type EngineContext,
  type EvolutionLine,
  type IncomingCard,
  type Variant,
} from "@/lib/engine";
import {
  binderRepo,
  binderSectionRepo,
  collectionRepo,
  colorBandRepo,
  copyRepo,
  evolutionLineRepo,
  lineSlotRepo,
  typeColorMapRepo,
  type DbClient,
  type Row,
  binderBlockRepo,
  bulkUnitRepo,
} from "@/lib/repo";
import { loadCatalogCached } from "./catalog-cache";
import { toBinder, toCatalogCard, toCollection, toEvolutionLine, toOwnedCopy } from "./adapt";
import { toPlanItem, type AssembleLookups } from "./assemble";
import type { PlanItem, PlannedCard } from "./types";

export interface DraftItem {
  id: string;
  tcgdexId: string;
  variant: Variant;
  /**
   * Set when this draft entry is an EXISTING unplaced `copy` row being routed rather than a new card
   * being taken in (UIL-003; see lib/plan/pending.ts). The commit then updates that row's placement
   * instead of inserting a second copy of the same physical card. Absent for typed intake.
   */
  existingCopyId?: string | null;
}

export interface PlanContext {
  ctx: EngineContext;
  catalogById: Map<string, CatalogCard>;
  copyRowById: Map<string, Row<"copy">>;
  /** Raw line_slot rows grouped by line id — the commit's write set resolves slot fills against this
   *  snapshot (M10; lib/plan/commit.ts) instead of re-reading the DB mid-commit. */
  slotRowsByLine: Map<string, Row<"line_slot">[]>;
  orderedBandKeys: string[];
  lookups: AssembleLookups;
  /**
   * UIL-030: every OPEN binder-block need — a block slot with no line-terminated binder_block backing it
   * — with what the Move panel needs to list it. `ctx.openBlockNeeds` is this list's length.
   */
  blockNeeds?: BlockNeedCandidate[];
  /**
   * UIL-130: her bulk boxes, with how many cards each holds. Where the plan sends a card to bulk on its own, it names
   * the box `bulkUnitForRoute` picks (lib/plan/bulk-units.ts). Absent (an older test context): the database gives the
   * card her default box.
   */
  bulkUnits?: BulkUnitView[];
}

export interface LoadPlanContextOptions {
  /**
   * Copy ids to withhold from `ctx.owned` — the existing copies this pass is about to ROUTE
   * (UIL-003). They are the incoming stack, not the established collection, so the cascade must not
   * also see them as already-owned: a copy left in `owned` could be pulled into another card's new
   * line while its own draft entry is separately placing it, producing two conflicting writes for one
   * row. Withholding them makes routing pending copies produce exactly the plan a freshly-typed haul
   * of the same cards would produce, which is the invariant the tests pin.
   *
   * They stay in `copyRowById` (the commit still needs their rows).
   */
  excludeOwnedCopyIds?: Iterable<string>;
}

/** Load every table the cascade reads and assemble a ready-to-run `EngineContext` + lookups. */
export async function loadPlanContext(
  db: DbClient,
  options: LoadPlanContextOptions = {},
): Promise<PlanContext> {
  const [
    catalogRows,
    copyRows,
    binderRows,
    lineRows,
    slotRows,
    collectionRows,
    typeMapRows,
    bandRows,
    sectionRows,
    blockRows,
    bulkUnitRows,
  ] = await Promise.all([
    // `listAll`, not `list`: these tables scale with the collection and the mirror (~23.5k catalog
    // rows), and a single `select *` is silently capped at the server's `max-rows` (1000). A
    // truncated catalog would quietly break chain-building, viability and alternate ranking.
    //
    // The catalog specifically comes from a process-local cache (UIL-027). Per-card commits call this
    // function once per "Done" click, and re-paging 23.5k rows each time is the cost that made the
    // per-card model unshippable. Same rows either way, so placement is unaffected — see
    // lib/plan/catalog-cache.ts for why this is cached rather than scoped.
    loadCatalogCached(db),
    copyRepo.listAll(db),
    binderRepo.list(db),
    evolutionLineRepo.listAll(db),
    lineSlotRepo.listAll(db),
    collectionRepo.list(db),
    typeColorMapRepo.list(db),
    colorBandRepo.listOrdered(db),
    binderSectionRepo.list(db),
    binderBlockRepo.list(db),
    bulkUnitRepo.listOrdered(db),
  ]);

  const catalogById = new Map<string, CatalogCard>();
  for (const r of catalogRows) catalogById.set(r.tcgdex_id, toCatalogCard(r));

  const copyRowById = new Map<string, Row<"copy">>();
  for (const r of copyRows) copyRowById.set(r.id, r);

  const excluded = new Set(options.excludeOwnedCopyIds ?? []);
  const owned = copyRows
    .filter((r) => !excluded.has(r.id))
    .map((r) => toOwnedCopy(r, catalogById))
    .filter((c): c is NonNullable<typeof c> => c !== null);

  // Back-half free-pocket hint per binder → new-line assignment (decision §3).
  const freeBackByBinder = new Map<string, number>();
  for (const s of sectionRows) {
    if (s.half === "back" && s.binder_id) freeBackByBinder.set(s.binder_id, s.free_pockets ?? 0);
  }
  const binders = binderRows.map((b) => toBinder(b, { freeBackHalf: freeBackByBinder.get(b.id) }));

  // Resolve each slot's species dexId from its filled copy or the card she CHASES there. A target on a stage she has
  // not decided is an old engine target (until D) and names nothing: such a stage is matched by the incoming card's
  // own chain instead (the cascade's `existingLineSlot`), so the other branch is not shut out (the TL's rule).
  const dexIdForSlot = (slot: Row<"line_slot">): number | null => {
    const viaCopy = slot.copy_id && copyRowById.get(slot.copy_id);
    if (viaCopy) return catalogById.get(viaCopy.catalog_card_id)?.dexId[0] ?? null;
    if (slot.target_catalog_card_id && slot.stage_choice === "chase") {
      return catalogById.get(slot.target_catalog_card_id)?.dexId[0] ?? null;
    }
    return null;
  };
  const slotsByLine = new Map<string, Row<"line_slot">[]>();
  for (const s of slotRows) {
    const list = slotsByLine.get(s.line_id) ?? [];
    list.push(s);
    slotsByLine.set(s.line_id, list);
  }
  /**
   * OLDEST FIRST, and explicitly (UIL-084). `evolutionLineRepo.list` is a plain `select *` with no
   * ORDER BY, so this arrived in whatever order Postgres chose. The engine's `existingLineSlot` breaks
   * a tie between two lines of one family by falling back to list order — its documented contract —
   * and two such lines are ordinary now that uniqueness is per binder, so an unordered list would send
   * every future copy of that species to an arbitrary one of them, differing run to run.
   *
   * `new Date(...)` on purpose, as in `lib/line/load.ts`: PostgREST serialises `created_at` as an ISO
   * string and the raw pg wire (PGlite in tests) as a Date. `id` breaks an exact timestamp tie so the
   * order is total.
   */
  const lines: EvolutionLine[] = [...lineRows]
    .sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime() ||
        a.id.localeCompare(b.id),
    )
    .map((l) => toEvolutionLine(l, slotsByLine.get(l.id) ?? [], dexIdForSlot));

  const typeColorMap: Record<string, string> = {};
  for (const t of typeMapRows) typeColorMap[t.card_type] = t.band;

  const orderedBandKeys = bandRows.map((b) => b.band);
  // Fail fast on broken band config (empty table, or a type mapped to a band color_band lacks) so it
  // surfaces here, on the first plan run, rather than as a copy_color_band_fkey 23503 at commit time
  // after a whole haul has been built (UIL-012).
  assertBandConfig(typeColorMap, orderedBandKeys);

  const bandDisplayByKey = new Map<string, string>(bandRows.map((b) => [b.band, b.display_name]));
  const binderNameById = new Map<string, string>(binderRows.map((b) => [b.id, b.name]));
  const collectionNameById = new Map<string, string>(collectionRows.map((c) => [c.id, c.name]));
  // Artwork for the plan rows (UIL-016). Free: `catalogCardRepo.listAll` is `select *`, so
  // `image_url` is already in `catalogRows` — it is `toCatalogCard` that drops it, because the
  // engine's CatalogCard has no image field. Resolved from the row, the same way lib/line/load.ts
  // does, so the engine's types stay untouched and no second query is added.
  const imageUrlByTcgdexId = new Map<string, string | null>(
    catalogRows.map((r) => [r.tcgdex_id, r.image_url]),
  );

  /**
   * OPEN binder-block needs (UIL-030). The engine decides a stage can never be filled by creating a
   * block slot (lib/engine/line.ts); only Backfill has ever written the binder_block row that physically
   * fills that pocket run. A block slot nothing fills (`isOpenBlockNeed`: not her filler stage, and no block row
   * on it or its line) is a reserved pocket with nothing in it — exactly when a bulk-bound duplicate is worth
   * offering as the block. Only needs with a binder are listed: a line with no binder has nowhere to place anything.
   */
  const lineRowById = new Map(lineRows.map((l) => [l.id, l]));
  const bulkUnits = bulkUnitViews(bulkUnitRows, copyRows);
  /** A species' card name by dex id, as the catalog spells it ("Charizard"), for the Haul Plan's badges (UIL-117). */
  // Built once per load (TL review of #392: a scan per call was ~25M comparisons at her size). The English printing's
  // name wins when there is one, so a badge never reads in another script by accident.
  const nameByDex = new Map<number, { name: string; en: boolean }>();
  for (const r of catalogRows) {
    const d = (r.dex_id ?? [])[0];
    if (d === undefined || !r.name) continue;
    const en = r.locale === "en";
    const had = nameByDex.get(d);
    if (!had || (en && !had.en)) nameByDex.set(d, { name: r.name, en });
  }
  const dexNameOf = (dexId: number): string | null => nameByDex.get(dexId)?.name ?? null;
  /**
   * A species' name in a form and a language (UIL-133): "Arven's Toedscruel" for an Arven's line, "Toedscruel" for a
   * plain one, whichever printing the catalog happened to list first.
   */
  const cardsByDex = new Map<number, CatalogCard[]>();
  for (const c of catalogById.values()) {
    const d = c.dexId[0];
    if (d === undefined || c.isDigitalOnly) continue;
    const list = cardsByDex.get(d);
    if (list) list.push(c);
    else cardsByDex.set(d, [c]);
  }
  const dexNameIn = (dexId: number, form: CardForm, locale: string): string | null => {
    const cards = (cardsByDex.get(dexId) ?? []).filter((c) => localeOfId(c.tcgdexId) === locale);
    return cards.length > 0 ? nameInForm(cards, form, ctx.catalog) : dexNameOf(dexId);
  };
  /** A line's form (UIL-133), from what it holds or chases. */
  const lineFormOfRow = (lineId: string): CardForm =>
    lineFormOf(
      [...(slotsByLine.get(lineId) ?? [])]
        .sort((a, b) => a.stage_index - b.stage_index)
        .map((s) => {
          const viaCopy = s.copy_id ? copyRowById.get(s.copy_id)?.catalog_card_id : undefined;
          const id = viaCopy ?? (s.stage_choice === "chase" ? s.target_catalog_card_id : null);
          return id ? catalogById.get(id) : undefined;
        }),
      ctx.catalog,
    );
  /** A copy as she would name it, "Charmeleon 027/197", with its variant (UIL-126). */
  const copyLabelOf = (copyId: string): { label: string; variant: string } | null => {
    const row = copyRowById.get(copyId);
    const card = row ? catalogById.get(row.catalog_card_id) : undefined;
    if (!row || !card) return null;
    const number = formatCollectorNumber(card.localId, card.setCardCountOfficial);
    return { label: number ? `${card.name} ${number}` : card.name, variant: row.variant };
  };
  const speciesName = (rootDexId: number) =>
    nameByDex.get(rootDexId)?.name.toUpperCase() ?? `SPECIES #${rootDexId}`;
  const blockNeeds: BlockNeedCandidate[] = slotRows
    // Her filler stages are filled pockets, never needs (UIL-121): the same predicate the write checks.
    .filter((s) => isOpenBlockNeed(s, blockRows))
    .flatMap((s) => {
      const line = lineRowById.get(s.line_id);
      if (!line?.binder_id) return [];
      return [
        {
          lineId: line.id,
          slotId: s.id,
          binderId: line.binder_id,
          binderName: binderNameById.get(line.binder_id) ?? "Binder",
          speciesLabel: `${speciesName(line.root_dex_id)} LINE`,
          stage: s.stage,
          bandKey: line.color_band,
        },
      ];
    });

  const ctx: EngineContext = {
    typeColorMap,
    catalog: [...catalogById.values()],
    owned,
    binders,
    lines,
    collections: collectionRows.map(toCollection),
    now: new Date().toISOString(),
    openBlockNeeds: blockNeeds.length,
  };

  return {
    blockNeeds,
    bulkUnits,
    ctx,
    catalogById,
    copyRowById,
    slotRowsByLine: slotsByLine,
    orderedBandKeys,
    lookups: {
      bulkBoxName: (unitId) => {
        const id = unitId ?? bulkUnitForRoute(bulkUnits);
        return bulkUnits.find((u) => u.id === id)?.name ?? null;
      },
      binderNameById,
      bandDisplayByKey,
      collectionNameById,
      imageUrlByTcgdexId,
      lines: {
        slotIdAt: (lineId, stageIndex) =>
          slotsByLine.get(lineId)?.find((s) => s.stage_index === stageIndex)?.id ?? null,
        lineOfSlot: (slotId) =>
          [...slotsByLine.values()].flat().find((s) => s.id === slotId)?.line_id ?? null,
        lineName: (lineId) => {
          const ordered = [...(slotsByLine.get(lineId) ?? [])].sort(
            (a, b) => b.stage_index - a.stage_index,
          );
          const top = ordered[0];
          const dexId = top ? dexIdForSlot(top) : null;
          if (dexId === null) return null;
          // In the line's form and language (UIL-133): "Adds to Arven's Toedscruel line".
          const known = ordered
            .map((s) => (s.copy_id ? copyRowById.get(s.copy_id)?.catalog_card_id : null))
            .find((id): id is string => !!id);
          return dexNameIn(dexId, lineFormOfRow(lineId), known ? localeOfId(known) : "en");
        },
        dexName: (dexId, like) =>
          like
            ? dexNameIn(dexId, formOf(like, ctx.catalog), localeOfId(like.tcgdexId))
            : dexNameOf(dexId),
        lineWhere: (lineId) => {
          const line = lineRowById.get(lineId);
          if (!line) return null;
          return [
            line.binder_id ? (binderNameById.get(line.binder_id) ?? "A binder") : "No binder",
            "Back",
            bandDisplayByKey.get(line.color_band) ?? line.color_band,
          ].join(" · ");
        },
        heldAt: (slotId) => {
          const slot = [...slotsByLine.values()].flat().find((s) => s.id === slotId);
          return slot?.copy_id ? (copyLabelOf(slot.copy_id)?.label ?? null) : null;
        },
      },
      copyLabel: (copyId) => copyLabelOf(copyId),
      formsALine: (card) => formsALine(card, ctx.catalog),
      formOf: (card) => formOf(card, ctx.catalog),
    },
  };
}

/** Build an `IncomingCard` from a draft entry, resolving its catalog record. Null when unknown. */
export function buildIncoming(
  item: DraftItem,
  catalogById: Map<string, CatalogCard>,
): IncomingCard | null {
  const card = catalogById.get(item.tcgdexId);
  if (!card) return null;
  return { id: item.id, card, variant: item.variant };
}

/** Run the cascade over the whole draft: returns display rows and commit-ready planned cards. */
export function planFromDraft(
  pc: PlanContext,
  draft: DraftItem[],
): { items: PlanItem[]; planned: PlannedCard[] } {
  const items: PlanItem[] = [];
  const planned: PlannedCard[] = [];
  for (const d of draft) {
    const incoming = buildIncoming(d, pc.catalogById);
    if (!incoming) continue;
    const result: CascadeResult = placeCard(incoming, pc.ctx);
    const bandKey = band(incoming.card, pc.ctx.typeColorMap);
    items.push(toPlanItem(incoming, result, bandKey, pc.lookups));
    planned.push({
      incomingId: d.id,
      tcgdexId: d.tcgdexId,
      variant: d.variant,
      existingCopyId: d.existingCopyId ?? null,
      result,
    });
  }
  return { items, planned };
}
