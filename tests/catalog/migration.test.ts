/**
 * Fresh-DB verification for M2's migration (dev-spec §5 DoD: "migration applies cleanly to a fresh
 * DB"). Runs a REAL Postgres via PGlite (WASM — no Docker, hermetic, works in CI) so the merge gate
 * proves 0004 applies on top of the frozen 0001+0002 and that the catalog upsert is idempotent at
 * the SQL level (the acceptance: "re-runs without duplicating rows").
 *
 * PGlite is vanilla Postgres, so it lacks the Supabase-provided `auth.uid()` and the anon/
 * authenticated/service_role roles that 0002's RLS references. We shim exactly those (as
 * `supabase db reset` does) BEFORE applying the migrations — never editing the frozen files.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { beforeAll, describe, expect, it } from "vitest";

const MIGRATIONS = ["0001_init.sql", "0002_domain.sql", "0004_catalog_artwork.sql"];

const SUPABASE_SHIMS = `
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  do $$ begin
    if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
    if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
    if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  end $$;
`;

function migrationSql(file: string): string {
  return readFileSync(path.join(process.cwd(), "supabase", "migrations", file), "utf8");
}

async function freshDb(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_SHIMS);
  for (const f of MIGRATIONS) await db.exec(migrationSql(f));
  return db;
}

describe("0004_catalog_artwork migration (fresh Postgres via PGlite)", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
  }, 30_000);

  it("applies on top of 0001+0002 and adds the artwork columns", async () => {
    const cols = await db.query<{
      column_name: string;
      data_type: string;
      column_default: string | null;
    }>(
      `select column_name, data_type, column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'catalog_card'
         and column_name in ('artwork_hash', 'artwork_group_locked')
       order by column_name`,
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual(["artwork_group_locked", "artwork_hash"]);
    const locked = cols.rows.find((r) => r.column_name === "artwork_group_locked")!;
    expect(locked.data_type).toBe("boolean");
    expect(locked.column_default).toMatch(/false/);
  });

  it("indexes the raw hash so a re-cluster does not table-scan", async () => {
    const idx = await db.query(
      `select 1 from pg_indexes where schemaname='public' and indexname='catalog_card_artwork_hash_idx'`,
    );
    expect(idx.rows).toHaveLength(1);
  });

  it("new columns default correctly (locked=false, hash=null) on insert", async () => {
    await db.exec(
      `insert into catalog_card (tcgdex_id, name) values ('mig-defaults-1', 'Pikachu')`,
    );
    const r = await db.query<{ artwork_group_locked: boolean; artwork_hash: string | null }>(
      `select artwork_group_locked, artwork_hash from catalog_card where tcgdex_id = 'mig-defaults-1'`,
    );
    expect(r.rows[0]).toEqual({ artwork_group_locked: false, artwork_hash: null });
  });

  it("upsert on tcgdex_id is idempotent — re-running does not duplicate the row", async () => {
    const upsert = `insert into catalog_card (tcgdex_id, name, artwork_hash)
      values ('sv03-027', 'Charmeleon', 'abcdef0123456789')
      on conflict (tcgdex_id) do update set name = excluded.name, artwork_hash = excluded.artwork_hash`;
    await db.exec(upsert);
    await db.exec(upsert);
    const count = await db.query<{ n: number }>(
      `select count(*)::int as n from catalog_card where tcgdex_id = 'sv03-027'`,
    );
    expect(count.rows[0].n).toBe(1);
  });

  it("is additive and re-runnable (0004 uses IF NOT EXISTS)", async () => {
    await expect(db.exec(migrationSql("0004_catalog_artwork.sql"))).resolves.not.toThrow();
  });
});
