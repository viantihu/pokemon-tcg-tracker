/**
 * UIL-083 — two Japanese-catalog payload shapes the mirror rejected, and the "+" in five set ids.
 *
 * Read-only against TCGdex before this was written: /ja/sets/PCG2 lists PCG2-067 レイカザの星 (Rayquaza ★)
 * with `dexId: [384.1]` — a FRACTIONAL Pokédex number marking a variant printing — which Postgres rejected
 * for `dex_id integer[]` (22P02) and took the whole set down with it. And `/ja/sets/SM1%2B` is 200 while
 * `/ja/sets/SM1%20` is 404: the "+" in SM1+, sm2+, SM3+, SM4+, SM5+ was reaching TCGdex as a space because
 * URLSearchParams decodes a bare plus that way.
 */
import { describe, expect, it, vi } from "vitest";
import { toCatalogRow, toDexIds } from "@/lib/catalog/mirror";
import { createTcgdexClient, type TcgdexCardFull } from "@/lib/catalog/tcgdex";
import { rawQueryParam } from "@/lib/catalog/query";

/** The real shape of PCG2-067 as TCGdex serves it (fields the row builder reads). */
const RAYQUAZA_STAR = {
  id: "PCG2-067",
  localId: "067",
  name: "レイカザの星",
  category: "Pokemon",
  dexId: [384.1],
  hp: 90,
  types: ["Colorless"],
  stage: "Basic",
  set: { id: "PCG2", name: "ロケット団の逆襲", cardCount: { official: 84, total: 84 } },
  image: "https://assets.tcgdex.net/ja/pcg/PCG2/067",
} as unknown as TcgdexCardFull;

describe("UIL-083 · a fractional Pokédex id lands as its species, the row is not lost", () => {
  it("toDexIds floors 384.1 to 384 and drops anything that is not a finite number", () => {
    expect(toDexIds([384.1])).toEqual([384]);
    expect(toDexIds([4, 5.9, "x", null, NaN, Infinity])).toEqual([4, 5]);
    expect(toDexIds(undefined)).toEqual([]);
    expect(toDexIds(null)).toEqual([]);
  });

  it("toCatalogRow on the real PCG2-067 payload: dex_id [384], namespaced ja id, everything else intact", () => {
    const row = toCatalogRow(RAYQUAZA_STAR, { isDigitalOnly: false, locale: "ja" });
    expect(row).toMatchObject({
      tcgdex_id: "ja:PCG2-067",
      set_id: "ja:PCG2",
      local_id: "067",
      dex_id: [384],
      hp: 90,
      locale: "ja",
      name: "レイカザの星",
    });
  });

  it("a decimal hp becomes null rather than an integer-column error", () => {
    const row = toCatalogRow({ ...RAYQUAZA_STAR, hp: 60.5 } as TcgdexCardFull, {
      isDigitalOnly: false,
    });
    expect(row.hp).toBeNull();
    expect(
      toCatalogRow({ ...RAYQUAZA_STAR, hp: 60 } as TcgdexCardFull, { isDigitalOnly: false }).hp,
    ).toBe(60);
  });
});

describe("UIL-083 · a set id containing '+' reaches TCGdex as %2B", () => {
  it("the client percent-encodes the path segment for sets and cards", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ id: "SM1+", cards: [] }), { status: 200 });
    });
    const client = createTcgdexClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      locale: "ja",
    });
    await client.getSet("SM1+");
    await client.getCard("SM1+-001");
    expect(urls).toEqual([
      "https://api.tcgdex.net/v2/ja/sets/SM1%2B",
      "https://api.tcgdex.net/v2/ja/cards/SM1%2B-001",
    ]);
  });

  it("the route's set parameter keeps a literal plus, from either dispatch form", () => {
    const base = "https://app.example/api/catalog/sync";
    expect(rawQueryParam(`${base}?set=SM1+&locale=ja`, "set")).toBe("SM1+"); // the old raw form
    expect(rawQueryParam(`${base}?set=SM1%2B&locale=ja`, "set")).toBe("SM1+"); // the encoded form
    expect(rawQueryParam(`${base}?set=sv03.5&locale=en`, "set")).toBe("sv03.5");
    expect(rawQueryParam(`${base}?locale=ja`, "set")).toBeNull();
    expect(rawQueryParam(`${base}?pass=artwork`, "set")).toBeNull();
    expect(rawQueryParam(`${base}?set=sv03.5&locale=ja`, "locale")).toBe("ja");
    // URLSearchParams — what the route used — is exactly the bug: the plus became a space.
    expect(new URL(`${base}?set=SM1+`).searchParams.get("set")).toBe("SM1 ");
  });
});
