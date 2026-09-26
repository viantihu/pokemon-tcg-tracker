/**
 * UIL-101 — the search grid's bulk add puts every card she does NOT own on her wishlist, the way a single
 * add does (UIL-098 part 1, #319), and every picked card on the collection's chase list.
 *
 * The Senior BA's conditions, pinned here: the wish is #319's row shape, built by the same helper; the whole
 * add is ONE `apply_write_ops` call, all or nothing; no copy is ever created; a card already on her wishlist
 * is not wished for twice within one add; the result says how many went on her wishlist and how many she
 * already owns. Real Postgres (PGlite), real RLS, the real write path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyBulkAddTargets, collectionWishOp } from "@/lib/coll";
import { catalogCardRepo, type WriteOp } from "@/lib/repo";
import {
  asOwner,
  asSuperuser,
  freshRpcDb,
  OWNER,
  seedBinders,
  seedCollections,
  seedHaulCopies,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const SPEC = "b0000000-0000-0000-0000-0000000000a1";
const COL = "a0000000-0000-0000-0000-0000000000a1";

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await db.exec(`
    insert into catalog_card (tcgdex_id, name, dex_id, types, stage) values
      ('sv01-001', 'Sprigatito', '{906}', '{Grass}', 'Basic'),
      ('sv01-002', 'Floragato', '{907}', '{Grass}', 'Stage1'),
      ('sv01-003', 'Meowscarada', '{908}', '{Grass}', 'Stage2'),
      ('sv01-004', 'Fuecoco', '{909}', '{Fire}', 'Basic');
  `);
  await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Paldea starters" }]);
  await seedCollections(db, [
    { id: COL, name: "Starters", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
  ]);
});
afterEach(async () => {
  await db.close();
});

async function wishes() {
  await asSuperuser(db);
  const r = await db.query<{
    chosen_catalog_card_id: string;
    line_slot_id: string | null;
    held_for_binder_id: string | null;
    will_live_in_specialty: boolean;
    required_dex_id: number | null;
    required_type: string | null;
    required_stage: string | null;
    alternate_catalog_card_ids: string[];
  }>(
    `select chosen_catalog_card_id, line_slot_id, held_for_binder_id, will_live_in_specialty,
            required_dex_id, required_type, required_stage, alternate_catalog_card_ids
       from wishlist_item order by chosen_catalog_card_id`,
  );
  return r.rows;
}
async function targets(): Promise<string[]> {
  await asSuperuser(db);
  const r = await db.query<{ t: string[] }>(
    "select target_catalog_card_ids t from collection where id = $1",
    [COL],
  );
  return r.rows[0]?.t ?? [];
}
async function copyCount(): Promise<number> {
  await asSuperuser(db);
  const r = await db.query<{ n: number }>("select count(*)::int n from copy");
  return r.rows[0].n;
}
async function add(ids: string[]) {
  await asOwner(db);
  return applyBulkAddTargets(pgliteClient(db), OWNER, COL, ids);
}

describe("UIL-101 · a card she does not own goes on her wishlist", () => {
  it("in #319's row shape, from the same helper, and on the chase list", async () => {
    const res = await add(["sv01-001"]);

    expect(res).toEqual({ ok: true, added: 1, wishlisted: 1, alreadyWished: 0, owned: 0 });
    const [row] = await wishes();
    expect(row).toEqual({
      chosen_catalog_card_id: "sv01-001",
      line_slot_id: null,
      held_for_binder_id: SPEC,
      will_live_in_specialty: true,
      required_dex_id: 906,
      required_type: "Grass",
      required_stage: "Basic",
      alternate_catalog_card_ids: [],
    });
    // The helper a single add uses produces exactly this row: one shape, not two.
    const card = await catalogCardRepo.getByPk(pgliteClient(db), "sv01-001");
    const { op: _op, ...viaHelper } = collectionWishOp(card!, SPEC);
    void _op;
    expect(row).toEqual(viaHelper);
    expect(await targets()).toEqual(["sv01-001"]);
  });

  it("a card she owns, anywhere, only joins the chase list: shelved, in the bulk box, or in her haul", async () => {
    await asSuperuser(db);
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id) values
         ('c0000000-0000-0000-0000-000000000001', $1, 'sv01-001', 'shelved', $2),
         ('c0000000-0000-0000-0000-000000000002', $1, 'sv01-002', 'bulk', null)`,
      [OWNER, SPEC],
    );
    await seedHaulCopies(db, [
      { id: "c0000000-0000-0000-0000-000000000003", catalogCardId: "sv01-003" },
    ]);
    const before = await copyCount();

    const res = await add(["sv01-001", "sv01-002", "sv01-003", "sv01-004"]);

    expect(res).toEqual({ ok: true, added: 4, wishlisted: 1, alreadyWished: 0, owned: 3 });
    expect((await wishes()).map((w) => w.chosen_catalog_card_id)).toEqual(["sv01-004"]);
    expect(await targets()).toEqual(["sv01-001", "sv01-002", "sv01-003", "sv01-004"]);
    expect(await copyCount()).toBe(before); // never a copy
  });

  it("a binder block is not a card she holds, so its card is still wished for", async () => {
    await asSuperuser(db);
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id)
         values ('c0000000-0000-0000-0000-000000000009', $1, 'sv01-001', 'block', $2)`,
      [OWNER, SPEC],
    );
    const res = await add(["sv01-001"]);
    expect(res).toMatchObject({ ok: true, wishlisted: 1, owned: 0 });
  });
});

describe("UIL-101 · never wished for twice", () => {
  it("a card already on her wishlist gets no second row, and is counted as already there", async () => {
    await add(["sv01-001"]);
    const res = await add(["sv01-001", "sv01-002"]);
    expect(res).toEqual({ ok: true, added: 1, wishlisted: 1, alreadyWished: 1, owned: 0 });
    expect((await wishes()).map((w) => w.chosen_catalog_card_id)).toEqual(["sv01-001", "sv01-002"]);
  });

  it("a card picked twice in one add is one wish", async () => {
    const res = await add(["sv01-004", "sv01-004"]);
    expect(res).toEqual({ ok: true, added: 1, wishlisted: 1, alreadyWished: 0, owned: 0 });
    expect(await wishes()).toHaveLength(1);
  });

  it("a card already on the chase list but not owned still goes on her wishlist, and is not added twice", async () => {
    await asSuperuser(db);
    await db.query("update collection set target_catalog_card_ids = '{sv01-001}' where id = $1", [
      COL,
    ]);
    const res = await add(["sv01-001"]);
    expect(res).toEqual({ ok: true, added: 0, wishlisted: 1, alreadyWished: 0, owned: 0 });
    expect(await targets()).toEqual(["sv01-001"]);
  });
});

describe("UIL-101 · one write, all or nothing", () => {
  it("the whole add is ONE apply_write_ops call, and it carries no copy", async () => {
    await asOwner(db);
    const client = pgliteClient(db);
    const rpc = vi.spyOn(client, "rpc");
    await applyBulkAddTargets(client, OWNER, COL, ["sv01-001", "sv01-002", "sv01-003"]);

    expect(rpc).toHaveBeenCalledTimes(1);
    const payload = (rpc.mock.calls[0][1] as unknown as { payload: { ops: WriteOp[] } }).payload;
    expect(payload.ops.map((o) => o.op)).toEqual([
      "insert_wishlist",
      "insert_wishlist",
      "insert_wishlist",
      "union_collection_targets",
    ]);
  });

  it("if any part fails, nothing lands: the wish already written is rolled back, and the list is unchanged", async () => {
    // The SECOND card leaves the catalog between the read and the write, so its wish fails its foreign key
    // AFTER the first card's wish has been written in the same call. All or nothing means that first wish
    // is rolled back with it, and the union after them never commits.
    await asOwner(db);
    const client = pgliteClient(db);
    const realRpc = client.rpc.bind(client);
    vi.spyOn(client, "rpc").mockImplementation(async (fn, args) => {
      await asSuperuser(db);
      await db.query("delete from catalog_card where tcgdex_id = 'sv01-002'");
      await asOwner(db);
      return realRpc(fn, args);
    });
    const res = await applyBulkAddTargets(client, OWNER, COL, ["sv01-001", "sv01-002"]);

    expect(res.ok).toBe(false);
    expect(await wishes()).toEqual([]);
    expect(await targets()).toEqual([]);
  });

  it("a collection that vanishes before the write is not reported as a success", async () => {
    await asOwner(db);
    const client = pgliteClient(db);
    const realRpc = client.rpc.bind(client);
    vi.spyOn(client, "rpc").mockImplementation(async (fn, args) => {
      await db.query("delete from collection where id = $1", [COL]);
      return realRpc(fn, args);
    });
    const res = await applyBulkAddTargets(client, OWNER, COL, ["sv01-001"]);
    expect(res).toEqual({
      ok: false,
      error: expect.stringMatching(
        /^That collection changed under you, so those cards are on your wishlist/,
      ),
    });
  });

  it("a list overwritten right after the add (the editor autosaving from another tab) is not reported as a success", async () => {
    // The collection still exists, but a save carrying a stale target list replaced the one the add just
    // grew, so the cards are not on it. Saying "Added" would be false.
    await asOwner(db);
    const client = pgliteClient(db);
    const realRpc = client.rpc.bind(client);
    vi.spyOn(client, "rpc").mockImplementation(async (fn, args) => {
      const out = await realRpc(fn, args);
      await db.query("update collection set target_catalog_card_ids = '{}' where id = $1", [COL]);
      return out;
    });
    const res = await applyBulkAddTargets(client, OWNER, COL, ["sv01-001"]);
    expect(res).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^That collection changed under you/),
    });
  });

  it("a draft with no binder yet still wishes: a wish needs no binder", async () => {
    await asSuperuser(db);
    await db.query("update collection set current_binder_ids = '{}' where id = $1", [COL]);
    const res = await add(["sv01-001"]);
    expect(res).toMatchObject({ ok: true, wishlisted: 1 });
    expect((await wishes())[0].held_for_binder_id).toBeNull();
  });
});
