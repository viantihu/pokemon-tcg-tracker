/**
 * Backfill context load + chain resolution (dev-spec §5 M5; §2 module boundary).
 *
 * All the reads a backfill step needs live here so the planners stay pure and the server actions
 * stay thin. Reads go through `lib/repo`. Loading the whole `catalog_card` mirror is fine locally
 * (seeded rows only); a full ~23.5k mirror would scope this to the picked species' neighbourhood
 * (same flagged perf note as `lib/plan/context.ts`).
 */

import type { CatalogCard, TypeColorMap } from "@/lib/engine";
import {
  binderRepo,
  catalogCardRepo,
  collectionRepo,
  colorBandRepo,
  typeColorMapRepo,
  type DbClient,
} from "@/lib/repo";
import { toCatalogCard } from "@/lib/plan";
import { resolveBackLine } from "./resolve";
import type { BackfillBinder, BackfillCollection, BandOption, ResolvedBackLine } from "./types";
import type { PlanDeps } from "./plan";

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
    catalogCardRepo.listAll(db),
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

/** Assemble the pure-planner deps from a loaded context + owner. */
export function planDeps(ctx: BackfillContext, ownerId: string): PlanDeps {
  return {
    ownerId,
    catalogById: ctx.catalogById,
    typeColorMap: ctx.typeColorMap,
    binderNameById: ctx.binderNameById,
    bandDisplayByKey: ctx.bandDisplayByKey,
    collectionNameById: ctx.collectionNameById,
    newId: () =>
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `bf-${Math.random().toString(36).slice(2)}`,
    now: new Date().toISOString(),
  };
}
