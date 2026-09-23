/**
 * UIL-048 — logging an owned card into a collection must never create a second physical copy.
 *
 * `logCardIntoCollection`'s old behaviour called `copyRepo.insert` unconditionally. Her report: a card
 * already shelved in the collection's own binder, logged again, became TWO copy rows — the Remove
 * button read "Remove 2" for a card she owns exactly one of. The assertion that matters is the raw
 * `copy` ROW COUNT for that catalog card after logging, not what the UI happens to render, per the
 * assignment: a UI-count assertion would pass against a fix that still doubles the row underneath.
 *
 * Real Postgres via PGlite (0001→0008 migrations, real RLS), same harness as the other `tests/coll/*`
 * suites, so `applyCollectionLog` runs through the real `collection`/`copy`/`placement_decision` tables.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { DbClient, Row } from "@/lib/repo";
import {
  ALREADY_OWNED_IN_HAUL_MESSAGE,
  applyCollectionLog,
  describeExistingCopyLocation,
} from "@/lib/coll";
import {
  asOwner,
  asSuperuser,
  freshRpcDb,
  OWNER,
  seedBinders,
  seedCatalogCards,
  seedCollections,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const SPEC = "b0000000-0000-0000-0000-000000000011";
const GEN = "b0000000-0000-0000-0000-000000000012";
const COL = "a0000000-0000-0000-0000-000000000001";
const CA1 = "c0000000-0000-0000-0000-000000000a01";

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
});
afterEach(async () => {
  await db.close();
});

async function copyCountFor(tcgdexId: string): Promise<number> {
  await asSuperuser(db);
  const r = await db.query<{ n: number }>(
    `select count(*)::int as n from copy where catalog_card_id = $1`,
    [tcgdexId],
  );
  return r.rows[0].n;
}

/**
 * A copy already shelved in the collection's own binder — since UIL-098 the ONLY log that writes anything
 * (it unions the chase tag). The atomicity cases below were written against "log a card she owns none of",
 * which inserted a copy; that path is now a refusal, so they drive the tag union through this one instead.
 */
async function shelveIn(binderId: string, copyId: string, tcgdexId: string): Promise<void> {
  await asSuperuser(db);
  await db.query(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id) values ($1, $2, $3, 'shelved', $4)`,
    [copyId, OWNER, tcgdexId, binderId],
  );
}

async function targetsOf(id: string): Promise<string[]> {
  const rows = await db.query<{ t: string[] }>(
    `select target_catalog_card_ids t from collection where id = $1`,
    [id],
  );
  return rows.rows[0].t;
}

describe("applyCollectionLog", () => {
  it("is a no-op repeat when a copy is already shelved in the collection's own binder — her exact report", async () => {
    await seedCatalogCards(db, ["cardA"]);
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: ["cardA"], currentBinderIds: [SPEC] },
    ]);
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, role, binder_id)
        values ('${CA1}', '${OWNER}', 'cardA', 'shelved', '${SPEC}');
    `);
    expect(await copyCountFor("cardA")).toBe(1);

    await asOwner(db);
    const res = await applyCollectionLog(pgliteClient(db), OWNER, COL, "cardA");
    expect(res).toMatchObject({ ok: true, created: false, copyId: CA1 });

    // The row count for this catalog card must stay ONE — not two.
    expect(await copyCountFor("cardA")).toBe(1);
    expect(await targetsOf(COL)).toEqual(["cardA"]);
  });

  it("refuses when she owns a copy shelved in a DIFFERENT binder, naming it, and inserts nothing", async () => {
    await seedCatalogCards(db, ["cardA"]);
    await seedBinders(db, [
      { id: SPEC, type: "specialty", name: "Specialty A" },
      { id: GEN, type: "general", name: "Binder 1" },
    ]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
    ]);
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
        values ('${CA1}', '${OWNER}', 'cardA', 'shelved', '${GEN}', 'front', 'red');
    `);

    await asOwner(db);
    const res = await applyCollectionLog(pgliteClient(db), OWNER, COL, "cardA");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("Binder 1");
      expect(res.error).toContain("Front");
      expect(res.error).toMatch(/Move/);
    }

    expect(await copyCountFor("cardA")).toBe(1); // unchanged — no phantom second copy
    expect(await targetsOf(COL)).toEqual([]); // refusal touches nothing, not even the tag
  });

  it("refuses when she owns a copy in the bulk box", async () => {
    await seedCatalogCards(db, ["cardA"]);
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
    ]);
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, role)
        values ('${CA1}', '${OWNER}', 'cardA', 'bulk');
    `);

    await asOwner(db);
    const res = await applyCollectionLog(pgliteClient(db), OWNER, COL, "cardA");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("bulk box");
    expect(await copyCountFor("cardA")).toBe(1);
  });

  it("refuses when the copy she owns is IN HER HAUL, and sends her to the Haul Plan not to Move", async () => {
    /**
     * UIL-093, a UIL-088 regression. `findExistingCopy` filtered `role === "shelved" || role === "bulk"`,
     * so an unplaced copy came back as `kind: "none"` and this path INSERTED A SECOND COPY of a card she
     * already owns — the exact duplicate the function exists to refuse, and the same class of double she
     * reported on the Haul Plan.
     *
     * The wording is its own sentence, not the "it's in <place>" one: a card in the haul is not anywhere,
     * so "Use Move to bring it here" would send her to the wrong screen for a card the app has never filed.
     */
    await seedCatalogCards(db, ["cardA"]);
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
    ]);
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, role)
        values ('${CA1}', '${OWNER}', 'cardA', 'haul');
    `);

    await asOwner(db);
    const res = await applyCollectionLog(pgliteClient(db), OWNER, COL, "cardA");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe(ALREADY_OWNED_IN_HAUL_MESSAGE);
      expect(res.error).toContain("waiting to be placed");
      expect(res.error).not.toMatch(/bulk box/); // it is NOT in the box; she never put it there
      expect(res.error).not.toMatch(/Move/);
    }
    expect(await copyCountFor("cardA")).toBe(1); // pre-fix: 2
    expect(await targetsOf(COL)).toEqual([]); // and the tag is untouched, like every other refusal
  });

  it("describeExistingCopyLocation never calls the haul the bulk box, for any caller", async () => {
    /**
     * `applyCollectionLog` answers the haul case before reaching this helper, so this branch has no
     * caller that can reach it today — a mutation removing it survives the suite through that path. It is
     * pinned directly instead, because the helper is EXPORTED: without the branch, the first future caller
     * gets "the bulk box" for a card she never put in a box, which is the whole class of false-placement
     * claim UIL-087, UIL-088 and this entry are about.
     */
    await seedCatalogCards(db, ["cardA"]);
    await asSuperuser(db);
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, role)
        values ('${CA1}', '${OWNER}', 'cardA', 'haul');
    `);
    const rows = await db.query<Row<"copy">>(`select * from copy where id = '${CA1}'`);
    await asOwner(db);
    const where = await describeExistingCopyLocation(pgliteClient(db), rows.rows[0]);
    expect(where).toBe("your haul, waiting to be placed");
    expect(where).not.toContain("bulk");
  });

  it("a card she does NOT own goes on her WISHLIST and the chase list — and creates no inventory (UIL-098)", async () => {
    /**
     * PRE-FIX this inserted a copy — inventory. Karvi: "when I added cards from the Collections page into the
     * open collections, it actually created inventory. ... Adding cards that I don't own to a collection
     * should add them to the wishlist, not into inventory itself." A copy made here belongs to no presence
     * group, so the next import cannot see it and creates a SECOND one when Dex lists the card. Testing held
     * five such copies when this landed, all from this path.
     */
    await seedCatalogCards(db, ["cardA"]);
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
    ]);
    expect(await copyCountFor("cardA")).toBe(0);

    await asOwner(db);
    const res = await applyCollectionLog(pgliteClient(db), OWNER, COL, "cardA");
    expect(res).toEqual({ ok: true, copyId: null, created: false, wishlisted: true });

    expect(await copyCountFor("cardA")).toBe(0); // pre-fix: 1 — no inventory
    expect(await targetsOf(COL)).toEqual(["cardA"]); // on the collection's list

    // WISHLISTED, in the shape the Collections "Wishlist" button already writes: no slot, held for the
    // collection's binder, destined for the specialty binder. An open row whose `chosen_catalog_card_id` is
    // the card is exactly what the hub's `wished` and Lookup's WISHLISTED fact both look for.
    await asSuperuser(db);
    const wish = await db.query(
      `select line_slot_id, chosen_catalog_card_id, held_for_binder_id, will_live_in_specialty, resolved_at
         from wishlist_item`,
    );
    expect(wish.rows).toEqual([
      {
        line_slot_id: null,
        chosen_catalog_card_id: "cardA",
        held_for_binder_id: SPEC,
        will_live_in_specialty: true,
        resolved_at: null,
      },
    ]);
    // A wish is not a placement, so no decision row.
    const audit = await db.query<{ n: number }>(`select count(*)::int n from placement_decision`);
    expect(audit.rows[0].n).toBe(0);
  });

  it("adding the same unowned card twice wishes for it ONCE", async () => {
    await seedCatalogCards(db, ["cardA"]);
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
    ]);
    await asOwner(db);
    await applyCollectionLog(pgliteClient(db), OWNER, COL, "cardA");
    await asOwner(db);
    const again = await applyCollectionLog(pgliteClient(db), OWNER, COL, "cardA");
    expect(again).toMatchObject({ ok: true, wishlisted: true });

    await asSuperuser(db);
    const n = await db.query<{ n: number }>(`select count(*)::int n from wishlist_item`);
    expect(n.rows[0].n).toBe(1);
    expect(await copyCountFor("cardA")).toBe(0);
  });

  it("a 'block' copy is not a card she owns, so the card reads as not owned — and is wished for", async () => {
    await seedCatalogCards(db, ["cardA"]);
    await seedBinders(db, [
      { id: SPEC, type: "specialty", name: "Specialty A" },
      { id: GEN, type: "general", name: "Binder 1" },
    ]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
    ]);
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
        values ('${CA1}', '${OWNER}', 'cardA', 'block', '${GEN}', 'front', 'red');
    `);

    await asOwner(db);
    const res = await applyCollectionLog(pgliteClient(db), OWNER, COL, "cardA");
    // A block marks a pocket no card can fill (system-design §4), so it does not make the card owned: the
    // answer is the not-owned one, not "you already own this". Pre-UIL-098 that meant a new copy; now it
    // means a wish, and the block row is left exactly as it was.
    expect(res).toMatchObject({ ok: true, wishlisted: true });
    expect(await copyCountFor("cardA")).toBe(1); // the block row only
  });
});

describe("CONTROL — the pre-fix shape (insert unconditionally) doubles the row", () => {
  it("logging an already-shelved-here card the old way produces TWO rows for one catalog card", async () => {
    await seedCatalogCards(db, ["cardA"]);
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, role, binder_id)
        values ('${CA1}', '${OWNER}', 'cardA', 'shelved', '${SPEC}');
    `);
    expect(await copyCountFor("cardA")).toBe(1);

    // Exactly what the old logCardIntoCollection did: insert unconditionally.
    await db.query(
      `insert into copy (owner_id, catalog_card_id, role, binder_id) values ($1, $2, 'shelved', $3)`,
      [OWNER, "cardA", SPEC],
    );
    expect(await copyCountFor("cardA")).toBe(2); // the defect UIL-048 is about
  });
});

/**
 * UIL-033 — logging a card is ONE transaction through `apply_write_ops`, not three awaited writes with a
 * TypeScript read-modify-write on `target_catalog_card_ids` in the middle. The RPC's
 * `union_collection_targets` (0007) unions SERVER-SIDE in one statement, so two logs that interleave
 * compose instead of the second clobbering the first — the lost update the old shape had.
 */
describe("UIL-033 · logging is atomic and two concurrent logs both land", () => {
  it("two cards logged at the same time both end up on the target list (pre-fix: one is lost)", async () => {
    await seedCatalogCards(db, ["cardA", "cardB"]);
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
    ]);
    // Both cards already shelved in the collection's binder, not yet on its list (UIL-098: the only log
    // that writes). The subject is unchanged — two unions racing must both land.
    await shelveIn(SPEC, CA1, "cardA");
    await shelveIn(SPEC, "c0000000-0000-0000-0000-000000000a02", "cardB");
    await asOwner(db);
    const client = pgliteClient(db);

    const [a, b] = await Promise.all([
      applyCollectionLog(client, OWNER, COL, "cardA"),
      applyCollectionLog(client, OWNER, COL, "cardB"),
    ]);
    expect(a).toMatchObject({ ok: true, created: false });
    expect(b).toMatchObject({ ok: true, created: false });

    await asSuperuser(db);
    expect((await targetsOf(COL)).sort()).toEqual(["cardA", "cardB"]);
    expect(await copyCountFor("cardA")).toBe(1);
    expect(await copyCountFor("cardB")).toBe(1);
  });

  /*
   * DELETED DELIBERATELY (UIL-098): "copy, audit row and tag land together — or none of them do". It forced
   * insert_copy's FK to fail inside the RPC to prove the copy, its audit row and the tag could not be
   * half-written. This path no longer writes a copy or an audit row at all — its only write is the tag
   * union, one statement — so there is no longer anything that could be half-applied for it to pin.
   */

  it("a collection that vanishes between read and write is NAMED, not passed off as success", async () => {
    await seedCatalogCards(db, ["cardA"]);
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
    ]);
    await shelveIn(SPEC, CA1, "cardA"); // the only log that writes (UIL-098)
    await asOwner(db);
    // Sabotage as a side effect of the ownership read, i.e. after the collection was read and before the
    // write: the collection row goes away (hers, so RLS allows it). union_collection_targets then matches
    // no row and says nothing — the case that must not come back as { ok: true }.
    const raw = pgliteClient(db);
    let armed = true;
    const client = new Proxy(raw as object, {
      get(target, prop, receiver) {
        if (prop !== "from") return Reflect.get(target, prop, receiver);
        return (table: string) => {
          if (table === "copy" && armed) {
            armed = false;
            void db.query(`delete from collection where id = $1`, [COL]);
          }
          return (raw as unknown as { from: (t: string) => unknown }).from(table);
        };
      },
    }) as unknown as DbClient;
    const res = await applyCollectionLog(client, OWNER, COL, "cardA");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("changed under you");
      expect(res.error).toContain("move it from the binder view"); // the remedy, on screen
    }
    // Honest about the state: the copy is in the binder (it already was), on no collection's list.
    await asSuperuser(db);
    expect(await copyCountFor("cardA")).toBe(1);
  });
});

/**
 * UIL-033, QA's follow-up: this poisons the JOIN — a trigger that raises on any update to `collection` — so
 * the union statement fails inside the RPC. It was written to prove a copy and an audit row went down with
 * it; since UIL-098 the log writes neither, so what it still pins is the part that matters to her: a failed
 * join is REPORTED, with its cause, and the tag is not added.
 */
describe("UIL-033 · the join failing inside the RPC is reported, and nothing is tagged", () => {
  it("an UNOWNED card: a poisoned join takes the wishlist row down with it — one call, not two", async () => {
    // The wish path writes TWO things — the wishlist row and the tag — so atomicity is load-bearing here
    // again. A version that wrote the wish in its own call would leave her wishing for a card on no list.
    await seedCatalogCards(db, ["cardA"]);
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
    ]);
    await db.exec(`
      create function poison_collection_update() returns trigger language plpgsql as $$
      begin
        raise exception 'poisoned join';
      end $$;
      create trigger poison_join before update on collection
        for each row execute function poison_collection_update();
    `);

    await asOwner(db);
    const res = await applyCollectionLog(pgliteClient(db), OWNER, COL, "cardA");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("poisoned join");

    await asSuperuser(db);
    const wish = await db.query<{ n: number }>(`select count(*)::int n from wishlist_item`);
    expect(wish.rows[0].n).toBe(0);
    expect(await copyCountFor("cardA")).toBe(0);
    expect(await targetsOf(COL)).toEqual([]);
  });

  it("poisoned join → nothing lands, and the action says why", async () => {
    await seedCatalogCards(db, ["cardA"]);
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await seedCollections(db, [
      { id: COL, name: "Matsuno", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
    ]);
    await db.exec(`
      create function poison_collection_update() returns trigger language plpgsql as $$
      begin
        raise exception 'poisoned join';
      end $$;
      create trigger poison_join before update on collection
        for each row execute function poison_collection_update();
    `);
    await shelveIn(SPEC, CA1, "cardA"); // the only log that writes (UIL-098)

    await asOwner(db);
    const res = await applyCollectionLog(pgliteClient(db), OWNER, COL, "cardA");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("poisoned join");

    await asSuperuser(db);
    expect(await copyCountFor("cardA")).toBe(1); // the copy that was already there, untouched
    const audit = await db.query<{ n: number }>(`select count(*)::int n from placement_decision`);
    expect(audit.rows[0].n).toBe(0);
    expect(await targetsOf(COL)).toEqual([]);
  });
});
