/**
 * The line popup's two pickers, read from fresh state (UIL-121): the printings she can chase for a stage, and the
 * spare copies in her bulk box that can fill a pocket. What they return is only shown; her pick is checked again
 * on the server when she confirms (`validateStageDecision`).
 */

import { band, type TypeColorMap } from "@/lib/engine";
import { toCatalogCard } from "@/lib/plan/adapt";
import { catalogCardRepo, copyRepo, typeColorMapRepo, type DbClient, type Row } from "@/lib/repo";
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
): Promise<StageOption[]> {
  const [rows, map] = await Promise.all([catalogCardRepo.findByDexId(db, dexId), colourMap(db)]);
  return stageOptionsFrom(
    rows.map((r) => printingFromRow(r, map)),
    { locale, bandKey: lineBandKey },
  );
}

/** The spare copies in her bulk box, image first, for a pocket's filler. */
export async function loadBulkFillers(db: DbClient): Promise<FillerCardOption[]> {
  const [copies, map] = await Promise.all([copyRepo.listBulk(db), colourMap(db)]);
  const rows = await catalogCardRepo.listByIds(db, [
    ...new Set(copies.map((c) => c.catalog_card_id)),
  ]);
  const byId = new Map(rows.map((r) => [r.tcgdex_id, r]));
  const out: FillerCardOption[] = [];
  for (const c of copies) {
    const r = byId.get(c.catalog_card_id);
    if (!r) continue;
    out.push({
      copyId: c.id,
      where: "Bulk box",
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
  return out.sort(
    (a, b) => a.card.name.localeCompare(b.card.name) || a.copyId.localeCompare(b.copyId),
  );
}
