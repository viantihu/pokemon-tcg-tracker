/**
 * UIL-052 — migration 0011's backfill, checked in isolation from the trigger tests.
 *
 * `add column updated_at ... default now()` alone would give EVERY pre-existing collection the SAME
 * single timestamp: a volatile default like `now()` is evaluated once per statement, not once per
 * row. That would falsely claim all of her collections were "just modified" the moment this migration
 * ships — a lie she'd see immediately on the sorted list. So the migration backfills from `created_at`
 * instead (see its own comment) before setting the default/not-null for future rows.
 *
 * This needs rows that exist BEFORE 0011 runs, which `freshRpcDb()` can't produce — it applies the
 * whole fixed migration list up front. So this applies 0001–0010 itself, seeds collections with
 * DELIBERATELY staggered `created_at` values (so a bug that backfills a uniform value, rather than
 * each row's own prior, would be caught), then applies 0011 and asserts the exact falsifiable
 * expectations the Tech Lead's baseline read against Testing also checks: column present, zero NULLs,
 * every pre-existing row's `updated_at` equal to ITS OWN `created_at`, row count unchanged.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const OWNER = "00000000-0000-0000-0000-000000000001";

const PRE_0011_MIGRATIONS = [
  "0001_init.sql",
  "0002_domain.sql",
  "0003_config.sql",
  "0004_catalog_artwork.sql",
  "0005_collection_mode.sql",
  "0006_commit_rpc.sql",
  "0007_backfill_ops.sql",
  "0008_collection_removal_ops.sql",
  "0009_set_metadata.sql",
  "0010_release_stale_line_slots.sql",
];

function migrationSql(file: string): string {
  return readFileSync(path.join(process.cwd(), "supabase", "migrations", file), "utf8");
}

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

let db: PGlite;
beforeEach(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_SHIMS);
  for (const f of PRE_0011_MIGRATIONS) await db.exec(migrationSql(f));
});
afterEach(async () => {
  await db.close();
});

describe("migration 0011 backfills updated_at from created_at, not a uniform now()", () => {
  it("preserves each pre-existing row's OWN created_at, leaves none NULL, changes no row count", async () => {
    const A = "a0000000-0000-0000-0000-0000000000d1";
    const B = "a0000000-0000-0000-0000-0000000000d2";
    const C = "a0000000-0000-0000-0000-0000000000d3";
    await db.query(
      `insert into collection (id, owner_id, name, created_at)
       values ($1, $4, 'Oldest', now() - interval '3 days'),
              ($2, $4, 'Middle', now() - interval '2 days'),
              ($3, $4, 'Newest', now() - interval '1 day')`,
      [A, B, C, OWNER],
    );

    const before = (await db.query<{ n: number }>(`select count(*)::int n from collection`)).rows[0]
      .n;

    // Migration 0011 itself — the exact file that will ship.
    await db.exec(migrationSql("0011_collection_updated_at.sql"));

    const rows = (
      await db.query<{ id: string; created_at: string; updated_at: string | null }>(
        `select id, created_at, updated_at from collection order by created_at`,
      )
    ).rows;

    expect(rows).toHaveLength(before);
    expect(rows.map((r) => r.id)).toEqual([A, B, C]);
    for (const r of rows) {
      expect(r.updated_at).not.toBeNull();
      expect(new Date(r.updated_at!).getTime()).toBe(new Date(r.created_at).getTime());
    }
    // The falsifier this test exists to catch: a uniform backfill would make every row's
    // updated_at IDENTICAL despite their created_at values being three days apart.
    const distinctUpdatedAt = new Set(rows.map((r) => r.updated_at));
    expect(distinctUpdatedAt.size).toBe(3);
  });

  it("a NEW row after 0011 still defaults updated_at to insert time, not created_at's old rule", async () => {
    await db.exec(migrationSql("0011_collection_updated_at.sql"));
    const id = "a0000000-0000-0000-0000-0000000000d4";
    await db.query(`insert into collection (id, owner_id, name) values ($1, $2, 'Fresh')`, [
      id,
      OWNER,
    ]);
    const row = (
      await db.query<{ created_at: string; updated_at: string }>(
        `select created_at, updated_at from collection where id = $1`,
        [id],
      )
    ).rows[0];
    expect(row.updated_at).not.toBeNull();
    // Both default to "now" at insert time, so they're expected to agree here too — the point of
    // this test is that the column now HAS a working default at all, not that it differs.
    expect(new Date(row.updated_at).getTime()).toBe(new Date(row.created_at).getTime());
  });
});
