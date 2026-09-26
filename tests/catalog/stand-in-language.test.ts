/**
 * UIL-108 — a stand-in records the language its card is printed in, and the language travels in its id.
 *
 * Karvi's ruling: offer every language TCGdex publishes, pre-filled from the Dex row's locale; show it on the
 * stand-in wherever it appears; and use it so the later swap to TCGdex's real card picks the same-language
 * printing. The Senior BA's: the id carries it (`user:<language>:<uuid>`); Dex writes "International" and
 * "Japanese"; a `user:ja:` stand-in is scoped with the Japanese printings, every other language stays
 * English-scoped. The pure halves are pinned here; the database halves in
 * tests/sync/stand-in-language.test.ts.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cardTag,
  isStandInId,
  knownDexLocale,
  languageOfId,
  localeOfId,
  localeTag,
  normalizeLocale,
  standInIdFor,
  standInLabel,
  TCGDEX_LANGUAGES,
} from "@/lib/catalog/locale";
import { realPrintingFor, type MirroredPrinting } from "@/lib/catalog/stand-in";
import { buildChain, lineLocaleOf, type CatalogCard, type IncomingCard } from "@/lib/engine";

const UUID = "0f0e0d0c-0b0a-4908-8706-050403020100";

describe("UIL-108 · the languages offered", () => {
  it("are exactly TCGdex's, as probed 2026-09-26: 17, and not pt-pt, which serves no sets", () => {
    expect(TCGDEX_LANGUAGES.map((l) => l.code)).toEqual([
      "en",
      "ja",
      "fr",
      "de",
      "it",
      "es",
      "es-mx",
      "pt",
      "pt-br",
      "nl",
      "pl",
      "ru",
      "ko",
      "zh-tw",
      "zh-cn",
      "id",
      "th",
    ]);
    expect(TCGDEX_LANGUAGES.every((l) => l.name.length > 0)).toBe(true);
  });

  it("agree with migration 0027, which lists them twice (the column check and the id shape)", () => {
    const sql = readFileSync(
      path.join(process.cwd(), "supabase", "migrations", "0027_stand_in_language.sql"),
      "utf8",
    );
    const codes = TCGDEX_LANGUAGES.map((l) => l.code);
    const inCheck = sql
      .match(/locale in \(([\s\S]*?)\)\s*\);/)![1]
      .match(/'([a-z-]+)'/g)!
      .map((q) => q.slice(1, -1));
    expect(inCheck).toEqual(codes);
    const inShape = sql.match(/\^user:\(\(([a-z|-]+)\):\)\?/)![1].split("|");
    expect(inShape).toEqual(codes);
  });
});

describe("UIL-108 · the pre-fill reads the Dex row's Locale", () => {
  it("International is English and Japanese is Japanese: the two values on her data", () => {
    expect(knownDexLocale("International")).toBe("en");
    expect(knownDexLocale("Japanese")).toBe("ja");
    expect(knownDexLocale(" international ")).toBe("en");
    expect(knownDexLocale("English")).toBe("en");
  });

  it("anything else pre-fills NOTHING, so she picks rather than being guessed at", () => {
    for (const v of ["French", "Klingon", "", null, undefined])
      expect(knownDexLocale(v)).toBeNull();
  });

  it("the importer's own reading is unchanged: everything that is not Japanese is English", () => {
    // The one mapping, reused: normalizeLocale is knownDexLocale with an English default.
    expect(normalizeLocale("International")).toBe("en");
    expect(normalizeLocale("Japanese")).toBe("ja");
    expect(normalizeLocale("French")).toBe("en");
    expect(normalizeLocale(null)).toBe("en");
  });
});

describe("UIL-108 · the language in the id", () => {
  it("a new stand-in's id is user:<language>:<uuid>", () => {
    expect(standInIdFor("fr")).toMatch(
      /^user:fr:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(standInIdFor("zh-tw")).toMatch(/^user:zh-tw:/);
    expect(isStandInId(standInIdFor("en"))).toBe(true);
  });

  it("languageOfId reads it back; a stand-in made before UIL-108 recorded none", () => {
    expect(languageOfId(`user:fr:${UUID}`)).toBe("fr");
    expect(languageOfId(`user:pt-br:${UUID}`)).toBe("pt-br");
    expect(languageOfId(`user:${UUID}`)).toBeNull();
    expect(languageOfId(`user:xx:${UUID}`)).toBeNull(); // not a language we offer
    // A mirrored card's language is its locale.
    expect(languageOfId("sv09-089")).toBe("en");
    expect(languageOfId("ja:SV9-089")).toBe("ja");
  });

  it("a Japanese stand-in is scoped Japanese; every other stand-in stays English-scoped (the Senior BA's ruling)", () => {
    expect(localeOfId(`user:ja:${UUID}`)).toBe("ja");
    expect(localeOfId(`user:fr:${UUID}`)).toBe("en");
    expect(localeOfId(`user:en:${UUID}`)).toBe("en");
    expect(localeOfId(`user:${UUID}`)).toBe("en");
    expect(localeOfId("ja:SV9-089")).toBe("ja");
    expect(localeOfId("sv09-089")).toBe("en");
  });

  it("is labelled on every set line: Stand-in · FR, and a Japanese stand-in is not tagged JA twice", () => {
    expect(standInLabel(`user:fr:${UUID}`)).toBe("Stand-in · FR");
    expect(standInLabel(`user:${UUID}`)).toBe("Stand-in");
    expect(standInLabel("sv09-089")).toBeNull();
    expect(cardTag(`user:ja:${UUID}`)).toBe("Stand-in · JA");
    expect(localeTag(`user:ja:${UUID}`)).toBe("JA"); // what cardTag must not add on top
    expect(cardTag("ja:SV9-089")).toBe("JA");
    expect(cardTag("sv09-089")).toBeNull();
  });
});

describe("UIL-108 · a Japanese stand-in lives with the Japanese printings (UIL-090's rule)", () => {
  const card = (
    tcgdexId: string,
    name: string,
    dexId: number,
    stage: string,
    from: string | null,
  ) =>
    ({
      tcgdexId,
      name,
      dexId: [dexId],
      types: ["Fighting"],
      stage,
      evolveFrom: from,
      cardClass: "standard",
      isDigitalOnly: false,
    }) as unknown as CatalogCard;
  const CATALOG: CatalogCard[] = [
    card("sv09-088", "Toedscool", 9481, "Basic", null),
    card("ja:SV9-088", "ノノクラゲ", 9481, "Basic", null),
    card(`user:ja:${UUID}`, "ノノクラゲex", 9482, "Stage1", "ノノクラゲ"),
  ];

  it("its chain holds only Japanese printings", () => {
    const standIn = CATALOG[2];
    const chain = buildChain(
      { id: "x", card: standIn, variant: "normal" } as IncomingCard,
      CATALOG,
    );
    expect(chain.flatMap((n) => n.cards.map((c) => c.tcgdexId))).toEqual([
      "ja:SV9-088",
      `user:ja:${UUID}`,
    ]);
  });

  it("a line it fills reads as Japanese; one a French stand-in fills reads as English", () => {
    const slot = (copyId: string) => ({
      id: "s0",
      stageIndex: 0,
      stage: "Basic",
      state: "filled" as const,
      copyId,
      dexId: null,
      targetCatalogCardId: null,
    });
    expect(lineLocaleOf([slot("c1")], () => `user:ja:${UUID}`)).toBe("ja");
    expect(lineLocaleOf([slot("c1")], () => `user:fr:${UUID}`)).toBe("en");
  });
});

describe("UIL-108 · the real card a stand-in stands in for (the rule the later swap will use)", () => {
  const printing = (over: Partial<MirroredPrinting>): MirroredPrinting => ({
    tcgdexId: "sv09-089",
    setId: "sv09",
    localId: "089",
    locale: "en",
    isDigitalOnly: false,
    ...over,
  });
  const EN = printing({});
  const JA = printing({ tcgdexId: "ja:SV9-089", setId: "ja:SV9", locale: "ja" });

  it("an English stand-in's candidate is the English printing with its set and number", () => {
    expect(
      realPrintingFor({ tcgdexId: `user:en:${UUID}`, setId: "sv09", localId: "089" }, [JA, EN]),
    ).toBe("sv09-089");
  });

  it("a Japanese stand-in's is the Japanese printing, never the English one with the same number", () => {
    expect(
      realPrintingFor({ tcgdexId: `user:ja:${UUID}`, setId: "ja:SV9", localId: "089" }, [EN, JA]),
    ).toBe("ja:SV9-089");
    // Same set id and number as the English card, but a Japanese stand-in: no English candidate.
    expect(
      realPrintingFor({ tcgdexId: `user:ja:${UUID}`, setId: "sv09", localId: "089" }, [EN, JA]),
    ).toBeNull();
  });

  it("a language the catalog does not mirror has no candidate", () => {
    expect(
      realPrintingFor({ tcgdexId: `user:fr:${UUID}`, setId: "sv09", localId: "089" }, [EN, JA]),
    ).toBeNull();
  });

  it("a stand-in with no recorded language, or no known set, has no candidate", () => {
    expect(
      realPrintingFor({ tcgdexId: `user:${UUID}`, setId: "sv09", localId: "089" }, [EN]),
    ).toBeNull();
    expect(
      realPrintingFor({ tcgdexId: `user:en:${UUID}`, setId: null, localId: "089" }, [EN]),
    ).toBeNull();
  });

  it("numbers compare the way the importer compares them; digital-only cards and stand-ins never count", () => {
    expect(
      realPrintingFor({ tcgdexId: `user:en:${UUID}`, setId: "sv09", localId: "89" }, [EN]),
    ).toBe("sv09-089");
    expect(
      realPrintingFor({ tcgdexId: `user:en:${UUID}`, setId: "sv09", localId: "089" }, [
        printing({ isDigitalOnly: true }),
        printing({ tcgdexId: `user:en:${UUID.replace("0f", "1f")}` }),
      ]),
    ).toBeNull();
  });
});
