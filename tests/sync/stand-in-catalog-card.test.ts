/**
 * UIL-060 Half 1 — a card TCGdex lacks gets a STAND-IN catalog_card of her own, created in the same
 * transaction that matches the unresolved entry to it. Real PGlite, every migration applied, real RLS
 * under `set role authenticated`, the real `manualMatchStandIn`.
 *
 *  1. 0015 is 0014's function verbatim plus the one `insert_catalog_stand_in` branch (diffed).
 *  2. The schema and RLS admit exactly the `user:` + `source = 'user'` shape from the app user and
 *     nothing else: no TCGdex-looking insert, no 'user' row outside the namespace, no update of a real row.
 *  3. Create-and-match is one RPC: stand-in row + group + N copies + entry RESOLVED pointing at it — or
 *     nothing at all when the transaction fails after the stand-in op.
 *  4. A twin is refused with the existing stand-in offered; a Pokémon stand-in bands by its declared
 *     type (a bare one would band White); the mirror's upsert leaves a stand-in alone.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { catalogCardRepo, type Row } from "@/lib/repo";
import { band } from "@/lib/engine";
import { toCatalogCard } from "@/lib/plan";
import { isStandInId, manualMatchStandIn, StandInTwinError, type StandInInput } from "@/lib/sync";
import { KEY_FORM_TYPE_COLOR_MAP } from "../engine/fixtures";
import { applyOps, asOwner, asSuperuser, freshRpcDb } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

/** The function definition onward — anchored on the definition line, not the header prose above it. */
function migrationFn(file: string): string {
  const sql = readFileSync(path.join(process.cwd(), "supabase", "migrations", file), "utf8");
  const at = sql.indexOf("\ncreate or replace function apply_write_ops(payload jsonb)");
  expect(at).toBeGreaterThan(0);
  return sql.slice(at);
}

let db: PGlite;
const ENTRY = "e0000000-0000-0000-0000-0000000000e1";
const q = async <T>(sql: string) => (await db.query<T>(sql)).rows;

beforeEach(async () => {
  db = await freshRpcDb();
  await db.exec(`
    insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id, types)
      values ('sv03-027', 'Charmeleon', 'sv03', 'Obsidian Flames', '027', '{Fire}');
    insert into unresolved_entry (id, owner_id, dex_id, dex_set_name, dex_number, dex_name, dex_variant_raw,
      quantity, locale, reason, status)
      values ('${ENTRY}', '00000000-0000-0000-0000-000000000001', 'sv03-999', 'Obsidian Flames', '999',
        'Mystery Fossil', 'Normal', 2, 'English', 'UNKNOWN_CARD', 'WAITING');
  `);
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

const FOSSIL: StandInInput = {
  name: "Mystery Fossil",
  setName: "Obsidian Flames",
  setId: "sv03",
  localId: "999",
  kind: { kind: "pokemon", type: "Fire", stage: "Basic", dexId: 4 },
};

describe("0015 · the migration", () => {
  it("is 0014's function verbatim plus the one insert_catalog_stand_in branch", () => {
    const base = migrationFn("0014_forget_set_alias.sql");
    const mine = migrationFn("0015_stand_in_catalog_card.sql");
    const start = mine.indexOf("      -- NEW in 0015");
    const end = mine.indexOf("      else\n", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(mine.slice(0, start) + mine.slice(end)).toBe(base);
    expect(mine.slice(start, end)).toContain("when 'insert_catalog_stand_in' then");
    // The inherited branches are still there: the composed function carries all three additions.
    expect(mine).toContain("when 'delete_set_alias' then");
    expect(mine).toContain(
      "resolved_decision_collection_id = case when p ? 'resolved_decision_collection_id'",
    );
  });

  it("every existing row reads source = 'tcgdex' with no backfill, and the check ties the namespace to it", async () => {
    await asSuperuser(db);
    expect(await q(`select source from catalog_card`)).toEqual([{ source: "tcgdex" }]);
    // A 'user' row outside the namespace, or a namespaced row that claims to be TCGdex: both refused
    // by the constraint even for the superuser (schema, not policy).
    await expect(
      db.query(
        `insert into catalog_card (tcgdex_id, name, source) values ('sv03-998', 'x', 'user')`,
      ),
    ).rejects.toThrow(/catalog_card_user_id_shape/);
    await expect(
      db.query(`insert into catalog_card (tcgdex_id, name) values ('user:abc', 'x')`),
    ).rejects.toThrow(/catalog_card_user_id_shape/);
  });

  it("RLS: the app user may insert only user: rows marked 'user', and may not update a TCGdex row", async () => {
    await expect(
      db.query(`insert into catalog_card (tcgdex_id, name) values ('sv03-998', 'Sneaky')`),
    ).rejects.toThrow(/row-level security/);
    await db.query(
      `insert into catalog_card (tcgdex_id, name, source) values ('user:11111111-1111-4111-8111-111111111111', 'Mine', 'user')`,
    );
    // An UPDATE on a TCGdex row matches no row under the policy: nothing changes, no error.
    await db.query(`update catalog_card set name = 'Hacked' where tcgdex_id = 'sv03-027'`);
    await asSuperuser(db);
    expect(await q(`select name from catalog_card where tcgdex_id = 'sv03-027'`)).toEqual([
      { name: "Charmeleon" },
    ]);
    expect(await q(`select source from catalog_card where tcgdex_id like 'user:%'`)).toEqual([
      { source: "user" },
    ]);
  });
});

describe("UIL-060 · create a stand-in and match the entry to it, in one transaction", () => {
  it("stand-in row + presence group + N in-haul copies + entry RESOLVED pointing at it", async () => {
    const res = await manualMatchStandIn(pgliteClient(db), ENTRY, FOSSIL);
    expect(isStandInId(res.standInId)).toBe(true);
    expect(res.created).toBe(2);
    expect(res.learnedAlias).toBeNull(); // UNKNOWN_CARD: the set was already known, nothing to learn

    const card = await q<Row<"catalog_card">>(
      `select * from catalog_card where tcgdex_id = '${res.standInId}'`,
    );
    expect(card[0]).toMatchObject({
      name: "Mystery Fossil",
      set_id: "sv03",
      set_name: "Obsidian Flames",
      local_id: "999",
      types: ["Fire"],
      stage: "Basic",
      dex_id: [4],
      source: "user",
      image_url: null,
      card_class: "standard",
    });
    // UIL-088: identifying a card is not placing it. Both copies land IN HAUL — not `'bulk'`, which would
    // claim she had filed them in the bulk box, and which is what made the Haul Plan read an imported card
    // as "already placed" (UIL-087). Running through the real schema also proves 0018's `copy_role_check`
    // admits the new value.
    expect(
      await q(
        `select role, count(*)::int as n from copy where catalog_card_id = '${res.standInId}' group by role`,
      ),
    ).toEqual([{ role: "haul", n: 2 }]);
    expect(
      await q(
        `select desired_count from presence_group where catalog_card_id = '${res.standInId}'`,
      ),
    ).toEqual([{ desired_count: 2 }]);
    expect(
      await q(`select status, manual_match_id from unresolved_entry where id = '${ENTRY}'`),
    ).toEqual([{ status: "RESOLVED", manual_match_id: res.standInId }]);
  });

  it("a Pokémon stand-in bands by its declared type; a Trainer stand-in bands White", async () => {
    const res = await manualMatchStandIn(pgliteClient(db), ENTRY, FOSSIL);
    const [row] = await q<Row<"catalog_card">>(
      `select * from catalog_card where tcgdex_id = '${res.standInId}'`,
    );
    expect(band(toCatalogCard(row), KEY_FORM_TYPE_COLOR_MAP)).toBe("red");
    const trainer = toCatalogCard({ ...row, types: [], stage: null, dex_id: [] });
    expect(trainer.category).toBe("Trainer");
    expect(band(trainer, KEY_FORM_TYPE_COLOR_MAP)).toBe("white");
  });

  it("all or nothing: a failure after the stand-in op leaves no stand-in behind", async () => {
    // Same ops the function emits, but the entry id points nowhere → the update patches no row; make it
    // fail hard instead by referencing a copy column constraint: an invalid role.
    await expect(
      applyOps(db, {
        ops: [
          {
            op: "insert_catalog_stand_in",
            tcgdex_id: "user:22222222-2222-4222-8222-222222222222",
            name: "Ghost",
            set_id: null,
            set_name: null,
            local_id: null,
          },
          {
            op: "insert_copy",
            presence_group_id: "00000000-0000-4000-8000-00000000900d", // a group that does not exist: this op must fail (0023)
            id: "c0000000-0000-0000-0000-0000000000c1",
            catalog_card_id: "user:22222222-2222-4222-8222-222222222222",
            role: "not-a-role" as never,
          },
        ],
      }),
    ).rejects.toThrow();
    await asSuperuser(db);
    expect(
      await q(`select count(*)::int as n from catalog_card where tcgdex_id like 'user:%'`),
    ).toEqual([{ n: 0 }]);
  });

  it("refuses a twin and offers the existing stand-in instead", async () => {
    const first = await manualMatchStandIn(pgliteClient(db), ENTRY, FOSSIL);
    // A second entry for the same physical card, e.g. another variant row.
    await asSuperuser(db);
    await db.exec(`
      insert into unresolved_entry (id, owner_id, dex_id, dex_set_name, dex_number, dex_name, dex_variant_raw,
        quantity, locale, reason, status)
        values ('e0000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-000000000001', 'sv03-999',
          'Obsidian Flames', '999', 'Mystery Fossil', 'Reverse Holo', 1, 'English', 'UNKNOWN_CARD', 'WAITING');
    `);
    await asOwner(db);
    const attempt = manualMatchStandIn(pgliteClient(db), "e0000000-0000-0000-0000-0000000000e2", {
      ...FOSSIL,
      name: "  mystery FOSSIL ", // case and whitespace do not make it a different card
    });
    await expect(attempt).rejects.toBeInstanceOf(StandInTwinError);
    await expect(attempt).rejects.toThrow(/already exists.*Match this entry to it/);
    const err = (await attempt.catch((e: unknown) => e)) as StandInTwinError;
    expect(err.twin.tcgdex_id).toBe(first.standInId);
    await asSuperuser(db);
    expect(await q(`select count(*)::int as n from catalog_card where source = 'user'`)).toEqual([
      { n: 1 },
    ]);
  });

  it("the mirror's upsert of the same set leaves the stand-in alone, and the repo lists it", async () => {
    const res = await manualMatchStandIn(pgliteClient(db), ENTRY, FOSSIL);
    // What syncSet does for sv03: upsert every card TCGdex returned for it. The stand-in is not among them.
    await asSuperuser(db);
    await catalogCardRepo.upsertMany(pgliteClient(db), [
      {
        tcgdex_id: "sv03-027",
        name: "Charmeleon",
        set_id: "sv03",
        local_id: "027",
        types: ["Fire"],
      },
      {
        tcgdex_id: "sv03-028",
        name: "Charizard",
        set_id: "sv03",
        local_id: "028",
        types: ["Fire"],
      },
    ]);
    const after = await q<{ tcgdex_id: string; source: string }>(
      `select tcgdex_id, source from catalog_card where set_id = 'sv03' order by 1`,
    );
    expect(after).toEqual([
      { tcgdex_id: "sv03-027", source: "tcgdex" },
      { tcgdex_id: "sv03-028", source: "tcgdex" },
      { tcgdex_id: res.standInId, source: "user" },
    ]);
    expect((await catalogCardRepo.listStandIns(pgliteClient(db))).map((c) => c.tcgdex_id)).toEqual([
      res.standInId,
    ]);
  });
});
