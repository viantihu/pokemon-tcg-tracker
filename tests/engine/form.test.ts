/**
 * UIL-133: a card's FORM, the second half of a line's identity. Karvi, 2026-10-01: "The evolution line can only belong
 * to the trainer/ region"; 2026-10-02: Dark and Light Pokémon get their own lines too.
 *
 * Every card below is a real TCGdex printing (but the one marked), checked against https://api.tcgdex.net/v2/{en,ja}/cards/<id> on
 * 2026-10-01/02: name, dexId, stage, evolveFrom and type as TCGdex has them, including where TCGdex's evolveFrom is
 * not what the printed card says (Sabrina's Hypno gym2-56 evolves from "Drowzee"; Dark Charizard base5-4 from
 * "Charmeleon"). Prices are not part of identity and are left out.
 */
import { describe, expect, it } from "vitest";
import {
  formFit,
  formLabel,
  formOf,
  lineFormOf,
  lineLabel,
  nameInForm,
  ownFormOf,
} from "@/lib/engine/form";
import { placeCard, type EngineContext } from "@/lib/engine/cascade";
import { generateSlots, testViability } from "@/lib/engine/line";
import type { CatalogCard, EvolutionLine, OwnedCopy } from "@/lib/engine/types";
import { CHARMANDER_SV03_026 } from "./fixtures";

const real = (
  id: string,
  name: string,
  dex: number,
  stage: string,
  evolveFrom: string | null,
  type: string,
): CatalogCard => ({
  ...CHARMANDER_SV03_026,
  tcgdexId: id,
  name,
  dexId: [dex],
  setId: id.split("-")[0],
  localId: id.split("-")[1] ?? id,
  stage,
  evolveFrom,
  types: [type],
  artworkGroupId: `art-${id}`,
});

const TOEDSCOOL = real("sv03-118", "Toedscool", 948, "Basic", null, "Fighting");
const TOEDSCRUEL = real("sv09-089", "Toedscruel", 949, "Stage1", "Toedscool", "Fighting");
const ARVENS_TOEDSCOOL = real("sv10-109", "Arven's Toedscool", 948, "Basic", null, "Fighting");
const ARVENS_TOEDSCRUEL = real(
  "sv10-110",
  "Arven's Toedscruel",
  949,
  "Stage1",
  "Arven's Toedscool",
  "Fighting",
);
const PIKACHU = real("base1-58", "Pikachu", 25, "Basic", null, "Lightning");
const ALOLAN_RAICHU = real("sm4-31", "Alolan Raichu", 26, "Stage1", "Pikachu", "Lightning");
const SABRINAS_DROWZEE = real("gym1-92", "Sabrina's Drowzee", 96, "Basic", null, "Psychic");
const SABRINAS_HYPNO = real("gym2-56", "Sabrina's Hypno", 97, "Stage1", "Drowzee", "Psychic");
const PLAIN_DROWZEE = real("base1-49", "Drowzee", 96, "Basic", null, "Psychic");
const DARK_CHARMELEON = real("base5-32", "Dark Charmeleon", 5, "Stage1", "Charmander", "Fire");
const DARK_CHARIZARD = real("base5-4", "Dark Charizard", 6, "Stage2", "Charmeleon", "Fire");
const LIGHT_ARCANINE = real("neo4-12", "Light Arcanine", 59, "Stage1", "Growlithe", "Fire");
const ROWLET = real("2017sm-1", "Rowlet", 722, "Basic", null, "Grass");
const DARTRIX = real("sv06.5-004", "Dartrix", 723, "Stage1", "Rowlet", "Grass");
const HISUIAN_DECIDUEYE = real(
  "swsh10-082",
  "Hisuian Decidueye",
  724,
  "Stage2",
  "Dartrix",
  "Fighting",
);
const JA_ARVENS_TOEDSCOOL = real(
  "ja:SV9a-047",
  "ペパーのノノクラゲ",
  948,
  "Basic",
  null,
  "Fighting",
);
// TCGdex's ja SV9a-048 has no evolveFrom: its own name says its form.
const JA_ARVENS_TOEDSCRUEL = real(
  "ja:SV9a-048",
  "ペパーのリククラゲ",
  949,
  "Stage1",
  null,
  "Fighting",
);
const JA_ALOLAN_SANDSHREW = real("ja:SM5M-001", "アローラサンド", 27, "Basic", null, "Water");
const JA_DARK_ARBOK = real("ja:PMCG4-008", "わるいアーボック", 24, "Stage1", null, "Grass");

const CATALOG = [
  TOEDSCOOL,
  TOEDSCRUEL,
  ARVENS_TOEDSCOOL,
  ARVENS_TOEDSCRUEL,
  PIKACHU,
  ALOLAN_RAICHU,
  SABRINAS_DROWZEE,
  SABRINAS_HYPNO,
  PLAIN_DROWZEE,
  CHARMANDER_SV03_026,
  DARK_CHARMELEON,
  DARK_CHARIZARD,
  LIGHT_ARCANINE,
  ROWLET,
  DARTRIX,
  HISUIAN_DECIDUEYE,
  JA_ARVENS_TOEDSCOOL,
  JA_ARVENS_TOEDSCRUEL,
  JA_ALOLAN_SANDSHREW,
  JA_DARK_ARBOK,
];

describe("ownFormOf: the line-class check's own rules, in its order", () => {
  it.each([
    ["Arven's Toedscool", "sv10-109", "trainer:arven"],
    ["Arven’s Toedscool", "sv10-109", "trainer:arven"],
    ["Team Rocket's Mewtwo ex", "sv10-081", "trainer:team rocket"],
    ["Lt. Surge's Raichu", "gym2-11", "trainer:lt. surge"],
    ["Rocket's Hitmonchan", "gym1-11", "trainer:rocket"],
    ["Alolan Raichu", "sm4-31", "region:alolan"],
    ["Galarian Obstagoon", "swsh3.5-37", "region:galarian"],
    ["Hisuian Decidueye", "swsh10-082", "region:hisuian"],
    ["Dark Charizard", "base5-4", "dark"],
    ["Light Arcanine", "neo4-12", "light"],
    ["ペパーのノノクラゲ", "ja:SV9a-047", "trainer:ペパー"],
    ["アローラサンド", "ja:SM5M-001", "region:alolan"],
    ["わるいアーボック", "ja:PMCG4-008", "dark"],
    ["Toedscool", "sv03-118", null],
    ["Galarian Farfetch'd", "swsh2-94", "region:galarian"],
    ["Farfetch'd", "base1-27", null],
    ["Mr. Mime", "base2-6", null],
    ["Darkrai", "dp5-3", null],
  ])("%s (%s) → %s", (name, id, form) => {
    expect(ownFormOf(name, id)).toBe(form);
  });

  it("reads a Japanese trainer's の only on a Japanese card", () => {
    expect(ownFormOf("ペパーのノノクラゲ", "sv10-109")).toBeNull();
  });

  it("a Japanese forme with a space before its の is that Pokémon's, not a trainer's (the TL's review of #454)", () => {
    expect(ownFormOf("オーガポン みどりのめん", "ja:MC-080")).toBeNull();
    expect(ownFormOf("ネクロズマ あかつきのつばさ", "ja:SM5p-021")).toBeNull();
    expect(ownFormOf("ポワルン たいようのすがた", "ja:MC-102")).toBeNull();
    expect(ownFormOf("エリカのナゾノクサ", "ja:MC-001")).toBe("trainer:エリカ");
    expect(ownFormOf("ロケット団のミュウツーex", "ja:M2a-063")).toBe("trainer:ロケット団");
  });

  it("a Trainer or Energy card has no form, whatever its name says (it never joins a line)", () => {
    const trainer = (id: string, name: string): CatalogCard => ({
      ...CHARMANDER_SV03_026,
      tcgdexId: id,
      name,
      dexId: [],
      stage: null,
      evolveFrom: null,
      types: [],
      category: "Trainer",
    });
    // Real Trainer cards (TCGdex): Boss's Orders, Arven's Sandwich, Dark Patch.
    for (const c of [
      trainer("me01-114", "Boss's Orders"),
      trainer("sv10-161", "Arven's Sandwich"),
      trainer("swsh10-139", "Dark Patch"),
    ]) {
      expect(formOf(c, [...CATALOG, c])).toBeNull();
    }
  });
});

describe("formOf: a card that names no form takes the form it evolves from", () => {
  it("an unprefixed evolution of a regional form is that form (a safety net: TCGdex en prefixes them today)", () => {
    const galarianMeowth = real("swsh12.5-084", "Galarian Meowth", 52, "Basic", null, "Metal");
    // NOT a real printing: TCGdex names every one "Galarian Perrserker" (swsh12.5-085). This one drops the prefix.
    const perrserker = real("x-863", "Perrserker", 863, "Stage1", "Galarian Meowth", "Metal");
    expect(formOf(perrserker, [galarianMeowth, perrserker])).toBe("region:galarian");
  });

  it("a plain card stays plain, and a prefixed one keeps its own", () => {
    expect(formOf(TOEDSCRUEL, CATALOG)).toBeNull();
    expect(formOf(ARVENS_TOEDSCRUEL, CATALOG)).toBe("trainer:arven");
    expect(formOf(JA_ARVENS_TOEDSCRUEL, CATALOG)).toBe("trainer:ペパー");
  });
});

describe("formFit: of the line's form, or a plain card that form evolves from", () => {
  it("Arven's Toedscool and Toedscool are two lines (her report)", () => {
    expect(formFit(ARVENS_TOEDSCOOL, "trainer:arven", CATALOG)).toBe("same");
    expect(formFit(ARVENS_TOEDSCOOL, null, CATALOG)).toBe("other");
    expect(formFit(TOEDSCOOL, "trainer:arven", CATALOG)).toBe("other");
    expect(formFit(TOEDSCOOL, null, CATALOG)).toBe("same");
  });

  it("a plain Pikachu is at home under an Alolan Raichu, which evolves from it; an Alolan Raichu is not plain", () => {
    expect(formFit(PIKACHU, "region:alolan", CATALOG)).toBe("same");
    expect(formFit(PIKACHU, null, CATALOG)).toBe("same");
    expect(formFit(ALOLAN_RAICHU, null, CATALOG)).toBe("other");
  });

  it("her mixed Drowzee line reads as one line: TCGdex gives Sabrina's Hypno a plain Drowzee", () => {
    expect(formFit(PLAIN_DROWZEE, "trainer:sabrina", CATALOG)).toBe("same");
    expect(formFit(SABRINAS_DROWZEE, "trainer:sabrina", CATALOG)).toBe("same");
    expect(formFit(SABRINAS_HYPNO, null, CATALOG)).toBe("other");
  });

  it("every plain stage under a regional final form: Rowlet and Dartrix under a Hisuian Decidueye", () => {
    expect(formFit(ROWLET, "region:hisuian", CATALOG)).toBe("same");
    expect(formFit(DARTRIX, "region:hisuian", CATALOG)).toBe("same");
    expect(formFit(HISUIAN_DECIDUEYE, null, CATALOG)).toBe("other");
  });

  it("Dark and Light Pokémon are their own lines (Karvi, 2026-10-02)", () => {
    expect(formFit(DARK_CHARMELEON, null, CATALOG)).toBe("other");
    expect(formFit(DARK_CHARIZARD, "dark", CATALOG)).toBe("same");
    expect(formFit(CHARMANDER_SV03_026, "dark", CATALOG)).toBe("same");
    expect(formFit(LIGHT_ARCANINE, "dark", CATALOG)).toBe("other");
  });

  it("in Japanese too, and one language never vouches for the other", () => {
    expect(formFit(JA_ARVENS_TOEDSCOOL, "trainer:ペパー", CATALOG)).toBe("same");
    expect(formFit(JA_ARVENS_TOEDSCOOL, "trainer:arven", CATALOG)).toBe("other");
    expect(formFit(JA_ALOLAN_SANDSHREW, "region:alolan", CATALOG)).toBe("same");
  });
});

describe("lineFormOf: the most evolved known card with a form names the line", () => {
  it("a plain card under a form card does not make the line plain", () => {
    expect(lineFormOf([PLAIN_DROWZEE, SABRINAS_HYPNO], CATALOG)).toBe("trainer:sabrina");
    expect(lineFormOf([PIKACHU, ALOLAN_RAICHU], CATALOG)).toBe("region:alolan");
    expect(lineFormOf([null, ARVENS_TOEDSCRUEL], CATALOG)).toBe("trainer:arven");
  });

  it("a line of plain cards, or of none, is plain", () => {
    expect(lineFormOf([TOEDSCOOL, TOEDSCRUEL], CATALOG)).toBeNull();
    expect(lineFormOf([PIKACHU], CATALOG)).toBeNull();
    expect(lineFormOf([null, undefined], CATALOG)).toBeNull();
  });
});

describe("names and labels", () => {
  it("a stage goes by its name in the line's form", () => {
    expect(nameInForm([TOEDSCOOL, ARVENS_TOEDSCOOL], "trainer:arven", CATALOG)).toBe(
      "Arven's Toedscool",
    );
    expect(nameInForm([ARVENS_TOEDSCOOL, TOEDSCOOL], null, CATALOG)).toBe("Toedscool");
  });

  it("a line's label says its form, after a root whose name does not", () => {
    expect(lineLabel("Arven's Toedscool", "trainer:arven", "sv10-109")).toBe(
      "ARVEN'S TOEDSCOOL LINE",
    );
    expect(lineLabel("Toedscool", null, "sv03-118")).toBe("TOEDSCOOL LINE");
    expect(lineLabel("Rowlet", "region:hisuian", "2017sm-1")).toBe("ROWLET LINE · HISUIAN");
    expect(lineLabel("ペパーのノノクラゲ", "trainer:ペパー", "ja:SV9a-047")).toBe(
      "ペパーのノノクラゲ LINE",
    );
    expect(lineLabel("", null, "")).toBe("EVOLUTION LINE");
  });

  it("a form as she reads it", () => {
    expect(formLabel("trainer:team rocket")).toBe("Team Rocket's");
    expect(formLabel("trainer:lt. surge")).toBe("Lt. Surge's");
    expect(formLabel("trainer:ペパー")).toBe("ペパーの");
    expect(formLabel("region:galarian")).toBe("Galarian");
    expect(formLabel("light")).toBe("Light");
    expect(formLabel(null)).toBeNull();
  });
});

describe("a new line in a form (UIL-133): its own printings proposed, its own cards pulled", () => {
  const MAP = { Fighting: "orange" };
  const owned = (id: string, c: CatalogCard): OwnedCopy => ({
    id,
    card: c,
    variant: "normal",
    role: "shelved",
    binderId: "kb1",
    binderHalf: "front",
    colorBand: "orange",
    lineSlotId: null,
  });
  const start = (incoming: CatalogCard, mine: OwnedCopy[]) => {
    const inc = { id: "in", card: incoming, variant: "normal" as const };
    return generateSlots(inc, testViability(inc, mine, CATALOG, MAP), mine, CATALOG, MAP);
  };

  it("an Arven's Toedscool's line wants an Arven's Toedscruel, and never pulls her plain one into it", () => {
    const gen = start(ARVENS_TOEDSCOOL, [owned("plain-cruel", TOEDSCRUEL)]);
    expect(gen.slots[1]).toMatchObject({
      state: "placeholder",
      copyId: null,
      targetCatalogCardId: "sv10-110",
    });
  });

  it("but pulls her Arven's Toedscruel; and a plain Toedscool's line pulls the plain one", () => {
    expect(
      start(ARVENS_TOEDSCOOL, [owned("arven-cruel", ARVENS_TOEDSCRUEL)]).slots[1],
    ).toMatchObject({ state: "filled", copyId: "arven-cruel" });
    expect(start(TOEDSCOOL, [owned("plain-cruel", TOEDSCRUEL)]).slots[1]).toMatchObject({
      state: "filled",
      copyId: "plain-cruel",
    });
  });
});

describe("the cascade asks a line's form once while the line is unchanged, and again when it changes", () => {
  it("the same line object, its Stage 1 swapped from plain to Arven's between two cards, is read again", () => {
    const line: EvolutionLine = {
      id: "L",
      rootDexId: 948,
      colorBand: "orange",
      binderId: "KB1",
      status: "open",
      slots: [
        {
          id: "s0",
          stageIndex: 0,
          stage: "Basic",
          state: "placeholder",
          copyId: null,
          dexId: null,
          targetCatalogCardId: null,
        },
        {
          id: "s1",
          stageIndex: 1,
          stage: "Stage1",
          state: "filled",
          copyId: "c1",
          dexId: 949,
          targetCatalogCardId: null,
        },
      ],
    };
    const ownedCruel = (id: string, c: CatalogCard): OwnedCopy => ({
      id,
      card: c,
      variant: "normal",
      role: "shelved",
      binderId: "KB1",
      binderHalf: "back",
      colorBand: "orange",
      lineSlotId: "s1",
    });
    const ctx: EngineContext = {
      typeColorMap: { Fighting: "orange" },
      catalog: CATALOG,
      owned: [ownedCruel("c1", TOEDSCRUEL)],
      binders: [{ id: "KB1", name: "KB-001", type: "general", isActive: true }],
      lines: [line],
      collections: [],
      now: "2026-10-02T00:00:00.000Z",
    };
    const into = () => {
      const res = placeCard({ id: "in", card: ARVENS_TOEDSCOOL, variant: "normal" }, ctx);
      return res.target.kind === "back-half-line" ? res.target.lineId : res.target.kind;
    };
    // A plain line: an Arven's Toedscool is not proposed there.
    expect(into()).not.toBe("L");
    // Same line object, now holding her Arven's Toedscruel: it is her Arven's line.
    line.slots[1] = { ...line.slots[1], copyId: "c2" };
    ctx.owned = [ownedCruel("c2", ARVENS_TOEDSCRUEL)];
    expect(into()).toBe("L");
  });
});
