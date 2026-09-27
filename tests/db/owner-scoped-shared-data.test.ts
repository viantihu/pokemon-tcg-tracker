/**
 * UIL-127b — migration 0033: what every account shared becomes each account's own. Real Postgres (PGlite, every
 * migration on disk).
 *
 * What must hold:
 *   - THE CONVERSION: every existing stand-in goes to the owner whose rows name it (the one owner when none does),
 *     every learned set alias to the one owner, and an alias with no owner at all is dropped. Ambiguity RAISES:
 *     a stand-in two owners name, or aliases with two owners to choose from, stops the migration rather than guess.
 *     The block between the CONVERSION markers is the whole conversion (the Database Engineer runs it, verbatim, on
 *     each baseline), and running it twice changes nothing.
 *   - HER COLOURS: every owner that exists keeps exactly the order and map she has now.
 *   - THE CENSUS (QA's item 3, the Tech Lead's C5): every public table has RLS; every table carries an
 *     `owner_id = auth.uid()` policy unless it is on the explicit shared list; the shared config tables are
 *     read-only; every view is security_invoker; no function in public is SECURITY DEFINER. A new table or view
 *     that breaks any of these fails here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  applyMigration,
  asSuperuser,
  freshRpcDb,
  MIGRATIONS,
  MIGRATIONS_DIR,
  OWNER,
} from "../support/pglite-rpc";

const FILE = MIGRATIONS.find((f) => f.endsWith("_owner_scoped_shared_data.sql"))!;
const VERSION = FILE.split("_")[0];
const SQL = readFileSync(path.join(MIGRATIONS_DIR, FILE), "utf8");
const B = "00000000-0000-0000-0000-00000000000b";
const BINDER_A = "b0000000-0000-4000-8000-00000000000a";
const BINDER_B = "b0000000-0000-4000-8000-00000000000b";
const NAMED = "user:en:11111111-1111-4111-8111-111111111111";
const LOOSE = "user:en:22222222-2222-4222-8222-222222222222";

/** The statements between `-- >>> NNNN CONVERSION` and `-- <<< NNNN CONVERSION`, exactly as the file holds them. */
function conversionBlock(): string {
  const open = SQL.indexOf(`-- >>> ${VERSION} CONVERSION`);
  const close = SQL.indexOf(`-- <<< ${VERSION} CONVERSION`);
  expect(open).toBeGreaterThan(0);
  expect(close).toBeGreaterThan(open);
  return SQL.slice(SQL.indexOf("\n", open) + 1, close);
}

let db: PGlite;
afterEach(async () => {
  if (db && !db.closed) await db.close();
});

/** A database one step before 0033, holding one owner's binder, a copy on a stand-in, a loose stand-in, aliases. */
async function before(owners: string[] = [OWNER]): Promise<PGlite> {
  const d = await freshRpcDb({ before: VERSION });
  await d.exec(`
    insert into catalog_card (tcgdex_id, name) values ('sv03-026', 'Charmander');
    insert into catalog_card (tcgdex_id, name, source) values
      ('${NAMED}', 'Mystery Fossil', 'user'), ('${LOOSE}', 'Odd Promo', 'user');
    insert into set_alias (locale, dex_code, tcgdex_set_id, source) values
      ('en', 'OBF', 'sv03', 'manual'), ('ja', 'm6', 'swshp', 'name-resolved');
  `);
  for (const [i, o] of owners.entries()) {
    await d.query(
      `insert into binder (id, owner_id, name, type) values ($1, $2, 'KB', 'general')`,
      [i === 0 ? BINDER_A : BINDER_B, o],
    );
  }
  if (owners.length > 0) {
    await d.query(
      `insert into copy (owner_id, catalog_card_id, role) values ($1, '${NAMED}', 'bulk')`,
      [owners[0]],
    );
  }
  return d;
}

async function rows<T>(sql: string): Promise<T[]> {
  await asSuperuser(db);
  return (await db.query<T>(sql)).rows;
}

const owned = () =>
  rows<{ tcgdex_id: string; owner_id: string | null }>(
    `select tcgdex_id, owner_id from catalog_card order by tcgdex_id`,
  );
const aliases = () =>
  rows<{ owner_id: string; locale: string; dex_code: string }>(
    `select owner_id, locale, dex_code from set_alias order by locale, dex_code`,
  );

describe("UIL-127b · 0033 converts what exists", () => {
  it("a stand-in goes to the owner whose rows name it; one no row names, to the one owner; the mirror stays ownerless", async () => {
    db = await before();
    await applyMigration(db, FILE);
    expect(await owned()).toEqual([
      { tcgdex_id: "sv03-026", owner_id: null },
      { tcgdex_id: NAMED, owner_id: OWNER },
      { tcgdex_id: LOOSE, owner_id: OWNER },
    ]);
  });

  it("every learned alias goes to the one owner", async () => {
    db = await before();
    await applyMigration(db, FILE);
    expect(await aliases()).toEqual([
      { owner_id: OWNER, locale: "en", dex_code: "OBF" },
      { owner_id: OWNER, locale: "ja", dex_code: "m6" },
    ]);
  });

  it("with no owner at all (Production before promotion), aliases are dropped and stand-ins must not exist", async () => {
    db = await freshRpcDb({ before: VERSION });
    await db.exec(`
      insert into set_alias (locale, dex_code, tcgdex_set_id, source) values ('en', 'OBF', 'sv03', 'manual');
    `);
    await applyMigration(db, FILE);
    expect(await aliases()).toEqual([]);
  });

  it("RAISES on a stand-in two owners name, rather than give it to one", async () => {
    db = await before([OWNER, B]);
    await db.query(
      `insert into copy (owner_id, catalog_card_id, role) values ($1, '${NAMED}', 'bulk')`,
      [B],
    );
    await expect(applyMigration(db, FILE)).rejects.toThrow(/named by more than one owner/);
  });

  it("RAISES on stand-ins or aliases with two owners to choose from", async () => {
    db = await before([OWNER, B]);
    // NAMED is A's alone; LOOSE is named by no one, and there are two owners.
    await expect(applyMigration(db, FILE)).rejects.toThrow(/no row names, and 2 owners/);
  });

  it("every existing owner keeps exactly the rainbow order and type map she has now", async () => {
    db = await before();
    // Her own order, not the shipped one: red and orange swapped (0003 ships red 1, orange 2).
    await db.exec(`
      update color_band set position = 99 where band = 'red';
      update color_band set position = 1 where band = 'orange';
      update color_band set position = 2 where band = 'red';
    `);
    await applyMigration(db, FILE);
    expect(
      await rows(
        `select band, position from owner_band_order where owner_id = '${OWNER}' order by position`,
      ),
    ).toEqual(await rows(`select band, position from color_band order by position`));
    expect(
      await rows(
        `select card_type, band from owner_type_band where owner_id = '${OWNER}' order by card_type`,
      ),
    ).toEqual(await rows(`select card_type, band from type_color_map order by card_type`));
  });
});

describe("UIL-127b · the CONVERSION block is the whole conversion (the Database Engineer runs it on each baseline)", () => {
  it("run alone on the pre-0033 rows (after the two columns exist) it gives the migration's result", async () => {
    db = await before();
    await applyMigration(db, FILE);
    const migrated = { cards: await owned(), aliases: await aliases() };
    await db.close();

    db = await before();
    await db.exec(
      `alter table catalog_card add column owner_id uuid; alter table set_alias add column owner_id uuid;`,
    );
    await db.exec(conversionBlock());
    expect({ cards: await owned(), aliases: await aliases() }).toEqual(migrated);
  });

  it("running it a second time changes nothing", async () => {
    db = await before();
    await applyMigration(db, FILE);
    const once = { cards: await owned(), aliases: await aliases() };
    await db.exec(conversionBlock());
    expect({ cards: await owned(), aliases: await aliases() }).toEqual(once);
  });

  it("names tables unqualified and never reads auth.users (the Database Engineer's conditions)", () => {
    const block = conversionBlock();
    expect(block).not.toMatch(/\bauth\.users\b/);
    expect(block).not.toMatch(/\bpublic\./);
    // The block touches only stand-in catalog rows, never the mirror.
    for (const m of block.matchAll(/update\s+catalog_card[\s\S]*?;/gi)) {
      expect(m[0]).toMatch(/source\s*=\s*'user'/);
    }
  });
});

describe("UIL-127b · the RLS census (QA item 3; the Tech Lead's C5)", () => {
  /** Tables every account shares, and why. Anything else must be owner-scoped. */
  const SHARED = {
    catalog_card: "the mirror is shared; a stand-in is scoped to its owner by its own policies",
    color_band: "the global band keys and default order, read-only",
    type_color_map: "the default type map, read-only",
  };

  it("every public table has row-level security on", async () => {
    db = await freshRpcDb();
    const off = await rows<{ relname: string }>(`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity order by 1`);
    expect(off).toEqual([]);
  });

  it("every table outside the shared list has an owner_id = auth.uid() policy, and the list is exactly the shared tables", async () => {
    db = await freshRpcDb();
    const tables = await rows<{ relname: string }>(`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' order by 1`);
    const scoped = new Set(
      (
        await rows<{ tablename: string }>(`
          select tablename from pg_policies
          where schemaname = 'public' and cmd = 'ALL'
            and qual ~ 'owner_id = auth\\.uid\\(\\)' and with_check ~ 'owner_id = auth\\.uid\\(\\)'`)
      ).map((r) => r.tablename),
    );
    const unscoped = tables.map((t) => t.relname).filter((t) => !scoped.has(t));
    expect(unscoped.sort()).toEqual(Object.keys(SHARED).sort());
  });

  it("the shared config tables are read-only to a signed-in user", async () => {
    db = await freshRpcDb();
    const pol = await rows<{ tablename: string; cmd: string }>(`
      select tablename, cmd from pg_policies
      where schemaname = 'public' and tablename in ('color_band', 'type_color_map') order by 1, 2`);
    expect(pol).toEqual([
      { tablename: "color_band", cmd: "SELECT" },
      { tablename: "type_color_map", cmd: "SELECT" },
    ]);
  });

  it("catalog_card: the mirror is readable by all, a stand-in only by its owner, and only its owner may create or edit one", async () => {
    db = await freshRpcDb();
    const pol = await rows<{ cmd: string; qual: string | null; with_check: string | null }>(`
      select cmd, qual, with_check from pg_policies
      where schemaname = 'public' and tablename = 'catalog_card' order by cmd`);
    expect(pol.map((p) => p.cmd)).toEqual(["INSERT", "SELECT", "UPDATE"]);
    const [ins, sel, upd] = pol;
    expect(sel.qual).toMatch(/owner_id IS NULL/);
    expect(sel.qual).toMatch(/owner_id = auth\.uid\(\)/);
    expect(ins.with_check).toMatch(/owner_id = auth\.uid\(\)/);
    expect(upd.qual).toMatch(/owner_id = auth\.uid\(\)/);
    expect(upd.with_check).toMatch(/owner_id = auth\.uid\(\)/);
  });

  it("every public view runs as the caller (security_invoker), binder_section by name", async () => {
    db = await freshRpcDb();
    const views = await rows<{ relname: string; invoker: boolean }>(`
      select c.relname, coalesce('security_invoker=on' = any(c.reloptions), false)
        or coalesce('security_invoker=true' = any(c.reloptions), false) as invoker
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'v' order by 1`);
    expect(views.map((v) => v.relname)).toContain("binder_section");
    expect(views.filter((v) => !v.invoker)).toEqual([]);
  });

  it("no function in public is SECURITY DEFINER (none is on a reviewed list today)", async () => {
    db = await freshRpcDb();
    const REVIEWED: string[] = [];
    const definers = await rows<{ proname: string }>(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef order by 1`);
    expect(definers.map((d) => d.proname).filter((n) => !REVIEWED.includes(n))).toEqual([]);
  });
});
