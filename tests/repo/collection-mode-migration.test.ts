/**
 * Fresh-DB verification for 0005_collection_mode (dev-spec §4 DoD: "migration applies cleanly to a
 * fresh DB"). Runs a REAL Postgres via PGlite (WASM — no Docker, hermetic, works in CI), mirroring
 * tests/catalog/migration.test.ts. Proves 0005 applies on top of the frozen 0001–0004, adds the
 * `mode` column with the right shape, backfills the legacy `status='finite'` overload onto `mode`
 * (freeing `status` back to 'active'), and is safe to re-run.
 *
 * PGlite is vanilla Postgres, so it lacks Supabase's `auth.uid()` and the anon/authenticated/
 * service_role roles that 0002's RLS references. We shim exactly those BEFORE applying migrations,
 * never editing the frozen files. `collection.owner_id` defaults to `auth.uid()` (null here), so
 * every insert passes an explicit owner_id.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { beforeAll, describe, expect, it } from "vitest";

// The full frozen chain up to (but not including) the migration under test.
const PRE_MIGRATIONS = [
  "0001_init.sql",
  "0002_domain.sql",
  "0003_config.sql",
  "0004_catalog_artwork.sql",
];
const MIGRATION = "0005_collection_mode.sql";

const OWNER = "00000000-0000-0000-0000-000000000001";

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

/** Apply 0001–0004, seed the legacy state (mode carried on `status`), THEN apply 0005. */
async function migratedDb(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_SHIMS);
  for (const f of PRE_MIGRATIONS) await db.exec(migrationSql(f));

  // Legacy rows as M8 wrote them: a finite collection encoded as status='finite', and an open one
  // left at the default status='active'.
  await db.exec(`
    insert into collection (owner_id, name, status) values
      ('${OWNER}', 'Matsuno set', 'finite'),
      ('${OWNER}', 'Charizard hoard', 'active');
  `);

  await db.exec(migrationSql(MIGRATION));
  return db;
}

describe("0005_collection_mode migration (fresh Postgres via PGlite)", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await migratedDb();
  }, 30_000);

  it("adds a NOT NULL `mode text` column defaulting to 'open'", async () => {
    const cols = await db.query<{
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `select data_type, is_nullable, column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'collection' and column_name = 'mode'`,
    );
    expect(cols.rows).toHaveLength(1);
    expect(cols.rows[0].data_type).toBe("text");
    expect(cols.rows[0].is_nullable).toBe("NO");
    expect(cols.rows[0].column_default).toMatch(/open/);
  });

  it("backfills mode='finite' and frees status back to 'active' for the legacy finite row", async () => {
    const r = await db.query<{ status: string; mode: string }>(
      `select status, mode from collection where name = 'Matsuno set'`,
    );
    expect(r.rows[0]).toEqual({ status: "active", mode: "finite" });
  });

  it("leaves a legacy open (status='active') row as mode='open', status untouched", async () => {
    const r = await db.query<{ status: string; mode: string }>(
      `select status, mode from collection where name = 'Charizard hoard'`,
    );
    expect(r.rows[0]).toEqual({ status: "active", mode: "open" });
  });

  it("defaults a freshly-inserted collection to mode='open'", async () => {
    await db.exec(`insert into collection (owner_id, name) values ('${OWNER}', 'Brand new')`);
    const r = await db.query<{ mode: string }>(
      `select mode from collection where name = 'Brand new'`,
    );
    expect(r.rows[0].mode).toBe("open");
  });

  it("enforces the check constraint — an out-of-range mode is rejected", async () => {
    await expect(
      db.exec(`insert into collection (owner_id, name, mode) values ('${OWNER}', 'Bad', 'archived')`),
    ).rejects.toThrow();
  });

  it("round-trips a finite collection through the mode column", async () => {
    await db.exec(
      `insert into collection (owner_id, name, mode) values ('${OWNER}', 'Chased set', 'finite')`,
    );
    const r = await db.query<{ mode: string }>(
      `select mode from collection where name = 'Chased set'`,
    );
    expect(r.rows[0].mode).toBe("finite");
  });

  it("is additive and re-runnable (IF NOT EXISTS + idempotent backfill)", async () => {
    await expect(db.exec(migrationSql(MIGRATION))).resolves.not.toThrow();
    // The re-run must NOT flip the already-migrated finite row back (its status is 'active' now).
    const r = await db.query<{ status: string; mode: string }>(
      `select status, mode from collection where name = 'Matsuno set'`,
    );
    expect(r.rows[0]).toEqual({ status: "active", mode: "finite" });
  });
});
