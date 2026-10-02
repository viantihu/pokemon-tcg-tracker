/**
 * Backfill context load + chain resolution (dev-spec §5 M5; §2 module boundary).
 *
 * All the reads a backfill step needs live here so the planners stay pure and the server actions
 * stay thin. Reads go through `lib/repo`; the whole catalog comes through the shared cache the Haul Plan
 * reads it through (lib/plan/catalog-cache.ts): her stand-ins fresh, the mirror from memory.
 */

import type { CatalogCard, TypeColorMap } from "@/lib/engine";
import {
  binderRepo,
  collectionRepo,
  colorBandRepo,
  typeColorMapRepo,
  type DbClient,
} from "@/lib/repo";
import { loadCatalogCached, toCatalogCard } from "@/lib/plan";
import { resolveBackLine } from "./resolve";
import type { BackfillBinder, BackfillCollection, BandOption, ResolvedBackLine } from "./types";
import type { PlanDeps } from "./plan";
import type { WaitingPool } from "./waiting";
import { isStandInId, localeOfId, standInIdFor } from "@/lib/catalog/locale";
import type { StageCatalogCard, StageState } from "@/lib/line/stage-choice";

export interface BackfillContext {
  binders: BackfillBinder[];
  collections: BackfillCollection[];
  bands: BandOption[];
  typeColorMap: TypeColorMap;
  catalogById: Map<string, CatalogCard>;
  binderNameById: Map<string, string>;
  bandDisplayByKey: Map<string, string>;
  collectionNameById: Map<string, string>;
}

/** Load binders, collections, ordered bands, the type→band map, and the catalog mirror. */
export async function loadBackfillContext(db: DbClient): Promise<BackfillContext> {
  const [binderRows, collectionRows, bandRows, typeMapRows, catalogRows] = await Promise.all([
    binderRepo.list(db),
    collectionRepo.list(db),
    colorBandRepo.listOrdered(db),
    typeColorMapRepo.list(db),
    loadCatalogCached(db),
  ]);

  const catalogById = new Map<string, CatalogCard>();
  for (const r of catalogRows) catalogById.set(r.tcgdex_id, toCatalogCard(r));

  const typeColorMap: TypeColorMap = {};
  for (const t of typeMapRows) typeColorMap[t.card_type] = t.band;

  const binders: BackfillBinder[] = binderRows.map((b) => ({
    id: b.id,
    name: b.name,
    type: b.type === "specialty" ? "specialty" : "general",
    isActive: b.is_active,
  }));

  return {
    binders,
    collections: collectionRows.map((c) => ({ id: c.id, name: c.name })),
    bands: bandRows.map((b) => ({ key: b.band, display: b.display_name })),
    typeColorMap,
    catalogById,
    binderNameById: new Map(binderRows.map((b) => [b.id, b.name])),
    bandDisplayByKey: new Map(bandRows.map((b) => [b.band, b.display_name])),
    collectionNameById: new Map(collectionRows.map((c) => [c.id, c.name])),
  };
}

/** Resolve the back-half chain for a picked printing + chosen colour, against the loaded mirror. */
export function resolveBackLineFromContext(
  ctx: BackfillContext,
  pickedTcgdexId: string,
  bandKey: string,
): ResolvedBackLine | null {
  const picked = ctx.catalogById.get(pickedTcgdexId);
  if (!picked) return null;
  return resolveBackLine(picked, bandKey, [...ctx.catalogById.values()], ctx.typeColorMap);
}

/**
 * Fresh state for the shared stage-choice rule (UIL-121), over Backfill's loaded context: the catalog, her stand-ins,
 * and her copies WAITING in the haul (a Backfill filler card is one of them, so it reads role 'haul').
 */
export function stageStateFor(
  ctx: BackfillContext,
  pool: WaitingPool,
  newId: () => string,
  /** Her bulk box copies, for a filler card picked from it (the Senior BA's ruling: bulk box first, then haul). */
  bulkIds: ReadonlySet<string> = new Set(),
): StageState {
  const waitingIds = new Set([...pool.values()].flatMap((k) => k.copyIds));
  const toStage = (c: CatalogCard): StageCatalogCard => ({
    tcgdexId: c.tcgdexId,
    name: c.name,
    dexId: c.dexId,
    cardClass: c.cardClass,
    setName: c.setName ?? null,
    localId: c.localId,
    locale: localeOfId(c.tcgdexId),
  });
  const all = [...ctx.catalogById.values()];
  const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();
  return {
    card: (id) => {
      const c = ctx.catalogById.get(id);
      return c ? toStage(c) : null;
    },
    copy: (id) =>
      waitingIds.has(id) ? { id, role: "haul" } : bulkIds.has(id) ? { id, role: "bulk" } : null,
    standIns: all.filter((c) => isStandInId(c.tcgdexId)).map(toStage),
    mirrorCandidates: (draft) => all.filter((c) => norm(c.name) === norm(draft.name)).map(toStage),
    newId,
    newStandInId: (language) => standInIdFor(language),
  };
}

/** Assemble the pure-planner deps from a loaded context + owner + the waiting-copy source. */
export function planDeps(
  ctx: BackfillContext,
  ownerId: string,
  takeCopy: PlanDeps["takeCopy"],
  pool: WaitingPool = new Map(),
  bulkIds: ReadonlySet<string> = new Set(),
): PlanDeps {
  // A real uuid: every id column it names is uuid-typed (TL review of #422).
  const newId = () => crypto.randomUUID();
  return {
    stageState: stageStateFor(ctx, pool, newId, bulkIds),
    takeCopy,
    ownerId,
    catalogById: ctx.catalogById,
    typeColorMap: ctx.typeColorMap,
    binderNameById: ctx.binderNameById,
    bandDisplayByKey: ctx.bandDisplayByKey,
    collectionNameById: ctx.collectionNameById,
    newId,
    now: new Date().toISOString(),
  };
}
