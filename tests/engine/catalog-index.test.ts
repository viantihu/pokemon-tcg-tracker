/**
 * The chain index (lib/engine/catalog-index.ts): the same chains as the whole-catalog filters it replaced, card for
 * card and in the same order, and built once per catalog rather than once per question.
 *
 * WHY (the Tech Lead's CPU profile of a production build on her data, 2026-10-02): after the catalog cache cut a Lines
 * load to 14 round trips it still took seconds of server CPU, ~60% of it in `buildChain`, which filtered all 36,334
 * rows by language and then by name, species and what a card evolves from, at every stage of every chain, per line
 * and per card. The Haul Plan's line-join options (~1.9 s on 13 trips) had the same cause.
 *
 * THE ORACLE. `oldBuildChain` and `oldRankAlternates` below are the filter-based implementations exactly as they stood
 * before the index (lib/engine/line.ts at f838f22), kept here so the new code is checked against the old one rather
 * than against what someone expected it to say. Every card of the catalog below is walked as the incoming card, over
 * several orderings of the same catalog (order is part of the answer: the walk follows `prev[0]`, a node keeps its
 * cards in catalog order, and its label is the first of the shortest names), and the results must be deep-equal.
 *
 * The cards: the engine's real fixtures (./fixtures), plus HAND-BUILT shapes for the cases the walk has to get right.
 * The hand-built ones are not printings (ids start `x-`, or `ja:x-` / `user:` where the namespace is the point), so
 * nothing here claims a card exists; what is under test is that two implementations agree on the same input.
 *
 * COUNTS, never elapsed time: the structural checks count passes over the catalog array and reads of card fields.
 */
import { describe, expect, it } from "vitest";
import { localeOfId } from "@/lib/catalog/locale";
import {
  band,
  buildChain,
  chainFor,
  formFit,
  physicalIndex,
  printingsEvolvingFrom,
  printingsNamed,
  printingsOfDex,
  rankAlternates,
  type Band,
  type CardForm,
  type CatalogCard,
  type ChainNode,
  type IncomingCard,
  type PriceOf,
  type PricedAlternates,
  type TypeColorMap,
} from "@/lib/engine";
import type { Locale } from "@/lib/sync/types";
import * as F from "./fixtures";

/* ------------------------------------- the oracle (f838f22) ------------------------------------- */

const norm = (s: string) => s.trim().toLowerCase();

const oldPhysicalIn = (catalog: CatalogCard[], locale: Locale) =>
  catalog.filter((c) => !c.isDigitalOnly && localeOfId(c.tcgdexId) === locale);

const oldByName = (cards: CatalogCard[], name: string) =>
  cards.filter((c) => norm(c.name) === norm(name));

const oldByDex = (cards: CatalogCard[], dexId: number) =>
  cards.filter((c) => c.dexId.includes(dexId));

const oldEvolvingFrom = (cards: CatalogCard[], names: Set<string>) =>
  cards.filter((c) => c.evolveFrom && names.has(norm(c.evolveFrom)));

function oldMakeNode(dexId: number, cards: CatalogCard[]): ChainNode {
  const name = cards.map((c) => c.name).sort((a, b) => a.length - b.length)[0] ?? "";
  return { dexId, stage: cards[0]?.stage ?? "", name, cards };
}

function oldBuildChain(incoming: IncomingCard, catalog: CatalogCard[]): ChainNode[] {
  const phys = oldPhysicalIn(catalog, localeOfId(incoming.card.tcgdexId));
  const xDex = incoming.card.dexId[0];
  const seen = new Set<number>([xDex]);

  const back: ChainNode[] = [];
  let cur: CatalogCard | undefined = incoming.card;
  while (cur?.evolveFrom) {
    const prev = oldByName(phys, cur.evolveFrom);
    if (prev.length === 0) break;
    const pDex = prev[0].dexId[0];
    if (pDex === undefined || seen.has(pDex)) break;
    seen.add(pDex);
    back.unshift(oldMakeNode(pDex, oldByDex(phys, pDex)));
    cur = prev[0];
  }

  const xNode = oldMakeNode(xDex, oldByDex(phys, xDex));

  const fwd: ChainNode[] = [];
  let frontier = new Set(xNode.cards.map((c) => norm(c.name)));
  while (back.length + fwd.length < 6) {
    const next = oldEvolvingFrom(phys, frontier).filter((c) => !seen.has(c.dexId[0]));
    if (next.length === 0) break;
    const dexIds = Array.from(new Set(next.map((c) => c.dexId[0])));
    if (dexIds.length !== 1) break;
    const nDex = dexIds[0];
    seen.add(nDex);
    const node = oldMakeNode(nDex, oldByDex(phys, nDex));
    fwd.push(node);
    frontier = new Set(node.cards.map((c) => norm(c.name)));
  }

  return [...back, xNode, ...fwd];
}

function oldRankAlternates(
  dexId: number,
  b: Band,
  locale: Locale,
  catalog: CatalogCard[],
  map: TypeColorMap,
  priceOf: PriceOf = (c) => c.priceMarket,
  exclude: readonly string[] = [],
  inForm?: { form: CardForm },
): PricedAlternates {
  const excluded = new Set(exclude);
  const phys = oldPhysicalIn(catalog, locale).filter(
    (c) => c.dexId.includes(dexId) && band(c, map) === b && !excluded.has(c.tcgdexId),
  );
  const price = (c: CatalogCard) => {
    const p = priceOf(c);
    return p === null || p === undefined ? Number.POSITIVE_INFINITY : p;
  };
  const otherForm = (c: CatalogCard) =>
    inForm && formFit(c, inForm.form, catalog) !== "same" ? 1 : 0;
  const sortByPrice = (list: CatalogCard[]) =>
    [...list].sort(
      (a, b2) =>
        otherForm(a) - otherForm(b2) ||
        price(a) - price(b2) ||
        a.tcgdexId.localeCompare(b2.tcgdexId),
    );
  const standard = sortByPrice(phys.filter((c) => c.cardClass === "standard"));
  const specialty = sortByPrice(phys.filter((c) => c.cardClass === "specialty"));
  const ranked = standard.length > 0 ? standard : specialty;
  return {
    chosenCatalogCardId: ranked[0]?.tcgdexId ?? null,
    alternateCatalogCardIds: ranked.slice(1).map((c) => c.tcgdexId),
    willLiveInSpecialty: standard.length === 0 && specialty.length > 0,
  };
}

/* ------------------------------------------ the catalog ------------------------------------------ */

let price = 0;
/** A hand-built shape (not a printing): only the fields the walk and the ranking read are meaningful. */
const x = (
  id: string,
  name: string,
  dexId: number[],
  stage: string | null,
  evolveFrom: string | null,
  type: string,
  o: Partial<CatalogCard> = {},
): CatalogCard => ({
  ...F.CHARMANDER_SV03_026,
  tcgdexId: id,
  name,
  dexId,
  setId: id.split("-")[0],
  localId: id,
  stage,
  evolveFrom,
  types: [type],
  artworkGroupId: `art-${id}`,
  // Scattered prices, some repeated and some unpriced, so every tie-break of the ranking is in play.
  priceMarket: (price = (price * 7 + 3) % 23) === 5 ? null : price / 4,
  ...o,
});

const HAND_BUILT: CatalogCard[] = [
  // Eevee: one Basic, five Stage 1s of five species. A branch: the forward walk stops at Eevee.
  x("x-eevee-1", "Eevee", [133], "Basic", null, "Colorless"),
  x("x-vaporeon-1", "Vaporeon", [134], "Stage1", "Eevee", "Water"),
  x("x-jolteon-1", "Jolteon", [135], "Stage1", "Eevee", "Lightning"),
  x("x-eevee-2", "Eevee", [133], "Basic", null, "Colorless", { cardClass: "specialty" }),
  x("x-flareon-1", "Flareon", [136], "Stage1", "Eevee", "Fire"),
  x("x-espeon-1", "Espeon", [196], "Stage1", "Eevee", "Psychic"),
  x("x-umbreon-1", "Umbreon", [197], "Stage1", "Eevee", "Darkness"),
  // Oddish → Gloom → Vileplume | Bellossom: a branch past the middle stage.
  x("x-oddish-1", "Oddish", [43], "Basic", null, "Grass"),
  x("x-gloom-1", "Gloom", [44], "Stage1", "Oddish", "Grass"),
  x("x-vileplume-1", "Vileplume", [45], "Stage2", "Gloom", "Grass"),
  x("x-gloom-2", "Gloom", [44], "Stage1", "Oddish", "Grass"),
  x("x-bellossom-1", "Bellossom", [182], "Stage2", "Gloom", "Grass"),
  // Slowpoke → Slowbro | Slowking, plain and Galarian (the same species, so the same nodes).
  x("x-slowpoke-1", "Slowpoke", [79], "Basic", null, "Water"),
  x("x-slowbro-1", "Slowbro", [80], "Stage1", "Slowpoke", "Water"),
  x("x-slowking-1", "Slowking", [199], "Stage1", "Slowpoke", "Psychic"),
  x("x-gslowpoke-1", "Galarian Slowpoke", [79], "Basic", null, "Psychic"),
  x("x-gslowbro-1", "Galarian Slowbro", [80], "Stage1", "Galarian Slowpoke", "Psychic"),
  // Pichu → Pikachu → Raichu | Alolan Raichu (one species, 26). Only ONE Pikachu names Pichu: which one comes first
  // in the catalog decides whether a Raichu's walk reaches Pichu (`prev[0]`), so the orderings below matter here.
  x("x-pichu-1", "Pichu", [172], "Basic", null, "Lightning"),
  x("x-pikachu-1", "Pikachu", [25], "Basic", null, "Lightning"),
  x("x-pikachu-2", "Pikachu", [25], "Stage1", "Pichu", "Lightning"),
  x("x-raichu-1", "Raichu", [26], "Stage1", "Pikachu", "Lightning"),
  x("x-araichu-1", "Alolan Raichu", [26], "Stage1", "Pikachu", "Lightning"),
  // A card of two species (a TAG TEAM): listed under both, once each.
  x("x-pikazek-1", "Pikachu & Zekrom-GX", [25, 644], "Basic", null, "Lightning", {
    cardClass: "specialty",
  }),
  // Meowth → Persian; Alolan Meowth → Alolan Persian (53); Galarian Meowth → Perrserker (863): a branch at Meowth.
  x("x-meowth-1", "Meowth", [52], "Basic", null, "Colorless"),
  x("x-persian-1", "Persian", [53], "Stage1", "Meowth", "Colorless"),
  x("x-ameowth-1", "Alolan Meowth", [52], "Basic", null, "Darkness"),
  x("x-apersian-1", "Alolan Persian", [53], "Stage1", "Alolan Meowth", "Darkness"),
  x("x-gmeowth-1", "Galarian Meowth", [52], "Basic", null, "Metal"),
  x("x-perrserker-1", "Perrserker", [863], "Stage1", "Galarian Meowth", "Metal"),
  // Hisuian: Growlithe → Arcanine and Hisuian Growlithe → Hisuian Arcanine (one species each), Light Arcanine too.
  x("x-growlithe-1", "Growlithe", [58], "Basic", null, "Fire"),
  x("x-hgrowlithe-1", "Hisuian Growlithe", [58], "Basic", null, "Fighting"),
  x("x-arcanine-1", "Arcanine", [59], "Stage1", "Growlithe", "Fire"),
  x("x-harcanine-1", "Hisuian Arcanine", [59], "Stage1", "Hisuian Growlithe", "Fighting"),
  x("x-larcanine-1", "Light Arcanine", [59], "Stage1", "Growlithe", "Fire"),
  // Rowlet → Dartrix → Decidueye | Hisuian Decidueye (one species, 724).
  x("x-rowlet-1", "Rowlet", [722], "Basic", null, "Grass"),
  x("x-dartrix-1", "Dartrix", [723], "Stage1", "Rowlet", "Grass"),
  x("x-hdecidueye-1", "Hisuian Decidueye", [724], "Stage2", "Dartrix", "Fighting"),
  x("x-decidueye-1", "Decidueye", [724], "Stage2", "Dartrix", "Grass"),
  // Trainer forms: Arven's and Team Rocket's, beside their plain species.
  x("x-toedscool-1", "Toedscool", [948], "Basic", null, "Fighting"),
  x("x-atoedscool-1", "Arven's Toedscool", [948], "Basic", null, "Fighting"),
  x("x-toedscruel-1", "Toedscruel", [949], "Stage1", "Toedscool", "Fighting"),
  x("x-atoedscruel-1", "Arven's Toedscruel", [949], "Stage1", "Arven's Toedscool", "Fighting"),
  x("x-trrattata-1", "Team Rocket's Rattata", [19], "Basic", null, "Darkness"),
  x(
    "x-trraticate-1",
    "Team Rocket's Raticate",
    [20],
    "Stage1",
    "Team Rocket's Rattata",
    "Darkness",
  ),
  x("x-rattata-1", "Rattata", [19], "Basic", null, "Colorless"),
  x("x-raticate-1", "Raticate", [20], "Stage1", "Rattata", "Colorless"),
  // Dark and Light: Dark Charmeleon from Charmander, Dark Charizard from (plain) Charmeleon, as TCGdex has them.
  x("x-dcharmeleon-1", "Dark Charmeleon", [5], "Stage1", "Charmander", "Fire"),
  x("x-dcharizard-1", "Dark Charizard", [6], "Stage2", "Charmeleon", "Fire"),
  // Names as TCGdex spells them are not always tidy: case and spaces must not split a species.
  x("x-charmander-ws", "  charmander ", [4], "Basic", null, "Fire"),
  x("x-charmeleon-ws", "Charmeleon", [5], "Stage1", "  CHARMANDER ", "Fire"),
  // A species listed twice in one card's dexId: found once, as `includes` finds it once.
  x("x-charmeleon-dup", "Charmeleon", [5, 5], "Stage1", "Charmander", "Fire"),
  // A digital-only card in the middle of a species: never part of a chain.
  x("x-charmeleon-dig", "Charmeleon", [5], "Stage1", "Charmander", "Fire", { isDigitalOnly: true }),
  // A name two species share: which comes first decides a walk back from what evolves from it.
  x("x-twin-a", "Twinmon", [9201], "Basic", null, "Water"),
  x("x-twin-evo", "Twinevo", [9203], "Stage1", "Twinmon", "Water"),
  x("x-twin-b", "Twinmon", [9202], "Basic", null, "Water"),
  // Cycles and self-reference in evolveFrom: the walk must end, the same way.
  x("x-cyc-a", "Cyclea", [9001], "Stage1", "Cycleb", "Grass"),
  x("x-cyc-b", "Cycleb", [9002], "Stage1", "Cyclea", "Grass"),
  x("x-self", "Selfie", [9003], "Stage1", "Selfie", "Grass"),
  x("x-loop-a", "Loopy", [9004], "Stage1", "Loopier", "Grass"),
  x("x-loop-b", "Loopier", [9004], "Stage1", "Loopy", "Grass"),
  // An evolveFrom that names no card at all.
  x("x-orphan", "Orphanmon", [9005], "Stage1", "Nobodymon", "Grass"),
  // A Pokémon with no species (an odd row), beside the Trainers.
  x("x-nodex", "Nodexmon", [], "Basic", null, "Grass"),
  // Eight stages in a line: the walk's six-node cap, from the bottom, the middle and the top.
  ...Array.from({ length: 8 }, (_, i) =>
    x(
      `x-long-${i}`,
      `Long${i}`,
      [9100 + i],
      i === 0 ? "Basic" : "Stage1",
      i === 0 ? null : `Long${i - 1}`,
      "Fire",
    ),
  ),
  // JAPANESE: a chain of its own language only, a trainer form (ペパーの) and a regional one (ガラル).
  x("ja:x-hitokage", "ヒトカゲ", [4], "Basic", null, "Fire"),
  x("ja:x-lizardo", "リザード", [5], "Stage1", "ヒトカゲ", "Fire"),
  x("ja:x-lizardon", "リザードン", [6], "Stage2", "リザード", "Fire"),
  x("ja:x-lizardon-dig", "リザードン", [6], "Stage2", "リザード", "Fire", { isDigitalOnly: true }),
  x("ja:x-eievui", "イーブイ", [133], "Basic", null, "Colorless"),
  x("ja:x-showers", "シャワーズ", [134], "Stage1", "イーブイ", "Water"),
  x("ja:x-pnonokurage", "ペパーのノノクラゲ", [948], "Basic", null, "Fighting"),
  x("ja:x-prikukurage", "ペパーのリククラゲ", [949], "Stage1", "ペパーのノノクラゲ", "Fighting"),
  x("ja:x-gnyarth", "ガラルニャース", [52], "Basic", null, "Metal"),
  x("ja:x-nyaiking", "ニャイキング", [863], "Stage1", "ガラルニャース", "Metal"),
  // A Japanese Stage 1 whose Basic its own language's catalog does not have (69 ja sets are short upstream).
  x("ja:x-raichu", "ライチュウ", [26], "Stage1", "ピカチュウ", "Lightning"),
];

/** Her stand-ins, merged in after the mirror as `loadCatalogCached` merges them: en, ja, and a pre-UIL-108 one. */
const STAND_INS: CatalogCard[] = [
  x(
    "user:en:00000000-0000-4000-8000-000000000001",
    "Charmeleon",
    [5],
    "Stage1",
    "Charmander",
    "Fire",
  ),
  x("user:ja:00000000-0000-4000-8000-000000000002", "リザード", [5], "Stage1", "ヒトカゲ", "Fire"),
  x(
    "user:00000000-0000-4000-8000-000000000003",
    "Toedscruel",
    [949],
    "Stage1",
    "Toedscool",
    "Fighting",
  ),
  x("user:en:00000000-0000-4000-8000-000000000004", "Selfie", [9003], "Basic", null, "Grass"),
];

const ENGINE_FIXTURES = Object.values(F).filter(
  (v): v is CatalogCard => typeof v === "object" && v !== null && "tcgdexId" in v,
);

const BASE: CatalogCard[] = [...ENGINE_FIXTURES, ...HAND_BUILT, ...STAND_INS];

/** A seeded shuffle, so a failure names an ordering that can be run again. */
function shuffled<T>(list: readonly T[], seed: number): T[] {
  const out = [...list];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const ORDERINGS: [string, CatalogCard[]][] = [
  ["as listed", BASE],
  ["reversed", [...BASE].reverse()],
  ["shuffled (seed 7)", shuffled(BASE, 7)],
  ["shuffled (seed 2026)", shuffled(BASE, 2026)],
  ["by id", [...BASE].sort((a, b) => a.tcgdexId.localeCompare(b.tcgdexId))],
];

const asIncoming = (card: CatalogCard): IncomingCard => ({ id: "in", card, variant: "normal" });
const ids = (chain: ChainNode[]) =>
  chain.map((n) => [n.dexId, n.name, n.cards.map((c) => c.tcgdexId)]);

/* ----------------------------------------- equivalence ----------------------------------------- */

describe("buildChain on the index returns exactly what the whole-catalog filters returned", () => {
  for (const [label, catalog] of ORDERINGS) {
    it(`every card as the incoming card, catalog ${label}`, () => {
      for (const card of catalog) {
        const expected = oldBuildChain(asIncoming(card), catalog);
        // The same nodes, the same cards (the same objects) in the same order, the same labels and stages.
        expect(buildChain(asIncoming(card), catalog), card.tcgdexId).toStrictEqual(expected);
      }
    });
  }

  it("the oracle sees the cases it is here for (so a pass is not the empty case agreeing with itself)", () => {
    const at = (id: string) => BASE.find((c) => c.tcgdexId === id)!;
    const chain = (id: string, catalog = BASE) => ids(buildChain(asIncoming(at(id)), catalog));
    // Eevee stops at the branch; a Vaporeon walks back to it.
    expect(chain("x-eevee-1").map(([d]) => d)).toEqual([133]);
    expect(chain("x-vaporeon-1").map(([d]) => d)).toEqual([133, 134]);
    // Past Gloom is a branch: Oddish → Gloom only, from either end.
    expect(chain("x-oddish-1").map(([d]) => d)).toEqual([43, 44]);
    expect(chain("x-bellossom-1").map(([d]) => d)).toEqual([43, 44, 182]);
    // Galarian Meowth's Perrserker walks back to the Meowth species; Meowth itself stops at the branch.
    expect(chain("x-perrserker-1").map(([d]) => d)).toEqual([52, 863]);
    expect(chain("x-meowth-1").map(([d]) => d)).toEqual([52]);
    // English and Japanese never mix, and the stand-ins walk with their own language.
    expect(chain("ja:x-lizardo")).toEqual([
      [4, "ヒトカゲ", ["ja:x-hitokage"]],
      [5, "リザード", ["ja:x-lizardo", "user:ja:00000000-0000-4000-8000-000000000002"]],
      [6, "リザードン", ["ja:x-lizardon"]],
    ]);
    expect(chain("x-charmeleon-dup")[1][2]).toContain(
      "user:en:00000000-0000-4000-8000-000000000001",
    );
    expect(chain("x-charmeleon-dup")[1][2]).not.toContain("x-charmeleon-dig");
    // Spaces and case do not split Charmander.
    expect(chain("x-charmeleon-ws")[0][2]).toContain("x-charmander-ws");
    // The cap is on the walk FORWARD (six nodes besides the card's own); the walk back has none.
    expect(chain("x-long-0")).toHaveLength(7);
    expect(chain("x-long-7")).toHaveLength(8);
    expect(chain("x-long-3")).toHaveLength(7);
    // The orderings genuinely disagree on prev[0]: Raichu reaches Pichu only when the Pichu-naming Pikachu is first.
    const firsts = ORDERINGS.map(([, catalog]) => chain("x-raichu-1", catalog)[0][0]);
    expect(new Set(firsts)).toEqual(new Set([172, 25]));
  });

  it("rankAlternates ranks the same printings in the same order, every species, language, colour and form", () => {
    const map = F.KEY_FORM_TYPE_COLOR_MAP;
    const bands = [...new Set(Object.values(map))] as Band[];
    const forms: (CardForm | undefined)[] = [
      undefined,
      null,
      "region:galarian",
      "trainer:arven",
      "dark",
    ];
    for (const [, catalog] of ORDERINGS.slice(0, 3)) {
      const dexes = [...new Set(catalog.flatMap((c) => c.dexId))];
      for (const dex of dexes)
        for (const locale of ["en", "ja"] as Locale[])
          for (const b of bands)
            for (const form of forms) {
              const inForm = form === undefined ? undefined : { form };
              const exclude = dex === 5 ? ["x-charmeleon-dup"] : [];
              expect(
                rankAlternates(dex, b, locale, catalog, map, undefined, exclude, inForm),
                `${dex} ${locale} ${b} ${String(form)}`,
              ).toEqual(
                oldRankAlternates(dex, b, locale, catalog, map, undefined, exclude, inForm),
              );
            }
    }
  });
});

/* ------------------------------------------- the index ------------------------------------------- */

describe("the index keeps catalog order and answers each question as its filter did", () => {
  const catalog = shuffled(BASE, 11);

  it("its physical list is the filter's, in catalog order, per language and for every language", () => {
    for (const locale of ["en", "ja"] as Locale[]) {
      expect(physicalIndex(catalog, locale).cards).toEqual(oldPhysicalIn(catalog, locale));
    }
    expect(physicalIndex(catalog).cards).toEqual(catalog.filter((c) => !c.isDigitalOnly));
  });

  it("a species with several printings lists them all, in catalog order (and a card of two species under both)", () => {
    for (const locale of ["en", "ja"] as Locale[]) {
      const ix = physicalIndex(catalog, locale);
      const phys = oldPhysicalIn(catalog, locale);
      for (const dex of new Set(catalog.flatMap((c) => c.dexId))) {
        expect(printingsOfDex(ix, dex), `${locale} ${dex}`).toEqual(oldByDex(phys, dex));
      }
    }
    const charmeleons = printingsOfDex(physicalIndex(catalog, "en"), 5).map((c) => c.tcgdexId);
    expect(charmeleons.length).toBeGreaterThan(5);
    expect(charmeleons.filter((id) => id === "x-charmeleon-dup")).toHaveLength(1);
    expect(printingsOfDex(physicalIndex(catalog, "en"), 644).map((c) => c.tcgdexId)).toEqual([
      "x-pikazek-1",
    ]);
    expect(printingsOfDex(physicalIndex(catalog, "en"), 25).map((c) => c.tcgdexId)).toContain(
      "x-pikazek-1",
    );
  });

  it("a name two species share comes back with both, in catalog order; names are trimmed and lower-cased", () => {
    const ix = physicalIndex(catalog, "en");
    const phys = oldPhysicalIn(catalog, "en");
    for (const name of new Set(catalog.map((c) => c.name))) {
      expect(printingsNamed(ix, name), name).toEqual(oldByName(phys, name));
      expect(printingsNamed(ix, ` ${name.toUpperCase()}  `)).toEqual(oldByName(phys, name));
    }
    const twins = printingsNamed(ix, "Twinmon");
    expect(twins.map((c) => c.dexId[0])).toEqual(
      catalog.filter((c) => c.name === "Twinmon").map((c) => c.dexId[0]),
    );
    expect(new Set(twins.map((c) => c.dexId[0]))).toEqual(new Set([9201, 9202]));
    expect(printingsNamed(ix, "Charmander").map((c) => c.tcgdexId)).toContain("x-charmander-ws");
  });

  it("what evolves from several names comes back merged into catalog order", () => {
    const ix = physicalIndex(catalog, "en");
    const phys = oldPhysicalIn(catalog, "en");
    const frontiers = [
      new Set(["meowth", "alolan meowth", "galarian meowth"]),
      new Set(["growlithe", "hisuian growlithe"]),
      new Set(["eevee"]),
      new Set(["charmander", "nobody"]),
      new Set<string>(),
    ];
    for (const names of frontiers) {
      expect(printingsEvolvingFrom(ix, names)).toEqual(oldEvolvingFrom(phys, names));
    }
  });

  it("the Lines screen's seed and stage facts read the same cards as their scans did", () => {
    for (const dex of new Set(catalog.flatMap((c) => c.dexId))) {
      for (const locale of ["en", "ja"] as Locale[]) {
        // lib/line/join-options.ts: a line's seed, its own language first, else any.
        const before =
          catalog.find(
            (c) => !c.isDigitalOnly && c.dexId.includes(dex) && localeOfId(c.tcgdexId) === locale,
          ) ?? catalog.find((c) => !c.isDigitalOnly && c.dexId.includes(dex));
        const after =
          printingsOfDex(physicalIndex(catalog, locale), dex)[0] ??
          printingsOfDex(physicalIndex(catalog), dex)[0];
        expect(after, `${dex} ${locale}`).toBe(before);
      }
      // lib/line/load.ts `stageFacts`: the species' physical printings in every language.
      expect(printingsOfDex(physicalIndex(catalog), dex)).toEqual(
        catalog.filter((c) => !c.isDigitalOnly && c.dexId.includes(dex)),
      );
    }
  });

  it("a chain's lists are its own: changing one does not reach the index or the next chain", () => {
    const card = BASE.find((c) => c.tcgdexId === "x-charmeleon-dup")!;
    const first = buildChain(asIncoming(card), BASE);
    const expected = ids(buildChain(asIncoming(card), BASE));
    first[1].cards.length = 0;
    first[0].cards.reverse();
    expect(ids(buildChain(asIncoming(card), BASE))).toEqual(expected);
  });
});

/* ------------------------------------- built once, not per ask ------------------------------------- */

/** The catalog array, counting every pass over it (an iteration, or any whole-array method). */
function countingPasses(cards: CatalogCard[]) {
  let passes = 0;
  const WHOLE = new Set<PropertyKey>([
    Symbol.iterator,
    "filter",
    "find",
    "findIndex",
    "some",
    "every",
    "map",
    "flatMap",
    "forEach",
    "reduce",
    "includes",
    "indexOf",
    "slice",
    "concat",
  ]);
  const catalog = new Proxy([...cards], {
    get(target, key, receiver) {
      if (WHOLE.has(key)) passes += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  return { catalog, passes: () => passes };
}

/** Every card behind a proxy that counts reads of its fields. */
function countingReads(cards: CatalogCard[]) {
  let reads = 0;
  const wrapped = cards.map(
    (c) =>
      new Proxy(c, {
        get(target, key, receiver) {
          reads += 1;
          return Reflect.get(target, key, receiver);
        },
      }),
  );
  return { cards: wrapped, reads: () => reads, reset: () => (reads = 0) };
}

/** Five thousand species of one card each: enough that a scan of the catalog cannot hide in the count. */
const FILLER: CatalogCard[] = Array.from({ length: 5_000 }, (_, i) =>
  x(`x-filler-${i}`, `Fillermon${i}`, [20_000 + i], "Basic", null, "Water"),
);

describe("the index is built once per catalog and language, not once per chain", () => {
  it("forty chains in English and Japanese pass over the catalog once per language", () => {
    const { catalog, passes } = countingPasses([...BASE, ...FILLER]);
    const species = BASE.filter((c) => c.dexId.length > 0);
    const incoming = [
      ...species.filter((c) => localeOfId(c.tcgdexId) === "en").slice(0, 30),
      ...species.filter((c) => localeOfId(c.tcgdexId) === "ja").slice(0, 10),
    ];
    expect(incoming).toHaveLength(40);
    for (const card of incoming) buildChain(asIncoming(card), catalog);
    for (const card of incoming) {
      const locale = localeOfId(card.tcgdexId);
      rankAlternates(card.dexId[0], "red" as Band, locale, catalog, F.KEY_FORM_TYPE_COLOR_MAP);
    }
    // PRE-INDEX: one `filter` per chain and per ranking, 80 here, and 3 to 8 more over the language's printings each.
    expect(passes()).toBe(2);
  });

  it("once built, a chain reads the fields of the cards in its family, not of the whole catalog", () => {
    const { cards, reads, reset } = countingReads([...BASE, ...FILLER]);
    const charmeleon = cards.find((c) => c.tcgdexId === "x-charmeleon-dup")!;
    buildChain(asIncoming(cards.find((c) => c.tcgdexId === "x-rowlet-1")!), cards); // builds the index
    reset();
    const ASKS = 50;
    for (let i = 0; i < ASKS; i++) buildChain(asIncoming(charmeleon), cards);
    // A Charmander family chain reads a few hundred fields; a filter of the catalog reads 10,000+ (every card's
    // `isDigitalOnly` and `tcgdexId`) on its own, per chain.
    expect(reads() / ASKS).toBeLessThan(1_000);
  });

  it("chainFor hands back the one chain it built for a card and catalog", () => {
    const card = BASE.find((c) => c.tcgdexId === "x-dartrix-1")!;
    const catalog = [...BASE];
    expect(chainFor(card, catalog)).toBe(chainFor(card, catalog));
    expect(chainFor(card, [...BASE])).not.toBe(chainFor(card, catalog));
    expect(chainFor(card, [...BASE])).toStrictEqual(chainFor(card, catalog));
  });
});
