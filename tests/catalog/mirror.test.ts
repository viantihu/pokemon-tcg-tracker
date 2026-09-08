/**
 * Catalog mirror mapping + idempotency (dev-spec §5 M2).
 *
 * Fixtures are REAL cards (verified against the live TCGdex API on 2026-09-07). The fake DB models
 * the one Postgres rule that makes the mirror correct: an INSERT ... ON CONFLICT may not touch the
 * same conflict key twice in one statement — so the mirror must de-dupe per batch. Re-running the
 * mirror over the same input must not duplicate rows (idempotent upsert acceptance).
 */
import { describe, expect, it } from "vitest";
import type { DbClient } from "@/lib/repo";
import { catalogCardRepo } from "@/lib/repo";
import { dedupeById, extractPrices, syncSet, toCatalogRow } from "@/lib/catalog/mirror";
import type { TcgdexCardFull, TcgdexClient, TcgdexSet } from "@/lib/catalog/tcgdex";

// --- Real card fixtures (shape matches the live API; only consumed fields included) -------------

const CHARMANDER: TcgdexCardFull = {
  id: "sv03-026",
  localId: "026",
  name: "Charmander",
  category: "Pokemon",
  image: "https://assets.tcgdex.net/en/sv/sv03/026",
  rarity: "Common",
  stage: "Basic",
  evolveFrom: "None", // basics carry the string "None" — must become null
  illustrator: "Narumi Sato",
  hp: 60,
  types: ["Fire"],
  dexId: [4],
  variants: { firstEdition: false, holo: false, normal: true, reverse: true, wPromo: false },
  set: { id: "sv03", name: "Obsidian Flames" },
};

const CHARMELEON: TcgdexCardFull = {
  id: "sv03-027",
  localId: "027",
  name: "Charmeleon",
  category: "Pokemon",
  image: "https://assets.tcgdex.net/en/sv/sv03/027",
  rarity: "Uncommon",
  stage: "Stage1",
  evolveFrom: "Charmander",
  illustrator: "Ryota Murayama",
  hp: 90,
  types: ["Fire"],
  dexId: [5],
  variants: { firstEdition: false, holo: true, normal: true, reverse: true, wPromo: false },
  set: { id: "sv03", name: "Obsidian Flames" },
  pricing: {
    tcgplayer: {
      unit: "USD",
      updated: "2026-09-07",
      normal: { lowPrice: 0.2, marketPrice: 0.5 },
      "reverse-holofoil": { lowPrice: 0.1, marketPrice: 0.9 },
    },
    cardmarket: { unit: "EUR", low: 0.02, trend: 0.04, avg: 0.07 },
  },
};

// The verified trap: Obsidian Flames Charizard ex is DARKNESS, not Fire — and it is specialty.
const CHARIZARD_EX: TcgdexCardFull = {
  id: "sv03-125",
  localId: "125",
  name: "Charizard ex",
  category: "Pokemon",
  image: "https://assets.tcgdex.net/en/sv/sv03/125",
  rarity: "Double rare",
  stage: "Stage2",
  evolveFrom: "Charmeleon",
  hp: 330,
  types: ["Darkness"],
  dexId: [6],
  variants: { firstEdition: false, holo: true, normal: false, reverse: false, wPromo: false },
  set: { id: "sv03", name: "Obsidian Flames" },
};

function obsidianFlamesSet(cards: TcgdexCardFull[]): TcgdexSet {
  return {
    id: "sv03",
    name: "Obsidian Flames",
    serie: { id: "sv", name: "Scarlet & Violet" },
    cards: cards.map((c) => ({ id: c.id, localId: c.localId, name: c.name })),
  };
}

function fakeTcgdex(set: TcgdexSet, cards: TcgdexCardFull[]): TcgdexClient {
  const byId = new Map(cards.map((c) => [c.id, c]));
  return {
    getSet: async () => set,
    getCard: async (id) => {
      const c = byId.get(id);
      if (!c) throw new Error(`no fixture for ${id}`);
      return c;
    },
    listCards: async () => set.cards ?? [],
    listSets: async () => [set],
  };
}

/** Minimal in-memory DB that models catalog_card upsert-on-conflict (tcgdex_id) semantics. */
function fakeDb() {
  const store = new Map<string, Record<string, unknown>>();
  const db = {
    from(table: string) {
      if (table !== "catalog_card") throw new Error(`unexpected table ${table}`);
      return {
        upsert(rows: Record<string, unknown>[], opts: { onConflict: string }) {
          const key = opts.onConflict;
          const seen = new Set<string>();
          for (const r of rows) {
            const k = r[key] as string;
            if (seen.has(k)) {
              throw new Error(`ON CONFLICT DO UPDATE cannot affect row a second time: ${k}`);
            }
            seen.add(k);
          }
          for (const r of rows)
            store.set(r[key] as string, { ...store.get(r[key] as string), ...r });
          const result = { data: rows, error: null };
          return { select: () => Promise.resolve(result) };
        },
        select: () => Promise.resolve({ data: [...store.values()], error: null }),
      };
    },
  };
  return { db: db as unknown as DbClient, store };
}

// -----------------------------------------------------------------------------------------------

describe("extractPrices", () => {
  it("prefers TCGplayer low across variants and the 'normal' market price", () => {
    expect(extractPrices(CHARMELEON.pricing)).toEqual({ priceLow: 0.1, priceMarket: 0.5 });
  });
  it("null pricing → nulls", () => {
    expect(extractPrices(null)).toEqual({ priceLow: null, priceMarket: null });
    expect(extractPrices(undefined)).toEqual({ priceLow: null, priceMarket: null });
  });
  it("falls back to Cardmarket when TCGplayer is absent", () => {
    expect(extractPrices({ cardmarket: { low: 0.02, trend: 0.04 } })).toEqual({
      priceLow: 0.02,
      priceMarket: 0.04,
    });
  });
});

describe("toCatalogRow", () => {
  it("maps a real card, stores ids verbatim, derives standard class", () => {
    const row = toCatalogRow(CHARMELEON, { isDigitalOnly: false, setSeries: "Scarlet & Violet" });
    expect(row.tcgdex_id).toBe("sv03-027");
    expect(row.local_id).toBe("027");
    expect(row.dex_id).toEqual([5]);
    expect(row.types).toEqual(["Fire"]);
    expect(row.stage).toBe("Stage1");
    expect(row.evolve_from).toBe("Charmander");
    expect(row.set_id).toBe("sv03");
    expect(row.set_series).toBe("Scarlet & Violet");
    expect(row.image_url).toBe("https://assets.tcgdex.net/en/sv/sv03/027");
    expect(row.card_class).toBe("standard");
    expect(row.is_digital_only).toBe(false);
  });

  it("turns the basics' evolveFrom 'None' into null", () => {
    expect(toCatalogRow(CHARMANDER, { isDigitalOnly: false }).evolve_from).toBeNull();
  });

  it("derives specialty for an ex", () => {
    expect(toCatalogRow(CHARIZARD_EX, { isDigitalOnly: false }).card_class).toBe("specialty");
  });

  it("passes through is_digital_only for TCG Pocket cards", () => {
    const row = toCatalogRow(
      { ...CHARMANDER, id: "A1-001", set: { id: "A1", name: "Genetic Apex" } },
      {
        isDigitalOnly: true,
      },
    );
    expect(row.is_digital_only).toBe(true);
  });
});

describe("dedupeById", () => {
  it("keeps the last row per tcgdex_id", () => {
    const a = toCatalogRow(CHARMELEON, { isDigitalOnly: false });
    const b = { ...a, name: "Charmeleon (updated)" };
    const out = dedupeById([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Charmeleon (updated)");
  });
});

describe("catalogCardRepo.upsertMany", () => {
  it("throws if a batch touches the same conflict key twice (why dedupe is required)", async () => {
    const { db } = fakeDb();
    const row = toCatalogRow(CHARMELEON, { isDigitalOnly: false });
    await expect(catalogCardRepo.upsertMany(db, [row, row])).rejects.toThrow(/second time/);
  });
});

describe("syncSet — idempotent mirror", () => {
  it("populates the mirror and re-runs without duplicating rows", async () => {
    const cards = [CHARMANDER, CHARMELEON, CHARIZARD_EX];
    const tcgdex = fakeTcgdex(obsidianFlamesSet(cards), cards);
    const { db, store } = fakeDb();

    const first = await syncSet(db, tcgdex, "sv03");
    expect(first.fetched).toBe(3);
    expect(first.upserted).toBe(3);
    expect(store.size).toBe(3);

    const second = await syncSet(db, tcgdex, "sv03");
    expect(second.upserted).toBe(3);
    expect(store.size).toBe(3); // no duplication on re-run

    expect(store.get("sv03-125")!.card_class).toBe("specialty");
    expect(store.get("sv03-026")!.evolve_from).toBeNull();
  });

  it("flags every card in a TCG Pocket set as digital-only", async () => {
    const pocket: TcgdexCardFull = {
      ...CHARMANDER,
      id: "A1-001",
      set: { id: "A1", name: "Genetic Apex" },
    };
    const set: TcgdexSet = {
      id: "A1",
      name: "Genetic Apex",
      serie: { id: "tcgp", name: "Pokémon TCG Pocket" },
      cards: [{ id: pocket.id, localId: pocket.localId, name: pocket.name }],
    };
    const { db, store } = fakeDb();
    const result = await syncSet(db, fakeTcgdex(set, [pocket]), "A1");
    expect(result.isDigitalOnly).toBe(true);
    expect(store.get("A1-001")!.is_digital_only).toBe(true);
  });
});
