/**
 * UIL-060 Half 2 — her stand-in swapped for the real card once TCGdex carries it. Real PGlite, every migration
 * applied, real RLS under `set role authenticated`, the real `manualMatchStandIn` and `reconcileStandIns`.
 *
 *  1. Every column that can hold a card id is repointed, then the stand-in is deleted — and the list of foreign keys
 *     to catalog_card is pinned, so a new one cannot be added without the swap learning about it.
 *  2. A shared Dex key (she already holds the real card under the same variant) merges (0041): her copies join the
 *     real card's group, Dex quantities and removals add — including the empty group "Wrong card?" leaves behind.
 *  3. Only her own stand-in can be swapped.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Row } from "@/lib/repo";
import {
  FIX_STAND_IN_REFUSED,
  fixStandIn,
  keepStandIn,
  manualMatchStandIn,
  reconcileStandIns,
  reviewStandInAgain,
  swapStandInFor,
  type StandInInput,
} from "@/lib/sync";
import { asOwner, asSuperuser, freshRpcDb, OWNER } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const OTHER = "00000000-0000-0000-0000-000000000002";
const ENTRY = "e0000000-0000-0000-0000-0000000000e1";
const REAL = "30th-015";

let db: PGlite;
const q = async <T>(sql: string) => (await db.query<T>(sql)).rows;

beforeEach(async () => {
  db = await freshRpcDb();
  await db.exec(`
    insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id, types, stage)
      values ('${REAL}', 'Fuecoco ex', '30th', '30th Celebration', '015', '{Fire}', 'Basic');
    insert into unresolved_entry (id, owner_id, dex_id, dex_set_name, dex_number, dex_name, dex_variant_raw,
      quantity, locale, reason, status)
      values ('${ENTRY}', '${OWNER}', '30th-15', '30th Celebration', '15', 'Fuecoco ex', 'Normal', 2,
        'English', 'UNKNOWN_SET', 'WAITING');
  `);
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

/** Her stand-in, made before the set was mirrored: no set id, and the number as printed on the card. */
const FUECOCO: StandInInput = {
  name: "Fuecoco ex",
  setName: "30th Celebration",
  setId: null,
  localId: "15/128",
  language: "en",
  kind: { kind: "pokemon", type: "Fire", stage: "Basic", dexId: 909 },
};

async function makeStandIn(): Promise<string> {
  return (await manualMatchStandIn(pgliteClient(db), ENTRY, FUECOCO)).standInId;
}

async function catalog(): Promise<Row<"catalog_card">[]> {
  return q<Row<"catalog_card">>(`select * from catalog_card`);
}

/** Every other place a card id lives, pointed at `id` (the copies, group and entry come from the stand-in match). */
async function referenceEverywhere(id: string): Promise<void> {
  await asSuperuser(db);
  await db.exec(`
    insert into dex_presence (owner_id, catalog_card_id, dex_variant_raw, quantity)
      values ('${OWNER}', '${id}', 'Normal', 2);
    insert into removed_presence (owner_id, catalog_card_id, dex_variant_raw, count)
      values ('${OWNER}', '${id}', 'Reverse Holo', 1);
    insert into evolution_line (id, owner_id, root_dex_id, color_band)
      values ('a0000000-0000-0000-0000-0000000000a1', '${OWNER}', 909, (select band from color_band limit 1));
    insert into line_slot (id, owner_id, line_id, stage_index, stage, state, target_catalog_card_id)
      values ('b0000000-0000-0000-0000-0000000000b1', '${OWNER}', 'a0000000-0000-0000-0000-0000000000a1', 0,
        'Basic', 'placeholder', '${id}');
    insert into wishlist_item (owner_id, line_slot_id, chosen_catalog_card_id, alternate_catalog_card_ids)
      values ('${OWNER}', 'b0000000-0000-0000-0000-0000000000b1', '${id}', array['${id}', 'other-1']);
    insert into placement_decision (owner_id, catalog_card_id, decision, reason, resolved_by)
      values ('${OWNER}', '${id}', 'shelve', 'test', 'user');
    insert into collection (owner_id, name, target_catalog_card_ids)
      values ('${OWNER}', 'Pikachus', array['other-2', '${id}']),
             ('${OWNER}', 'Already has it', array['${REAL}', '${id}']);
    insert into last_sync_snapshot (owner_id, snapshot)
      values ('${OWNER}', jsonb_build_object('createdCopyKeys',
        jsonb_build_array(jsonb_build_object('catalog_card_id', '${id}', 'dex_variant_raw', 'Normal')),
        'note', 'not ${id} as a whole value'));
  `);
  await asOwner(db);
}

/** Where each card-id column points, as one comparable record. */
async function whereEverythingPoints() {
  await asSuperuser(db);
  const one = async (sql: string) => (await q<{ v: unknown }>(sql)).map((r) => r.v);
  const out = {
    copy: await one(`select distinct catalog_card_id v from copy`),
    presence_group: await one(`select catalog_card_id v from presence_group`),
    dex_presence: await one(`select catalog_card_id v from dex_presence`),
    removed_presence: await one(`select catalog_card_id v from removed_presence`),
    line_slot: await one(`select target_catalog_card_id v from line_slot`),
    wishlist_chosen: await one(`select chosen_catalog_card_id v from wishlist_item`),
    wishlist_alternates: await one(`select alternate_catalog_card_ids v from wishlist_item`),
    unresolved_entry: await one(`select manual_match_id v from unresolved_entry`),
    placement_decision: await one(`select catalog_card_id v from placement_decision`),
    collections: await one(`select target_catalog_card_ids v from collection order by name desc`),
    snapshot: await one(`select snapshot v from last_sync_snapshot`),
  };
  await asOwner(db);
  return out;
}

describe("UIL-060 Half 2 · the swap", () => {
  it("pins every foreign key to catalog_card, so a new one cannot slip past the swap", async () => {
    await asSuperuser(db);
    const fks = await q<{ ref: string }>(`
      select conrelid::regclass::text || '.' || a.attname as ref
        from pg_constraint c
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
       where c.contype = 'f' and c.confrelid = 'catalog_card'::regclass
       order by 1`);
    // Each of these is repointed by 0039 `swap_stand_in` (with placement_decision.catalog_card_id and the two id
    // arrays, which carry no foreign key). Adding a column here means teaching the swap about it first.
    expect(fks.map((r) => r.ref)).toEqual([
      "copy.catalog_card_id",
      "dex_presence.catalog_card_id",
      "line_slot.target_catalog_card_id",
      "presence_group.catalog_card_id",
      "removed_presence.catalog_card_id",
      "unresolved_entry.manual_match_id",
      "wishlist_item.chosen_catalog_card_id",
    ]);
  });

  it("swaps a certain match on its own: every reference repointed, the undo record too, the stand-in gone", async () => {
    const standIn = await makeStandIn();
    await referenceEverywhere(standIn);

    const report = await reconcileStandIns(pgliteClient(db), await catalog());
    expect(report.unsure).toEqual([]);
    expect(report.swapped).toHaveLength(1);
    expect(report.swapped[0]).toMatchObject({
      standIn: { id: standIn, name: "Fuecoco ex", localId: "15/128" },
      real: { id: REAL, setName: "30th Celebration", localId: "015" },
    });

    expect(await whereEverythingPoints()).toEqual({
      copy: [REAL],
      presence_group: [REAL],
      dex_presence: [REAL],
      removed_presence: [REAL],
      line_slot: [REAL],
      wishlist_chosen: [REAL],
      wishlist_alternates: [[REAL, "other-1"]],
      unresolved_entry: [REAL],
      placement_decision: [REAL],
      // The real card takes the stand-in's place, once: a list that already named it just loses the stand-in.
      collections: [["other-2", REAL], [REAL]],
      snapshot: [
        {
          createdCopyKeys: [{ catalog_card_id: REAL, dex_variant_raw: "Normal" }],
          note: `not ${standIn} as a whole value`,
        },
      ],
    });
    await asSuperuser(db);
    expect(await q(`select 1 from catalog_card where source = 'user'`)).toEqual([]);
  });

  it("is safe to run again: the next load finds nothing to do", async () => {
    await makeStandIn();
    await reconcileStandIns(pgliteClient(db), await catalog());
    expect(await reconcileStandIns(pgliteClient(db), await catalog())).toEqual({
      swapped: [],
      unsure: [],
      kept: [],
    });
  });

  it("merges a shared Dex key: copies join the real group, Dex quantities and removals add (0041)", async () => {
    const standIn = await makeStandIn();
    await asSuperuser(db);
    // The real card's side of the key: an EMPTY group (what "Wrong card?" leaves behind), a Dex count and a removal.
    await db.exec(`
      insert into presence_group (owner_id, catalog_card_id, dex_variant_raw, desired_count)
        values ('${OWNER}', '${REAL}', 'Normal', 0);
      insert into dex_presence (owner_id, catalog_card_id, dex_variant_raw, quantity)
        values ('${OWNER}', '${REAL}', 'Normal', 1),
               ('${OWNER}', '${standIn}', 'Normal', 2);
      insert into removed_presence (owner_id, catalog_card_id, dex_variant_raw, count)
        values ('${OWNER}', '${REAL}', 'Normal', 1),
               ('${OWNER}', '${standIn}', 'Normal', 1);
    `);
    await asOwner(db);

    const report = await reconcileStandIns(pgliteClient(db), await catalog());
    expect(report.unsure).toEqual([]);
    expect(report.swapped).toHaveLength(1);

    await asSuperuser(db);
    expect(
      await q(`select catalog_card_id, dex_variant_raw, desired_count from presence_group`),
    ).toEqual([{ catalog_card_id: REAL, dex_variant_raw: "Normal", desired_count: 2 }]);
    expect(
      await q(
        `select count(*)::int n from copy c join presence_group g on g.id = c.presence_group_id
          where c.catalog_card_id = '${REAL}' and g.catalog_card_id = '${REAL}'`,
      ),
    ).toEqual([{ n: 2 }]);
    expect(await q(`select catalog_card_id, quantity from dex_presence`)).toEqual([
      { catalog_card_id: REAL, quantity: 3 },
    ]);
    expect(await q(`select catalog_card_id, count from removed_presence`)).toEqual([
      { catalog_card_id: REAL, count: 2 },
    ]);
    expect(await q(`select 1 from catalog_card where source = 'user'`)).toEqual([]);
  });

  it("swaps only her own stand-in", async () => {
    const standIn = await makeStandIn();
    await db.exec(`set request.jwt.claim.sub = '${OTHER}'`);
    await expect(swapStandInFor(pgliteClient(db), standIn, REAL)).rejects.toThrow(
      /not in your catalog/,
    );
    await asSuperuser(db);
    expect(await q(`select 1 from catalog_card where tcgdex_id = '${standIn}'`)).toHaveLength(1);
  });

  it("never swaps across languages", async () => {
    const standIn = await makeStandIn();
    await asSuperuser(db);
    await db.exec(`
      insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id, locale)
        values ('ja:30th-015', 'ホゲータex', 'ja:30th', '30th Celebration', '015', 'ja');
    `);
    await asOwner(db);
    await expect(swapStandInFor(pgliteClient(db), standIn, "ja:30th-015")).rejects.toThrow(
      /not in the catalog in this language/,
    );
  });
});

describe("settling a stand-in she was asked about: what it holds, keep it, fix it", () => {
  /** A stand-in whose set name is only close to the real one ("Celebrations"), so the swap is unsure. */
  async function unsureStandIn(): Promise<string> {
    return (
      await manualMatchStandIn(pgliteClient(db), ENTRY, {
        ...FUECOCO,
        setName: "30th Celebrations",
      })
    ).standInId;
  }

  it("says how many copies the stand-in holds and where", async () => {
    const standIn = await unsureStandIn();
    const report = await reconcileStandIns(pgliteClient(db), await catalog());
    expect(report.unsure).toHaveLength(1);
    expect(report.unsure[0].standIn.id).toBe(standIn);
    expect(report.unsure[0].held).toEqual({
      count: 2,
      where: [{ label: "Still in the haul", count: 2 }],
    });
  });

  it("kept: not asked again for the same cards, asked again when a new one appears or she asks", async () => {
    const standIn = await unsureStandIn();
    await keepStandIn(pgliteClient(db), standIn, [REAL]);

    let report = await reconcileStandIns(pgliteClient(db), await catalog());
    expect(report.unsure).toEqual([]);
    expect(report.kept.map((k) => [k.id, k.held.count])).toEqual([[standIn, 2]]);

    // A new candidate in the catalog: asked again.
    await asSuperuser(db);
    await db.exec(`
      insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id, types, stage)
        values ('30th-147', 'Fuecoco ex', '30th', '30th Celebration', '147', '{Fire}', 'Basic');
    `);
    await asOwner(db);
    report = await reconcileStandIns(pgliteClient(db), await catalog());
    expect(report.unsure.map((u) => u.standIn.id)).toEqual([standIn]);
    expect(report.kept).toEqual([]);

    // Kept again, then "Ask me again".
    await keepStandIn(pgliteClient(db), standIn, ["30th-015", "30th-147"]);
    expect((await reconcileStandIns(pgliteClient(db), await catalog())).unsure).toEqual([]);
    await reviewStandInAgain(pgliteClient(db), standIn);
    expect(
      (await reconcileStandIns(pgliteClient(db), await catalog())).unsure.map((u) => u.standIn.id),
    ).toEqual([standIn]);
  });

  it("fixed: the corrected stand-in is matched again, and swaps on its own when that makes it certain", async () => {
    const standIn = await unsureStandIn();
    await keepStandIn(pgliteClient(db), standIn, [REAL]);
    await fixStandIn(pgliteClient(db), standIn, {
      name: "Fuecoco ex",
      setName: "30th Celebration",
      localId: "15/128",
    });
    const report = await reconcileStandIns(pgliteClient(db), await catalog());
    expect(report.swapped.map((s) => [s.standIn.id, s.real.id])).toEqual([[standIn, REAL]]);
    await asSuperuser(db);
    expect(await q(`select count(*)::int n from copy where catalog_card_id = '${REAL}'`)).toEqual([
      { n: 2 },
    ]);
  });

  it("refuses a fix that would make it a twin of another stand-in, or leave it without a name", async () => {
    const standIn = await unsureStandIn();
    await asSuperuser(db);
    await db.exec(`
      insert into catalog_card (tcgdex_id, name, set_name, local_id, source, owner_id, locale)
        values ('user:en:22222222-2222-4222-8222-222222222222', 'Fuecoco ex', 'Other Set', '15/128',
          'user', '${OWNER}', 'en');
    `);
    await asOwner(db);
    await expect(
      fixStandIn(pgliteClient(db), standIn, {
        name: "Fuecoco ex",
        setName: "Other Set",
        localId: "15/128",
      }),
    ).rejects.toThrow(FIX_STAND_IN_REFUSED.twin);
    await expect(
      fixStandIn(pgliteClient(db), standIn, { name: " ", setName: "x", localId: "1" }),
    ).rejects.toThrow(FIX_STAND_IN_REFUSED.empty);
  });
});
