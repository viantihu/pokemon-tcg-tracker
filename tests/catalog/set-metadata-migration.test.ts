/**
 * Fresh-DB verification for 0009_set_metadata (UIL-026). Applies the FULL frozen chain 0001→0009 on a
 * real Postgres (PGlite — no Docker, hermetic) so the merge gate proves 0009 applies on top of
 * everything before it, that the two columns land with the right types, and that they are NULLABLE
 * (existing rows carry NULL until the mirror repopulates — the migration must not demand a value it
 * cannot supply). Same PGlite + Supabase-shim approach as migration.test.ts; frozen files untouched.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { beforeAll, describe, expect, it } from "vitest";

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

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");

/** Every migration in filename order — the order Supabase applies them. */
function orderedMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

async function freshDb(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_SHIMS);
  for (const f of orderedMigrations()) {
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"));
  }
  return db;
}

describe("0009_set_metadata migration (fresh Postgres via PGlite)", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
  }, 30_000);

  it("includes 0009 in the ordered chain and it sorts last", () => {
    const files = orderedMigrations();
    expect(files).toContain("0009_set_metadata.sql");
    expect(files[files.length - 1]).toBe("0009_set_metadata.sql");
  });

  it("adds set_card_count_official (integer) and set_release_date (date), both nullable", async () => {
    const { rows } = await db.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `select column_name, data_type, is_nullable
         from information_schema.columns
        where table_name = 'catalog_card'
          and column_name in ('set_card_count_official', 'set_release_date')
        order by column_name`,
    );
    expect(rows).toEqual([
      { column_name: "set_card_count_official", data_type: "integer", is_nullable: "YES" },
      { column_name: "set_release_date", data_type: "date", is_nullable: "YES" },
    ]);
  });

  it("round-trips a row with both values set", async () => {
    await db.exec(`
      insert into catalog_card (tcgdex_id, name, set_card_count_official, set_release_date)
      values ('sv04-099', 'Minior', 182, '2023-11-03');
    `);
    // Format the date in SQL rather than reading it back as a JS Date: PGlite parses a `date` into a
    // local-timezone Date, which shifts the calendar day west of UTC. `to_char` compares the stored
    // value itself, not its rendering in the runner's timezone.
    const { rows } = await db.query<{
      set_card_count_official: number;
      release: string;
    }>(
      `select set_card_count_official, to_char(set_release_date, 'YYYY-MM-DD') as release
         from catalog_card where tcgdex_id = 'sv04-099'`,
    );
    expect(rows[0].set_card_count_official).toBe(182);
    expect(rows[0].release).toBe("2023-11-03");
  });

  it("accepts a row that omits both (NULL), the state every pre-mirror row is in", async () => {
    await db.exec(`insert into catalog_card (tcgdex_id, name) values ('base1-004', 'Charizard');`);
    const { rows } = await db.query<{
      set_card_count_official: number | null;
      set_release_date: string | null;
    }>(
      `select set_card_count_official, set_release_date from catalog_card where tcgdex_id = 'base1-004'`,
    );
    expect(rows[0].set_card_count_official).toBeNull();
    expect(rows[0].set_release_date).toBeNull();
  });
});
