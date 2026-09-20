/**
 * UIL-047 / migration 0016 — the catalog learns a locale, without moving a single existing row or alias.
 *
 * Applied the way a live database will see it: every migration through 0015, then DATA that exists on
 * Testing today (English cards, Karvi's cross-locale alias ja:m6 → swshp), then 0016. What is pinned:
 * existing rows read locale 'en' with no backfill; the alias survives byte for byte (the Senior BA's rule:
 * no automatic rewrite, she re-teaches with Forget if she wants a Japanese target); the check constraint
 * ties the `ja:` namespace to the locale both ways; the (locale, set_id, local_id) index replaces the old
 * one; a `user:` stand-in (0015) is an 'en' row and passes.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DIR = path.join(process.cwd(), "supabase", "migrations");
const ALL = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const BEFORE = ALL.filter((f) => f < "0016_");
const M0016 = ALL.find((f) => f.startsWith("0016_"))!;

const SHIMS = `
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  do $$ begin
    if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
    if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
    if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  end $$;
  create schema if not exists supabase_migrations;
  create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
`;

let db: PGlite;
beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SHIMS);
  for (const f of BEFORE) await db.exec(readFileSync(path.join(DIR, f), "utf8"));
  // Testing's shape today: English cards, and her cross-locale pin.
  await db.exec(`
    insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id) values
      ('swshp-001', 'Promo', 'swshp', 'SWSH Promos', '001'),
      ('neo1-1', 'Chikorita', 'neo1', 'Neo Genesis', '1');
    insert into catalog_card (tcgdex_id, name, source) values ('user:11111111-1111-4111-8111-111111111111', 'Mine', 'user');
    insert into set_alias (locale, dex_code, tcgdex_set_id, source) values ('ja', 'm6', 'swshp', 'manual');
  `);
  await db.exec(readFileSync(path.join(DIR, M0016), "utf8"));
});
afterAll(async () => {
  await db.close();
});

describe("0016 · locale on catalog_card", () => {
  it("every existing row reads 'en' — no backfill needed, none done", async () => {
    const r = await db.query<{ tcgdex_id: string; locale: string }>(
      `select tcgdex_id, locale from catalog_card order by 1`,
    );
    expect(r.rows).toEqual([
      { tcgdex_id: "neo1-1", locale: "en" },
      { tcgdex_id: "swshp-001", locale: "en" },
      { tcgdex_id: "user:11111111-1111-4111-8111-111111111111", locale: "en" },
    ]);
  });

  it("a pre-existing ja → en alias survives 0016 untouched (her ja:m6 → swshp pin)", async () => {
    const r = await db.query(`select locale, dex_code, tcgdex_set_id, source from set_alias`);
    expect(r.rows).toEqual([
      { locale: "ja", dex_code: "m6", tcgdex_set_id: "swshp", source: "manual" },
    ]);
  });

  it("the namespace and the locale agree both ways; the four shared Neo set ids can coexist", async () => {
    await db.query(
      `insert into catalog_card (tcgdex_id, name, set_id, local_id, locale) values ('ja:neo1-001', 'チコリータ', 'ja:neo1', '001', 'ja')`,
    );
    await expect(
      db.query(`insert into catalog_card (tcgdex_id, name, locale) values ('neo2-5', 'x', 'ja')`),
    ).rejects.toThrow(/catalog_card_locale_namespace/);
    await expect(
      db.query(`insert into catalog_card (tcgdex_id, name) values ('ja:neo2-005', 'x')`),
    ).rejects.toThrow(/catalog_card_locale_namespace/);
    await expect(
      db.query(`insert into catalog_card (tcgdex_id, name, locale) values ('neo2-5', 'x', 'fr')`),
    ).rejects.toThrow(/locale/);
    const both = await db.query<{ tcgdex_id: string; set_id: string; locale: string }>(
      `select tcgdex_id, set_id, locale from catalog_card where set_id in ('neo1', 'ja:neo1') order by 1`,
    );
    expect(both.rows).toEqual([
      { tcgdex_id: "ja:neo1-001", set_id: "ja:neo1", locale: "ja" },
      { tcgdex_id: "neo1-1", set_id: "neo1", locale: "en" },
    ]);
  });

  it("the (locale, set_id, local_id) index replaces the old (set_id, local_id) one", async () => {
    const idx = await db.query<{ indexname: string }>(
      `select indexname from pg_indexes where tablename = 'catalog_card' order by 1`,
    );
    const names = idx.rows.map((r) => r.indexname);
    expect(names).toContain("catalog_card_locale_set_local_idx");
    expect(names).not.toContain("catalog_card_set_local_idx");
  });
});
