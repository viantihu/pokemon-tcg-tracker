/**
 * UIL-039 — the card-search grid's core query and write paths.
 *
 * `catalogCardRepo.browse` and `copyRepo.ownedCatalogCardIdSet` are plain repo reads, tested directly.
 * `applyCardBrowse` is the part with real correctness risk: it filters owned/unowned IN MEMORY (to
 * keep hundreds of ids off the request URL) rather than as a query filter, so one *raw* catalog page
 * does not always fill one *result* page — the re-paging loop is exactly what a fake DbClient would
 * be tempted to skip past. Real Postgres via PGlite, same harness as the other `tests/coll/*` suites.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyBulkAddTargets, applyCardBrowse } from "@/lib/coll";
import { catalogCardRepo, collectionRepo, copyRepo } from "@/lib/repo";
import { asOwner, asSuperuser, freshRpcDb, OWNER, seedCollections } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
});
afterEach(async () => {
  await db.close();
});

interface CardFixture {
  id: string;
  name?: string;
  illustrator?: string;
  setId?: string;
  setName?: string;
  dexId?: number[];
  types?: string[];
}

async function seedCards(cards: CardFixture[]): Promise<void> {
  for (const c of cards) {
    await db.query(
      `insert into catalog_card (tcgdex_id, name, illustrator, set_id, set_name, dex_id, types)
         values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        c.id,
        c.name ?? c.id,
        c.illustrator ?? null,
        c.setId ?? null,
        c.setName ?? null,
        c.dexId ?? [],
        c.types ?? [],
      ],
    );
  }
}

describe("catalogCardRepo.browse", () => {
  it("filters by illustrator, set, species, and raw types — all combined with AND", async () => {
    await seedCards([
      {
        id: "a",
        name: "Charmander",
        illustrator: "Ryota Murayama",
        setId: "sv03",
        dexId: [4],
        types: ["Fire"],
      },
      {
        id: "b",
        name: "Charmeleon",
        illustrator: "Ryota Murayama",
        setId: "sv03",
        dexId: [5],
        types: ["Fire"],
      },
      {
        id: "c",
        name: "Squirtle",
        illustrator: "Ryota Murayama",
        setId: "sv04",
        dexId: [7],
        types: ["Water"],
      },
      {
        id: "d",
        name: "Bulbasaur",
        illustrator: "Someone Else",
        setId: "sv03",
        dexId: [1],
        types: ["Grass"],
      },
    ]);
    await asOwner(db);
    const client = pgliteClient(db);

    const byIllustrator = await catalogCardRepo.browse(
      client,
      { illustrator: "Murayama" },
      { limit: 60, offset: 0 },
    );
    expect(byIllustrator.map((r) => r.tcgdex_id).sort()).toEqual(["a", "b", "c"]);

    const bySet = await catalogCardRepo.browse(
      client,
      { illustrator: "Murayama", setId: "sv03" },
      { limit: 60, offset: 0 },
    );
    expect(bySet.map((r) => r.tcgdex_id).sort()).toEqual(["a", "b"]);

    const byType = await catalogCardRepo.browse(
      client,
      { types: ["Fire"] },
      { limit: 60, offset: 0 },
    );
    expect(byType.map((r) => r.tcgdex_id).sort()).toEqual(["a", "b"]);

    const byDex = await catalogCardRepo.browse(client, { dexId: 7 }, { limit: 60, offset: 0 });
    expect(byDex.map((r) => r.tcgdex_id)).toEqual(["c"]);
  });

  it("pages via limit/offset in a stable total order", async () => {
    await seedCards(
      Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, name: `Card ${i}`, illustrator: "X" })),
    );
    await asOwner(db);
    const client = pgliteClient(db);

    const page1 = await catalogCardRepo.browse(
      client,
      { illustrator: "X" },
      { limit: 2, offset: 0 },
    );
    const page2 = await catalogCardRepo.browse(
      client,
      { illustrator: "X" },
      { limit: 2, offset: 2 },
    );
    const page3 = await catalogCardRepo.browse(
      client,
      { illustrator: "X" },
      { limit: 2, offset: 4 },
    );
    const all = [...page1, ...page2, ...page3].map((r) => r.tcgdex_id);
    expect(new Set(all)).toEqual(new Set(["c0", "c1", "c2", "c3", "c4"]));
    expect(all).toHaveLength(5); // no duplicate or dropped row across the page boundary
  });
});

describe("copyRepo.ownedCatalogCardIdSet", () => {
  it("counts a card ANYWHERE — including in the haul — and excludes only a block", async () => {
    /**
     * UIL-093: `'haul'` is the case this got wrong. The filter named the roles that counted
     * (`shelved`, `bulk`), so when UIL-088 gave an unplaced card its own role, 545 cards sitting in
     * her haul badged as NOT OWNED on the search grid and fell on the wrong side of its owned/unowned
     * filter. Dex is the source of truth for what she owns, and a card an import created is owned; it
     * simply has not been placed yet. A `block` is still excluded, because it is not a card.
     */
    await seedCards([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }]);
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, role)
        values ('e0000000-0000-0000-0000-000000000001', '${OWNER}', 'a', 'shelved'),
               ('e0000000-0000-0000-0000-000000000002', '${OWNER}', 'b', 'bulk'),
               ('e0000000-0000-0000-0000-000000000003', '${OWNER}', 'c', 'block'),
               ('e0000000-0000-0000-0000-000000000004', '${OWNER}', 'e', 'haul');
    `);
    await asOwner(db);
    const owned = await copyRepo.ownedCatalogCardIdSet(pgliteClient(db));
    expect(owned).toEqual(new Set(["a", "b", "e"]));
  });
});

describe("applyCardBrowse", () => {
  it("expands a color-band key to its raw types before querying", async () => {
    await seedCards([
      { id: "fire1", name: "Growlithe", types: ["Fire"] },
      { id: "water1", name: "Squirtle", types: ["Water"] },
    ]);
    await asOwner(db);
    const client = pgliteClient(db);

    const res = await applyCardBrowse(client, { type: "red" }, 0); // red = Fire (0003_config.sql)
    expect(res.cards.map((c) => c.tcgdexId)).toEqual(["fire1"]);
  });

  it("re-pages past a whole raw page that doesn't match, without losing or duplicating a match", async () => {
    // 65 cards, sorted (zero-padded so name order == index order): the first 60 (one full raw
    // page, PAGE_SIZE=60 internally) are all OWNED, the last 5 are UNOWNED. Filtering for
    // "unowned" at offset 0 can only find its 5 matches by pulling a SECOND raw page — a fake
    // DbClient stubbed to return one page would report zero matches and stop, which is exactly
    // the failure this seeds against.
    const ids = Array.from({ length: 65 }, (_, i) => `q${String(i).padStart(2, "0")}`);
    await seedCards(ids.map((id) => ({ id, name: id, illustrator: "Y" })));
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, role)
      select gen_random_uuid(), '${OWNER}', unnest(array[${ids
        .slice(0, 60)
        .map((id) => `'${id}'`)
        .join(",")}]), 'shelved';
    `);
    await asOwner(db);
    const client = pgliteClient(db);

    const unowned = await applyCardBrowse(client, { illustrator: "Y", owned: "unowned" }, 0);
    expect(unowned.cards.map((c) => c.tcgdexId).sort()).toEqual(ids.slice(60));
    expect(unowned.cards.every((c) => !c.owned)).toBe(true);
    expect(unowned.hasMore).toBe(false);
    expect(unowned.nextOffset).toBe(65); // consumed both raw pages (60 + 5)

    const owned = await applyCardBrowse(client, { illustrator: "Y", owned: "owned" }, 0);
    expect(owned.cards.map((c) => c.tcgdexId).sort()).toEqual(ids.slice(0, 60));
    expect(owned.cards.every((c) => c.owned)).toBe(true);
    // The result page itself caps at PAGE_SIZE even though 60 raw rows all matched.
    expect(owned.hasMore).toBe(true);
  });

  it("badges owned correctly even with no owned/unowned filter applied", async () => {
    await seedCards([
      { id: "a", illustrator: "Z" },
      { id: "b", illustrator: "Z" },
    ]);
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, role)
        values ('e0000000-0000-0000-0000-000000000021', '${OWNER}', 'a', 'shelved');
    `);
    await asOwner(db);
    const res = await applyCardBrowse(pgliteClient(db), { illustrator: "Z" }, 0);
    const byId = new Map(res.cards.map((c) => [c.tcgdexId, c.owned]));
    expect(byId.get("a")).toBe(true);
    expect(byId.get("b")).toBe(false);
  });
});

describe("applyBulkAddTargets", () => {
  const COL = "a0000000-0000-0000-0000-000000000001";

  it("adds every new id in one write and skips ones already on the list", async () => {
    await seedCards([{ id: "cardA" }, { id: "cardB" }, { id: "cardC" }]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: ["cardA"], currentBinderIds: [] },
    ]);
    await asOwner(db);
    const client = pgliteClient(db);

    const res = await applyBulkAddTargets(client, OWNER, COL, ["cardA", "cardB", "cardC"]);
    // cardA was already there, so two are new to the list. She owns none of the three, so all three are
    // wished for, cardA too (UIL-101: every card she does not own; see tests/coll/bulk-add-wishlist.test.ts).
    expect(res).toEqual({ ok: true, added: 2, wishlisted: 3, alreadyWished: 0, owned: 0 });

    await asSuperuser(db);
    const row = await collectionRepo.getByPk(pgliteClient(db), COL);
    expect(row?.target_catalog_card_ids?.sort()).toEqual(["cardA", "cardB", "cardC"]);
  });

  it("leaves name/mode/binder untouched — this is an add, not a full save", async () => {
    await seedCards([{ id: "cardA" }]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: [], currentBinderIds: [] },
    ]);
    await asOwner(db);
    await applyBulkAddTargets(pgliteClient(db), OWNER, COL, ["cardA"]);

    await asSuperuser(db);
    const row = await collectionRepo.getByPk(pgliteClient(db), COL);
    expect(row?.name).toBe("Matsuno");
    expect(row?.current_binder_ids).toEqual([]);
  });
});
