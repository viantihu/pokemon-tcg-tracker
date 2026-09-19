/**
 * Real, TCGdex-verified card fixtures for the M3 engine tests.
 *
 * REAL-CARD DISCIPLINE (dev-spec §0, §4): every card below was verified against the live TCGdex API
 * on 2026-09-07 — collector number, type(s), stage, rarity, evolveFrom, illustrator and dexId all
 * match `https://api.tcgdex.net/v2/en/cards/<id>`. No fabricated numbers. Two traps this catches:
 *   - Obsidian Flames "Charizard ex" (sv03-125/215/223) is DARKNESS, not Fire — so the Fire
 *     Charmander line's forward stage uses the 151-set Fire "Charizard ex" (sv03.5-006/183).
 *   - `market` prices are fixture values (prices are volatile and injected, per the engine contract);
 *     card IDENTITY is what must be real.
 *
 * `cardClass`, `artworkGroupId` and `isDigitalOnly` are M2-derived; here they are set to the values
 * M2 would produce (ex/illustration-rare/etc. → specialty; TCG Pocket "A*" sets → digital-only).
 */

import type { CardCategory, CardClass, CatalogCard, CardVariants } from "@/lib/engine/types";

const V = (o: Partial<CardVariants> = {}): CardVariants => ({
  normal: false,
  holo: false,
  reverse: false,
  firstEdition: false,
  wPromo: false,
  ...o,
});

interface CardInput {
  id: string;
  name: string;
  dexId: number[];
  setId: string;
  localId: string;
  types?: string[];
  stage?: string | null;
  rarity: string;
  evolveFrom?: string | null;
  illustrator: string;
  cardClass?: CardClass;
  isDigitalOnly?: boolean;
  market: number;
  variants?: Partial<CardVariants>;
  category?: CardCategory;
  trainerType?: string;
}

function card(i: CardInput): CatalogCard {
  return {
    tcgdexId: i.id,
    name: i.name,
    dexId: i.dexId,
    setId: i.setId,
    setName: null,
    localId: i.localId,
    rarity: i.rarity,
    types: i.types ?? [],
    stage: i.stage ?? null,
    evolveFrom: i.evolveFrom ?? null,
    illustrator: i.illustrator,
    hp: null,
    variants: V(i.variants),
    artworkGroupId: `art-${i.id}`,
    cardClass: i.cardClass ?? "standard",
    isDigitalOnly: i.isDigitalOnly ?? false,
    priceLow: null,
    priceMarket: i.market,
    category: i.category ?? "Pokemon",
    trainerType: i.trainerType ?? null,
  };
}

// --- Charmander line (dexId 4 → 5 → 6). ---------------------------------------------------------

/** Charmander · Obsidian Flames 026 · Fire · Basic · Common · DOM. */
export const CHARMANDER_SV03_026 = card({
  id: "sv03-026",
  name: "Charmander",
  dexId: [4],
  setId: "sv03",
  localId: "026",
  types: ["Fire"],
  stage: "Basic",
  rarity: "Common",
  illustrator: "DOM",
  market: 0.1,
  variants: { normal: true, holo: true, reverse: true },
});

/** Charmeleon · Obsidian Flames 027 · Fire · Stage1 · Uncommon · Ryota Murayama. (example 1 incoming) */
export const CHARMELEON_SV03_027 = card({
  id: "sv03-027",
  name: "Charmeleon",
  dexId: [5],
  setId: "sv03",
  localId: "027",
  types: ["Fire"],
  stage: "Stage1",
  rarity: "Uncommon",
  evolveFrom: "Charmander",
  illustrator: "Ryota Murayama",
  market: 0.3,
  variants: { normal: true, holo: true, reverse: true },
});

/** Charmeleon · 151 005 · Fire · Stage1 · Uncommon · GIDORA. (2nd printing, different art) */
export const CHARMELEON_SV035_005 = card({
  id: "sv03.5-005",
  name: "Charmeleon",
  dexId: [5],
  setId: "sv03.5",
  localId: "005",
  types: ["Fire"],
  stage: "Stage1",
  rarity: "Uncommon",
  evolveFrom: "Charmander",
  illustrator: "GIDORA",
  market: 0.45,
  variants: { normal: true, reverse: true },
});

/** Charmeleon · Evolutions 10 · Fire · Stage1 · Uncommon · Mitsuhiro Arita. (collection member / alt) */
export const CHARMELEON_XY12_10 = card({
  id: "xy12-10",
  name: "Charmeleon",
  dexId: [5],
  setId: "xy12",
  localId: "10",
  types: ["Fire"],
  stage: "Stage1",
  rarity: "Uncommon",
  evolveFrom: "Charmander",
  illustrator: "Mitsuhiro Arita",
  market: 0.9,
  variants: { normal: true, reverse: true },
});

/** Charmeleon · Vivid Voltage 24 · Fire · Stage1 · Uncommon · SATOSHI NAKAI. (alternate) */
export const CHARMELEON_SWSH4_24 = card({
  id: "swsh4-24",
  name: "Charmeleon",
  dexId: [5],
  setId: "swsh4",
  localId: "24",
  types: ["Fire"],
  stage: "Stage1",
  rarity: "Uncommon",
  evolveFrom: "Charmander",
  illustrator: "SATOSHI NAKAI",
  market: 0.6,
  variants: { normal: true, reverse: true },
});

/** Charmeleon · Genetic Apex A1 034 · Fire · Stage1 · TCG POCKET (digital-only → excluded). */
export const CHARMELEON_A1_034_DIGITAL = card({
  id: "A1-034",
  name: "Charmeleon",
  dexId: [5],
  setId: "A1",
  localId: "034",
  types: ["Fire"],
  stage: "Stage1",
  rarity: "Two Diamond",
  evolveFrom: "Charmander",
  illustrator: "kantaro",
  isDigitalOnly: true,
  market: 0.0,
  variants: { normal: true },
});

/** Charizard ex · 151 006 · Fire · Stage2 · Double rare · PLANETA Mochizuki. (specialty) */
export const CHARIZARD_EX_SV035_006 = card({
  id: "sv03.5-006",
  name: "Charizard ex",
  dexId: [6],
  setId: "sv03.5",
  localId: "006",
  types: ["Fire"],
  stage: "Stage2",
  rarity: "Double rare",
  evolveFrom: "Charmeleon",
  illustrator: "PLANETA Mochizuki",
  cardClass: "specialty",
  market: 8.0,
  variants: { holo: true },
});

/** Charizard ex · 151 183 · Fire · Stage2 · Ultra Rare · PLANETA Mochizuki. (specialty) */
export const CHARIZARD_EX_SV035_183 = card({
  id: "sv03.5-183",
  name: "Charizard ex",
  dexId: [6],
  setId: "sv03.5",
  localId: "183",
  types: ["Fire"],
  stage: "Stage2",
  rarity: "Ultra Rare",
  evolveFrom: "Charmeleon",
  illustrator: "PLANETA Mochizuki",
  cardClass: "specialty",
  market: 25.0,
  variants: { holo: true },
});

/** Charizard ex · Obsidian Flames 125 · DARKNESS · Stage2 · 5ban Graphics. (NOT Fire — must exclude) */
export const CHARIZARD_EX_SV03_125_DARK = card({
  id: "sv03-125",
  name: "Charizard ex",
  dexId: [6],
  setId: "sv03",
  localId: "125",
  types: ["Darkness"],
  stage: "Stage2",
  rarity: "Double rare",
  evolveFrom: "Charmeleon",
  illustrator: "5ban Graphics",
  cardClass: "specialty",
  market: 6.0,
  variants: { holo: true },
});

/** Charizard · Base Set 4 · Fire · Stage2 · Rare (holo) · Mitsuhiro Arita. (STANDARD Fire top) */
export const CHARIZARD_BASE1_4 = card({
  id: "base1-4",
  name: "Charizard",
  dexId: [6],
  setId: "base1",
  localId: "4",
  types: ["Fire"],
  stage: "Stage2",
  rarity: "Rare",
  evolveFrom: "Charmeleon",
  illustrator: "Mitsuhiro Arita",
  market: 300.0,
  variants: { holo: true },
});

// --- Eevee / Vaporeon (dexId 133 / 134). --------------------------------------------------------

/** Eevee · 151 133 · Colorless · Basic · Common · Narumi Sato. */
export const EEVEE_SV035_133 = card({
  id: "sv03.5-133",
  name: "Eevee",
  dexId: [133],
  setId: "sv03.5",
  localId: "133",
  types: ["Colorless"],
  stage: "Basic",
  rarity: "Common",
  illustrator: "Narumi Sato",
  market: 0.2,
  variants: { normal: true, reverse: true },
});

/** Vaporeon · 151 134 · Water · Stage1 · Rare · kirisAki. */
export const VAPOREON_SV035_134 = card({
  id: "sv03.5-134",
  name: "Vaporeon",
  dexId: [134],
  setId: "sv03.5",
  localId: "134",
  types: ["Water"],
  stage: "Stage1",
  rarity: "Rare",
  evolveFrom: "Eevee",
  illustrator: "kirisAki",
  market: 1.5,
  variants: { normal: true, reverse: true },
});

// --- Scizor 2-stage line (dexId 123 / 212) — dies on a root block. ------------------------------

/** Scyther · 151 123 · Grass · Basic · Uncommon · Hideki Ishikawa. (no Metal printing exists) */
export const SCYTHER_SV035_123 = card({
  id: "sv03.5-123",
  name: "Scyther",
  dexId: [123],
  setId: "sv03.5",
  localId: "123",
  types: ["Grass"],
  stage: "Basic",
  rarity: "Uncommon",
  illustrator: "Hideki Ishikawa",
  market: 0.3,
  variants: { normal: true, reverse: true },
});

/** Scizor · Obsidian Flames 141 · Metal · Stage1 · Rare · otumami. */
export const SCIZOR_SV03_141 = card({
  id: "sv03-141",
  name: "Scizor",
  dexId: [212],
  setId: "sv03",
  localId: "141",
  types: ["Metal"],
  stage: "Stage1",
  rarity: "Rare",
  evolveFrom: "Scyther",
  illustrator: "otumami",
  market: 0.8,
  variants: { holo: true, reverse: true },
});

// --- Trapinch → Vibrava → Flygon 3-stage Dragon line (dexId 328/329/330) — survives blocked root. -

/** Trapinch · Primal Clash 82 · Fighting · Basic · Common · Suwama Chiaki. (no Dragon printing) */
export const TRAPINCH_XY5_82 = card({
  id: "xy5-82",
  name: "Trapinch",
  dexId: [328],
  setId: "xy5",
  localId: "82",
  types: ["Fighting"],
  stage: "Basic",
  rarity: "Common",
  illustrator: "Suwama Chiaki",
  market: 0.2,
  variants: { normal: true, reverse: true },
});

/** Vibrava · Primal Clash 109 · Dragon · Stage1 · Uncommon · Yukiko Baba. */
export const VIBRAVA_XY5_109 = card({
  id: "xy5-109",
  name: "Vibrava",
  dexId: [329],
  setId: "xy5",
  localId: "109",
  types: ["Dragon"],
  stage: "Stage1",
  rarity: "Uncommon",
  evolveFrom: "Trapinch",
  illustrator: "Yukiko Baba",
  market: 0.4,
  variants: { normal: true, reverse: true },
});

/** Flygon · Primal Clash 110 · Dragon · Stage2 · Rare · kirisAki. */
export const FLYGON_XY5_110 = card({
  id: "xy5-110",
  name: "Flygon",
  dexId: [330],
  setId: "xy5",
  localId: "110",
  types: ["Dragon"],
  stage: "Stage2",
  rarity: "Rare",
  evolveFrom: "Vibrava",
  illustrator: "kirisAki",
  market: 1.2,
  variants: { normal: true, reverse: true },
});

/** Vibrava · Roaring Skies 75 · Dragon · Stage1 · Uncommon · Kagemaru Himeno. (alternate) */
export const VIBRAVA_XY3_75 = card({
  id: "xy3-75",
  name: "Vibrava",
  dexId: [329],
  setId: "xy3",
  localId: "75",
  types: ["Dragon"],
  stage: "Stage1",
  rarity: "Uncommon",
  evolveFrom: "Trapinch",
  illustrator: "Kagemaru Himeno",
  market: 0.7,
  variants: { normal: true, reverse: true },
});

/** Flygon · Roaring Skies 76 · Dragon · Stage2 · Rare · Masakazu Fukuda. (alternate) */
export const FLYGON_XY3_76 = card({
  id: "xy3-76",
  name: "Flygon",
  dexId: [330],
  setId: "xy3",
  localId: "76",
  types: ["Dragon"],
  stage: "Stage2",
  rarity: "Rare",
  evolveFrom: "Vibrava",
  illustrator: "Masakazu Fukuda",
  market: 2.5,
  variants: { normal: true, reverse: true },
});

// --- Trainers (dexId []). -----------------------------------------------------------------------

/** Nest Ball · Scarlet & Violet 181 · Trainer/Item · Uncommon · Toyste Beach. */
export const NEST_BALL_SV01_181 = card({
  id: "sv01-181",
  name: "Nest Ball",
  dexId: [],
  setId: "sv01",
  localId: "181",
  types: [],
  stage: null,
  rarity: "Uncommon",
  illustrator: "Toyste Beach",
  market: 0.25,
  category: "Trainer",
  trainerType: "Item",
  variants: { normal: true, reverse: true },
});

/** Arven · Obsidian Flames 186 · Trainer/Supporter · Uncommon · GIDORA. */
export const ARVEN_SV03_186 = card({
  id: "sv03-186",
  name: "Arven",
  dexId: [],
  setId: "sv03",
  localId: "186",
  types: [],
  stage: null,
  rarity: "Uncommon",
  illustrator: "GIDORA",
  market: 0.5,
  category: "Trainer",
  trainerType: "Supporter",
  variants: { normal: true, reverse: true },
});

// --- Colour-band config, in the ONLY vocabulary production ever feeds the engine (UIL-013). ------

/**
 * The `type_color_map` rows migration 0003 ships, verbatim: card_type → band KEY. Production loads these
 * rows and builds the map with the loop below (lib/plan/context.ts); the engine never sees a display
 * name like "Red". The engine suite used to run on a display-form default map instead, which is how a
 * literal "White" in the cascade passed 258 green tests while violating copy_color_band_fkey at commit
 * (UIL-012). Feed THIS, so a display literal used as a band value is a visible mismatch here too.
 */
export const TYPE_COLOR_MAP_ROWS: readonly { card_type: string; band: string }[] = [
  { card_type: "Fire", band: "red" },
  { card_type: "Fighting", band: "orange" },
  { card_type: "Lightning", band: "yellow" },
  { card_type: "Dragon", band: "olive" },
  { card_type: "Grass", band: "green" },
  { card_type: "Darkness", band: "dark_blue" },
  { card_type: "Water", band: "light_blue" },
  { card_type: "Psychic", band: "purple" },
  { card_type: "Fairy", band: "pink" },
  { card_type: "Colorless", band: "white" },
  { card_type: "Metal", band: "white" },
  { card_type: "Trainer", band: "white" },
  { card_type: "Supporter", band: "white" },
  { card_type: "Item", band: "white" },
];

/** Built exactly as `loadPlanContext` builds `typeColorMap` from those rows. */
export const KEY_FORM_TYPE_COLOR_MAP: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const t of TYPE_COLOR_MAP_ROWS) map[t.card_type] = t.band;
  return map;
})();

/** The `color_band` keys, in rainbow order — what `assertBandConfig` checks the map against. */
export const BAND_KEYS: readonly string[] = [
  "red",
  "orange",
  "yellow",
  "olive",
  "green",
  "dark_blue",
  "light_blue",
  "purple",
  "pink",
  "white",
];
