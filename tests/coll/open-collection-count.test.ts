/**
 * UIL-113 — what a collection counts, read by the REAL `loadCollHub` from a real database (PGlite).
 *
 * Karvi: "I only shelved 10 cards, 12 are in the collection." An open collection's header counted every card on
 * its LIST, and a Testing wipe deletes copies but keeps lists, so two cards she no longer held still counted.
 * Now both modes use ONE predicate (the Senior BA's ruling): a card is in the collection when it is on the list
 * AND a shelved copy sits in one of its binders. The rest of the list is told apart by whether she holds the
 * card anywhere at all, in ANY role, which is why `loadCollHub` now reads every copy and not only shelved ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  asOwner,
  asSuperuser,
  freshRpcDb,
  OWNER,
  seedBinders,
  seedCollections,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";
import { loadCollHub } from "@/app/(ui)/coll/actions";
import { collectionTally, openCollectionSummary } from "@/lib/surfaces";

let db: PGlite;
vi.mock("@/lib/plan/session", () => ({
  getOwnerContext: async () => ({ db: pgliteClient(db), ownerId: OWNER }),
}));

const SPEC = "b0000000-0000-0000-0000-000000000113";
const OTHER = "b0000000-0000-0000-0000-000000000114";
const COL = "a0000000-0000-0000-0000-000000000113";
// IN: shelved in the collection's binder. HAUL: she has it, still in the haul. ELSEWHERE: shelved in another
// binder. GONE: on the list, no copy anywhere (what the wipe left).
// BLOCK: only a `block` copy, which marks a slot no card can fill (#319) and is not a card she owns.
const [IN, HAUL, ELSEWHERE, GONE, BLOCK] = [
  "sv03-001",
  "sv03-002",
  "sv03-003",
  "sv03-004",
  "sv03-005",
];

beforeEach(async () => {
  db = await freshRpcDb();
  await db.exec(`insert into catalog_card (tcgdex_id, name) values
    ('${IN}', 'In'), ('${HAUL}', 'Haul'), ('${ELSEWHERE}', 'Elsewhere'), ('${GONE}', 'Gone'),
    ('${BLOCK}', 'Block')`);
  await seedBinders(db, [
    { id: SPEC, type: "specialty", name: "Japanese binder" },
    { id: OTHER, type: "general", name: "Other" },
  ]);
  await seedCollections(db, [
    {
      id: COL,
      name: "Japanese",
      targetCatalogCardIds: [IN, HAUL, ELSEWHERE, GONE, BLOCK],
      currentBinderIds: [SPEC],
    },
  ]);
  await asSuperuser(db);
  await db.query(
    `insert into copy (owner_id, catalog_card_id, role, binder_id) values
       ($1, $2, 'shelved', $3), ($1, $4, 'haul', null), ($1, $5, 'shelved', $6), ($1, $7, 'block', null)`,
    [OWNER, IN, SPEC, HAUL, ELSEWHERE, OTHER, BLOCK],
  );
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

async function theCollection() {
  const data = await loadCollHub();
  return data.collections.find((c) => c.id === COL)!;
}
const state = (c: Awaited<ReturnType<typeof theCollection>>, id: string) => {
  const k = c.cards.find((x) => x.tcgdexId === id)!;
  return { owned: k.owned, held: k.held };
};

describe("UIL-113 · one predicate for what is IN a collection", () => {
  it("only a shelved copy in its binder counts; a haul copy or another binder's does not, and a card held nowhere is flagged", async () => {
    const c = await theCollection();
    expect(state(c, IN)).toEqual({ owned: true, held: true });
    expect(state(c, HAUL)).toEqual({ owned: false, held: true });
    expect(state(c, ELSEWHERE)).toEqual({ owned: false, held: true });
    expect(state(c, GONE)).toEqual({ owned: false, held: false });
    // A block copy is not a card she owns (the Senior BA's ruling, as "Add a card" already treats it).
    expect(state(c, BLOCK)).toEqual({ owned: false, held: false });
    expect(c.ownedCount).toBe(1);
    expect(c.totalCount).toBe(5);
  });

  it("an open collection says so in her words; the list is not the count", async () => {
    const c = await theCollection();
    expect(openCollectionSummary(collectionTally(c.cards))).toBe(
      "1 in the binder · 2 not shelved here yet · 2 not in your collection",
    );
  });

  it("finite mode counts with the SAME predicate: switching the mode changes nothing about ownership", async () => {
    await asSuperuser(db);
    await db.query(`update collection set mode = 'finite' where id = $1`, [COL]);
    await asOwner(db);
    const c = await theCollection();
    expect(c.ownedCount).toBe(1);
    expect(collectionTally(c.cards).inBinder).toBe(c.ownedCount);
  });
});

describe("UIL-113 · her Japanese collection: 10 shelved, 2 left on the list by the wipe", () => {
  it("reads 10 in the binder and 2 not in your collection, through the real loadCollHub", async () => {
    const JA = "a0000000-0000-0000-0000-00000000113a";
    const ids = Array.from({ length: 12 }, (_, i) => `ja:sv2a-${String(i + 1).padStart(3, "0")}`);
    await asSuperuser(db);
    // `ja:` printings carry locale 'ja' (0016's namespace rule).
    await db.exec(
      `insert into catalog_card (tcgdex_id, name, locale) values ${ids.map((id) => `('${id}', '${id}', 'ja')`).join(",")}`,
    );
    await seedCollections(db, [
      {
        id: JA,
        name: "Japanese (10 + 2)",
        targetCatalogCardIds: ids,
        currentBinderIds: [SPEC],
        mode: "open",
      },
    ]);
    for (const id of ids.slice(0, 10)) {
      await db.query(
        `insert into copy (owner_id, catalog_card_id, role, binder_id) values ($1, $2, 'shelved', $3)`,
        [OWNER, id, SPEC],
      );
    }
    await asOwner(db);
    const c = (await loadCollHub()).collections.find((x) => x.id === JA)!;
    expect(c.ownedCount).toBe(10);
    expect(c.totalCount).toBe(12);
    expect(openCollectionSummary(collectionTally(c.cards))).toBe(
      "10 in the binder · 2 not in your collection",
    );
    expect(c.cards.filter((k) => !k.held).map((k) => k.tcgdexId)).toEqual(ids.slice(10));
  });
});

describe("UIL-113 · the tally and its words", () => {
  it("counts each card once, in the first bucket that fits", () => {
    const t = collectionTally([
      ...Array.from({ length: 10 }, () => ({ owned: true, held: true })),
      { owned: false, held: false },
      { owned: false, held: false },
    ]);
    expect(t).toEqual({ inBinder: 10, notShelvedHere: 0, notInCollection: 2, total: 12 });
    expect(openCollectionSummary(t)).toBe("10 in the binder · 2 not in your collection");
  });

  it("names only what is there", () => {
    expect(openCollectionSummary(collectionTally([{ owned: true, held: true }]))).toBe(
      "1 in the binder",
    );
    expect(openCollectionSummary(collectionTally([]))).toBe("0 in the binder");
  });
});
