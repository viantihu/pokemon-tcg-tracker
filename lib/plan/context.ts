/**
 * Load the M3 engine context from the DB and run the cascade over a haul draft (dev-spec §5 M6).
 *
 * All the I/O for M6's cascade run lives here so the engine stays pure and the server actions stay
 * thin. Reads go through `lib/repo`. NOTE (perf, phase-1): the whole `catalog_card` mirror is loaded
 * for chain-building and alternate ranking. Locally the mirror holds only the seeded cards so this
 * is trivial; against a full ~23.5k mirror a production build should scope the query to the haul's
 * dexId neighbourhoods. Flagged, not premature-optimised.
 */

import {
  band,
  placeCard,
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
  catalogCardRepo,
  collectionRepo,
  colorBandRepo,
  copyRepo,
  evolutionLineRepo,
  lineSlotRepo,
  typeColorMapRepo,
  type DbClient,
  type Row,
} from "@/lib/repo";
import { toBinder, toCatalogCard, toCollection, toEvolutionLine, toOwnedCopy } from "./adapt";
import { toPlanItem, type AssembleLookups } from "./assemble";
import type { PlanItem, PlannedCard } from "./types";

export interface DraftItem {
  id: string;
  tcgdexId: string;
  variant: Variant;
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
}

/** Load every table the cascade reads and assemble a ready-to-run `EngineContext` + lookups. */
export async function loadPlanContext(db: DbClient): Promise<PlanContext> {
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
  ] = await Promise.all([
    catalogCardRepo.list(db),
    copyRepo.list(db),
    binderRepo.list(db),
    evolutionLineRepo.list(db),
    lineSlotRepo.list(db),
    collectionRepo.list(db),
    typeColorMapRepo.list(db),
    colorBandRepo.listOrdered(db),
    binderSectionRepo.list(db),
  ]);

  const catalogById = new Map<string, CatalogCard>();
  for (const r of catalogRows) catalogById.set(r.tcgdex_id, toCatalogCard(r));

  const copyRowById = new Map<string, Row<"copy">>();
  for (const r of copyRows) copyRowById.set(r.id, r);

  const owned = copyRows
    .map((r) => toOwnedCopy(r, catalogById))
    .filter((c): c is NonNullable<typeof c> => c !== null);

  // Back-half free-pocket hint per binder → new-line assignment (decision §3).
  const freeBackByBinder = new Map<string, number>();
  for (const s of sectionRows) {
    if (s.half === "back" && s.binder_id) freeBackByBinder.set(s.binder_id, s.free_pockets ?? 0);
  }
  const binders = binderRows.map((b) => toBinder(b, { freeBackHalf: freeBackByBinder.get(b.id) }));

  // Resolve each slot's species dexId from its filled copy or its wishlist target.
  const dexIdForSlot = (slot: Row<"line_slot">): number | null => {
    const viaCopy = slot.copy_id && copyRowById.get(slot.copy_id);
    if (viaCopy) return catalogById.get(viaCopy.catalog_card_id)?.dexId[0] ?? null;
    if (slot.target_catalog_card_id) {
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
  const lines: EvolutionLine[] = lineRows.map((l) =>
    toEvolutionLine(l, slotsByLine.get(l.id) ?? [], dexIdForSlot),
  );

  const typeColorMap: Record<string, string> = {};
  for (const t of typeMapRows) typeColorMap[t.card_type] = t.band;

  const orderedBandKeys = bandRows.map((b) => b.band);
  const bandDisplayByKey = new Map<string, string>(bandRows.map((b) => [b.band, b.display_name]));
  const binderNameById = new Map<string, string>(binderRows.map((b) => [b.id, b.name]));
  const collectionNameById = new Map<string, string>(collectionRows.map((c) => [c.id, c.name]));

  const ctx: EngineContext = {
    typeColorMap,
    catalog: [...catalogById.values()],
    owned,
    binders,
    lines,
    collections: collectionRows.map(toCollection),
    now: new Date().toISOString(),
  };

  return {
    ctx,
    catalogById,
    copyRowById,
    slotRowsByLine: slotsByLine,
    orderedBandKeys,
    lookups: { binderNameById, bandDisplayByKey, collectionNameById },
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
    planned.push({ incomingId: d.id, tcgdexId: d.tcgdexId, variant: d.variant, result });
  }
  return { items, planned };
}
