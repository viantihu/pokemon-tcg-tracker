/**
 * UIL-047 — one namespace helper, and the three places that must honour it: the mirror's row builder,
 * the set-name fallback, and artwork clustering. Real PGlite where a query is involved.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { catalogCardRepo } from "@/lib/repo";
import {
  isLocale,
  localeOfId,
  localeTag,
  namespaceId,
  normalizeLocale,
  stripLocaleNamespace,
} from "@/lib/catalog/locale";
import { regroupArtwork, toCatalogRow } from "@/lib/catalog/mirror";
import type { TcgdexCardFull } from "@/lib/catalog/tcgdex";
import { asSuperuser, freshRpcDb } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

describe("the locale namespace helpers", () => {
  it("en is verbatim, ja is prefixed, and the prefix reads back", () => {
    expect(namespaceId("en", "sv03-027")).toBe("sv03-027");
    expect(namespaceId("ja", "sv11w-002")).toBe("ja:sv11w-002");
    expect(localeOfId("ja:sv11w-002")).toBe("ja");
    expect(localeOfId("sv03-027")).toBe("en");
    expect(localeOfId("user:abc")).toBe("en"); // a stand-in (0015) is an English-space row
    expect(stripLocaleNamespace("ja:sv11w")).toBe("sv11w");
    expect(stripLocaleNamespace("sv11w")).toBe("sv11w");
    expect(stripLocaleNamespace(null)).toBe("");
    expect(localeTag("ja:sv11w-002")).toBe("JA");
    expect(localeTag("sv03-027")).toBeNull();
  });

  it("normalizeLocale: keys are ja / en; the export's display text maps at the boundary", () => {
    expect(normalizeLocale("ja")).toBe("ja");
    expect(normalizeLocale("Japanese")).toBe("ja");
    expect(normalizeLocale(" japanese ")).toBe("ja");
    expect(normalizeLocale("English")).toBe("en");
    expect(normalizeLocale("International")).toBe("en");
    expect(normalizeLocale(null)).toBe("en");
    expect(isLocale("ja")).toBe(true);
    expect(isLocale("fr")).toBe(false);
  });
});

const card = (id: string, setId: string): TcgdexCardFull =>
  ({
    id,
    localId: id.split("-")[1],
    name: "Card",
    image: `https://assets.tcgdex.net/ja/sv/${setId}/${id.split("-")[1]}`,
    set: { id: setId, name: "Set", cardCount: { official: 100, total: 110 } },
  }) as unknown as TcgdexCardFull;

describe("toCatalogRow honours the locale", () => {
  it("ja: namespaced id and set id, locale stamped, image verbatim; en: byte-identical to before", () => {
    const ja = toCatalogRow(card("sv11w-002", "sv11w"), { isDigitalOnly: false, locale: "ja" });
    expect(ja).toMatchObject({
      tcgdex_id: "ja:sv11w-002",
      set_id: "ja:sv11w",
      local_id: "002",
      locale: "ja",
      image_url: "https://assets.tcgdex.net/ja/sv/sv11w/002",
    });
    const en = toCatalogRow(card("sv03-027", "sv03"), { isDigitalOnly: false });
    expect(en).toMatchObject({ tcgdex_id: "sv03-027", set_id: "sv03", locale: "en" });
  });
});

describe("on real Postgres", () => {
  let db: PGlite;
  beforeEach(async () => {
    db = await freshRpcDb();
    await asSuperuser(db);
    await db.exec(`
      insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id, locale, artwork_hash) values
        ('sv11w-002', 'Charizard', 'sv11w', 'White Flare', '002', 'en', 'aaaaaaaaaaaaaaaa'),
        ('ja:sv11w-002', 'リザードン', 'ja:sv11w', 'White Flare', '002', 'ja', 'aaaaaaaaaaaaaaaa'),
        ('sv11w-003', 'Other', 'sv11w', 'White Flare', '003', 'en', 'ffffffffffffffff');
    `);
  });
  afterEach(async () => {
    await db.close();
  });

  it("findSetIdsByName is locale-scoped: the same set name in both catalogs answers per locale", async () => {
    const client = pgliteClient(db);
    expect(await catalogCardRepo.findSetIdsByName(client, "White Flare", "en")).toEqual(["sv11w"]);
    expect(await catalogCardRepo.findSetIdsByName(client, "White Flare", "ja")).toEqual([
      "ja:sv11w",
    ]);
    expect(await catalogCardRepo.findSetIdsByName(client, "White Flare")).toEqual(["sv11w"]); // default en
  });

  it("artwork clustering never merges a Japanese printing with its English twin", async () => {
    await regroupArtwork(pgliteClient(db), {}); // no hasher: cluster the stored hashes only
    const rows = (
      await db.query<{ tcgdex_id: string; artwork_group_id: string | null }>(
        `select tcgdex_id, artwork_group_id from catalog_card order by 1`,
      )
    ).rows;
    const g = Object.fromEntries(rows.map((r) => [r.tcgdex_id, r.artwork_group_id]));
    // Identical hashes, different locales → different groups (L5: different cards).
    expect(g["ja:sv11w-002"]).not.toBeNull();
    expect(g["sv11w-002"]).not.toBeNull();
    expect(g["ja:sv11w-002"]).not.toBe(g["sv11w-002"]);
    expect(g["sv11w-003"]).not.toBe(g["sv11w-002"]);
  });
});
