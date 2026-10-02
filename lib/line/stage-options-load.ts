/**
 * The line popup's two pickers, read from fresh state (UIL-121): the printings she can chase for a stage, and the
 * spare copies in her bulk box that can fill a pocket. What they return is only shown; her pick is checked again
 * on the server when she confirms (`validateStageDecision`).
 */

import { band, type CardForm, type TypeColorMap } from "@/lib/engine";
import { toCatalogCard } from "@/lib/plan/adapt";
import {
  catalogCardRepo,
  copyRepo,
  bulkUnitRepo,
  typeColorMapRepo,
  type DbClient,
  type Row,
} from "@/lib/repo";
import type { Locale } from "@/lib/sync/types";
import type { FillerCardOption, StageOption } from "./popup";
import { stageOptionsFrom, type StagePrinting } from "./stage-options";

/** A catalog row as a stage option reads it, coloured by her map. */
export function printingFromRow(r: Row<"catalog_card">, map: TypeColorMap): StagePrinting {
  return {
    tcgdexId: r.tcgdex_id,
    name: r.name,
    setId: r.set_id,
    setName: r.set_name,
    localId: r.local_id,
    setCardCountOfficial: r.set_card_count_official,
    imageUrl: r.image_url,
    cardClass: r.card_class,
    isDigitalOnly: r.is_digital_only,
    priceMarket: r.price_market,
    bandKey: band(toCatalogCard(r), map),
  };
}

async function colourMap(db: DbClient): Promise<TypeColorMap> {
  const map: TypeColorMap = {};
  for (const t of await typeColorMapRepo.list(db)) map[t.card_type] = t.band;
  return map;
}

/** The species' printings in the line's language, same colour first. */
export async function loadStageOptions(
  db: DbClient,
  dexId: number,
  locale: Locale,
  lineBandKey: string,
  /** The line's form (UIL-133): its own printings first. */
  form?: CardForm,
): Promise<StageOption[]> {
  const [rows, map] = await Promise.all([catalogCardRepo.findByDexId(db, dexId), colourMap(db)]);
  return stageOptionsFrom(
    rows.map((r) => printingFromRow(r, map)),
    { locale, bandKey: lineBandKey, ...(form !== undefined ? { form } : {}) },
  );
}

/**
 * The spare copies in her bulk box, image first, for a pocket's filler: ONE option per printing and variant, with its
 * copies oldest first and how many (UIL-121, the UX Dev: hundreds of copies must not become hundreds of tiles).
 */
export async function loadBulkFillers(db: DbClient): Promise<FillerCardOption[]> {
  const [copies, map, boxes] = await Promise.all([
    copyRepo.listBulk(db),
    colourMap(db),
    bulkUnitRepo.listOrdered(db),
  ]);
  /** UIL-130: each tile names the box its copies are in ("Bulk box", "Shoebox"). */
  const boxName = new Map(boxes.map((u) => [u.id, u.name]));
  const rows = await catalogCardRepo.listByIds(db, [
    ...new Set(copies.map((c) => c.catalog_card_id)),
  ]);
  const byId = new Map(rows.map((r) => [r.tcgdex_id, r]));
  const groups = new Map<string, FillerCardOption>();
  const oldestFirst = [...copies].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
  for (const c of oldestFirst) {
    const r = byId.get(c.catalog_card_id);
    if (!r) continue;
    // One tile per printing, variant AND box, so a tile's copies are all where its tag says.
    const key = `${c.catalog_card_id}|${c.variant}|${c.bulk_unit_id ?? ""}`;
    const had = groups.get(key);
    if (had) {
      had.copyIds!.push(c.id);
      had.count = had.copyIds!.length;
      continue;
    }
    groups.set(key, {
      copyId: c.id,
      copyIds: [c.id],
      count: 1,
      where: (c.bulk_unit_id && boxName.get(c.bulk_unit_id)) || "Bulk box",
      card: {
        tcgdexId: r.tcgdex_id,
        name: r.name,
        setId: r.set_id,
        setName: r.set_name,
        localId: r.local_id,
        setCardCountOfficial: r.set_card_count_official,
        imageUrl: r.image_url,
        bandKey: band(toCatalogCard(r), map),
      },
    });
  }
  return [...groups.values()].sort(
    (a, b) => a.card.name.localeCompare(b.card.name) || a.copyId.localeCompare(b.copyId),
  );
}
