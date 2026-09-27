/**
 * Back-half chain resolution + the line invariants (dev-spec §5 M5; system-design §6, §7A).
 *
 * Pure. Reuses the M3 engine (`buildChain`, `rankAlternates`, `band`) so the backfill walk shows the
 * SAME evidence the cascade would: the ordered species chain, and per stage whether a same-colour
 * printing exists (placeholder possible), whether only a specialty printing exists (a placeholder
 * caps the line), and the ranked wishlist target + alternates. Nothing is auto-decided — the
 * collector marks each stage; this only surfaces the facts.
 */

import { localeOfId } from "@/lib/catalog/locale";
import {
  buildChain,
  rankAlternates,
  type Band,
  type CatalogCard,
  type IncomingCard,
  type PriceOf,
  type TypeColorMap,
} from "@/lib/engine";
import type { BackLineStageInfo, ResolvedBackLine } from "./types";

/**
 * The colour band for a card, from its energy type, in DB-key space (`red`, `dark_blue`). White is
 * the catch-all (Colorless / Metal / Trainer / Supporter / Item). This is the "band auto-computed
 * from card type" the collector never types (system-design §7A). Mirrors the engine's `band()` but
 * takes just the types the lookup surface carries.
 */
export function bandKeyForTypes(types: readonly string[], map: TypeColorMap): string {
  const type = types.length > 0 ? types[0] : "Colorless";
  return map[type] ?? "white";
}

/** Reverse-map a band key to a representative energy type (for wishlist `required_type`). */
export function typeForBand(bandKey: string, map: TypeColorMap): string | null {
  const hit = Object.entries(map).find(([, b]) => b === bandKey);
  return hit ? hit[0] : null;
}

/**
 * Resolve a species chain for a chosen printing + colour into the ordered stages the back-half line
 * form walks. `bandKey` is the colour the collector picked for the line (system-design §6: "colour
 * is set by the first card placed"), which may differ from the picked card's own band.
 */
export function resolveBackLine(
  picked: CatalogCard,
  bandKey: string,
  catalog: CatalogCard[],
  map: TypeColorMap,
  priceOf?: PriceOf,
): ResolvedBackLine {
  const incoming: IncomingCard = { id: "backfill-seed", card: picked, variant: "normal" };
  const chain = buildChain(incoming, catalog);
  const b = bandKey as Band;

  const stages: BackLineStageInfo[] = chain.map((node, stageIndex) => {
    // The seed card's locale scopes the wishlist: an English line never ranks Japanese printings
    // (UIL-090).
    const alt = rankAlternates(node.dexId, b, localeOfId(picked.tcgdexId), catalog, map, priceOf);
    return {
      stageIndex,
      stage: node.stage,
      dexId: node.dexId,
      name: node.name,
      sameColorPrintingExists: alt.chosenCatalogCardId !== null,
      specialtyOnly: alt.willLiveInSpecialty,
      suggestedTargetId: alt.chosenCatalogCardId,
      alternateTargetIds: alt.alternateCatalogCardIds,
    };
  });

  return {
    rootDexId: chain[0]?.dexId ?? picked.dexId[0],
    speciesName: chain[0]?.name ?? picked.name,
    bandKey,
    requiredType: typeForBand(bandKey, map),
    seedStageIndex: chain.findIndex((n) => n.dexId === picked.dexId[0]),
    stages,
  };
}
