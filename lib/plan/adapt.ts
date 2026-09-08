/**
 * DB row → engine type adapters (dev-spec §5 M6; §2 module boundary).
 *
 * The M3 engine is pure and speaks camelCase domain types (`lib/engine/types.ts`); the repo layer
 * speaks snake_case Supabase rows. These adapters are the single translation point so the engine
 * stays DB-agnostic and the route handlers stay thin. All pure.
 *
 * BAND SPACE. The DB stores colour bands as keys (`red`, `dark_blue`); the engine only ever
 * compares band strings and never assumes the display form, so we feed it the DB `type_color_map`
 * (type → DB key) and it operates entirely in DB-key space. That keeps an owned copy's stored
 * `color_band` ("red") equal to `band(card, map)` and lets the plan write the band straight back.
 *
 * CATEGORY. `catalog_card` does not store TCGdex `category`/`trainerType`. The engine only needs
 * `category` to route non-Pokémon to White; we derive it: no dexId, no types, no stage ⇒ Trainer.
 * Either way such a card lands in the White front half, so a mis-derivation cannot mis-route it.
 */

import type {
  Binder,
  CardVariants,
  CatalogCard,
  Collection,
  EvolutionLine,
  LineSlotRecord,
  OwnedCopy,
  Role,
  Variant,
} from "@/lib/engine";
import type { Row } from "@/lib/repo";

const FALSE_VARIANTS: CardVariants = {
  normal: false,
  holo: false,
  reverse: false,
  firstEdition: false,
  wPromo: false,
};

/** Coerce the jsonb `variants` blob into the five-flag `CardVariants` shape. */
export function toCardVariants(raw: unknown): CardVariants {
  if (!raw || typeof raw !== "object") return { ...FALSE_VARIANTS };
  const r = raw as Record<string, unknown>;
  return {
    normal: r.normal === true,
    holo: r.holo === true,
    reverse: r.reverse === true,
    firstEdition: r.firstEdition === true,
    wPromo: r.wPromo === true,
  };
}

/** The variant flags that are `true`, in display order — the choices a variant selector offers. */
export function availableVariants(v: CardVariants): Variant[] {
  const order: Variant[] = ["normal", "holo", "reverse", "firstEdition", "wPromo"];
  const present = order.filter((k) => v[k]);
  return present.length > 0 ? present : ["normal"];
}

/** A catalog printing row → engine `CatalogCard`. */
export function toCatalogCard(row: Row<"catalog_card">): CatalogCard {
  const isNonPokemon =
    (row.dex_id?.length ?? 0) === 0 && (row.types?.length ?? 0) === 0 && row.stage == null;
  return {
    tcgdexId: row.tcgdex_id,
    name: row.name,
    dexId: row.dex_id ?? [],
    setId: row.set_id,
    setName: row.set_name,
    localId: row.local_id,
    rarity: row.rarity,
    types: row.types ?? [],
    stage: row.stage,
    evolveFrom: row.evolve_from,
    illustrator: row.illustrator,
    hp: row.hp,
    variants: toCardVariants(row.variants),
    artworkGroupId: row.artwork_group_id,
    cardClass: row.card_class === "specialty" ? "specialty" : "standard",
    isDigitalOnly: row.is_digital_only,
    priceLow: row.price_low,
    priceMarket: row.price_market,
    category: isNonPokemon ? "Trainer" : "Pokemon",
    trainerType: null,
  };
}

/** An owned `copy` row (its catalog record resolved) → engine `OwnedCopy`. */
export function toOwnedCopy(
  row: Row<"copy">,
  catalogById: Map<string, CatalogCard>,
): OwnedCopy | null {
  const card = catalogById.get(row.catalog_card_id);
  if (!card) return null;
  return {
    id: row.id,
    card,
    variant: (row.variant as Variant) ?? "normal",
    role: (row.role as Role) ?? "shelved",
    binderId: row.binder_id,
    binderHalf: (row.binder_half as OwnedCopy["binderHalf"]) ?? null,
    colorBand: row.color_band,
    lineSlotId: row.line_slot_id,
  };
}

/** An `evolution_line` row + its `line_slot` rows → engine `EvolutionLine`. */
export function toEvolutionLine(
  line: Row<"evolution_line">,
  slots: Row<"line_slot">[],
  dexIdForSlot: (slot: Row<"line_slot">) => number | null,
): EvolutionLine {
  const slotRecords: LineSlotRecord[] = slots
    .slice()
    .sort((a, b) => a.stage_index - b.stage_index)
    .map((s) => ({
      id: s.id,
      stageIndex: s.stage_index,
      stage: s.stage,
      state: s.state as LineSlotRecord["state"],
      copyId: s.copy_id,
      dexId: dexIdForSlot(s),
      targetCatalogCardId: s.target_catalog_card_id,
    }));
  return {
    id: line.id,
    rootDexId: line.root_dex_id,
    colorBand: line.color_band,
    binderId: line.binder_id,
    status: line.status as EvolutionLine["status"],
    slots: slotRecords,
  };
}

/** A `collection` row → engine `Collection`. */
export function toCollection(row: Row<"collection">): Collection {
  return {
    id: row.id,
    name: row.name,
    currentBinderIds: row.current_binder_ids ?? [],
    targetCatalogCardIds: row.target_catalog_card_ids ?? [],
  };
}

/**
 * A `binder` row → engine `Binder`. Optional per-band free-front and free-back-half capacity hints
 * (from the `binder_section` view) steer front-half suggestion and new-line assignment.
 */
export function toBinder(
  row: Row<"binder">,
  hints?: { freeFrontHalfByBand?: Record<string, number>; freeBackHalf?: number },
): Binder {
  return {
    id: row.id,
    name: row.name,
    type: row.type === "specialty" ? "specialty" : "general",
    isActive: row.is_active,
    freeFrontHalfByBand: hints?.freeFrontHalfByBand,
    freeBackHalf: hints?.freeBackHalf,
  };
}
