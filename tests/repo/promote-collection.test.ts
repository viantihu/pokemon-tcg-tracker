/**
 * Verification for scripts/promote-collection.mjs — the one-shot Testing -> Production
 * data promotion at go-live.
 *
 * This script runs exactly once, against the real collection, and a silent failure is
 * indistinguishable from success until the production app renders an empty binder. So
 * it gets the same treatment as a migration: two REAL Postgres databases via PGlite
 * (WASM, no Docker — the project's standing pattern, see tests/support/pglite-rpc.ts),
 * both built from EVERY migration on disk, one seeded as "Testing" and one virgin as
 * "Production".
 *
 * The four things that actually matter, and are asserted below:
 *   1. owner_id is remapped to the PRODUCTION uuid. Nothing enforces this at the
 *      database level (owner_id has no FK to auth.users), so a wrong uuid inserts
 *      cleanly and is then hidden forever by the `owner_all` RLS policy.
 *   2. The circular copy <-> line_slot reference survives the two-pass insert.
 *   3. Excluded tables stay excluded (0003's config is not duplicated; the stale
 *      last_sync_snapshot does not follow the collection into production).
 *   4. Preflight refuses, having written nothing, on schema drift / a missing
 *      production user / a non-empty production / an ambiguous source owner.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { beforeEach, describe, expect, it } from "vitest";
import { promoteCollection, PromotionError } from "@/scripts/promote-collection.mjs";

/**
 * EVERY migration on disk, in order — not a hand-kept list. The list used to stop at 0007 (the frozen
 * set when this file was written), which meant the promotion was being proven against a schema six
 * versions behind what Testing and Production actually run: tables and columns added since (0009's set
 * metadata, 0012's `collection.updated_at` + trigger, 0013's `line_slot` marker columns) were never
 * copied under test. Reading the directory is the fix that cannot go stale again (UIL-029's lesson).
 */
const MIGRATIONS = readdirSync(path.join(process.cwd(), "supabase", "migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort();

const TESTING_OWNER = "11111111-1111-1111-1111-111111111111";
const SEED_OWNER = "00000000-0000-0000-0000-000000000001";
const PROD_OWNER = "22222222-2222-2222-2222-222222222222";
const PROD_EMAIL = "owner@example.com";

/**
 * Supabase platform surface PGlite lacks. `auth.uid()` + the three roles mirror
 * tests/support/pglite-rpc.ts; `supabase_migrations.schema_migrations` and `auth.users`
 * are created by the Supabase CLI / GoTrue rather than by a migration, and the
 * promotion script reads both.
 */
const SUPABASE_SHIMS = `
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create table if not exists auth.users (id uuid primary key, email text);
  create schema if not exists supabase_migrations;
  create table if not exists supabase_migrations.schema_migrations (version text primary key);
  do $$ begin
    if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
    if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
    if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  end $$;
`;

function migrationSql(file: string): string {
  return readFileSync(path.join(process.cwd(), "supabase", "migrations", file), "utf8");
}

/** A database at the full migration set (or a prefix) with the platform shims, recording its own migration history. */
async function freshDb(migrations: string[] = MIGRATIONS): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_SHIMS);
  for (const file of migrations) {
    await db.exec(migrationSql(file));
    await db.query(`insert into supabase_migrations.schema_migrations (version) values ($1)`, [
      file.split("_")[0],
    ]);
  }
  await db.exec(`
    grant usage on schema public to authenticated, service_role, anon;
    grant all on all tables in schema public to authenticated, service_role;
  `);
  return db;
}

/** Ids fixed up front so the test can assert they survive the promotion verbatim. */
const IDS = {
  haul: "aaaaaaa1-0000-4000-8000-000000000001",
  binder: "aaaaaaa2-0000-4000-8000-000000000001",
  collection: "aaaaaaa3-0000-4000-8000-000000000001",
  presenceGroup: "aaaaaaa4-0000-4000-8000-000000000001",
  line: "aaaaaaa5-0000-4000-8000-000000000001",
  copyShelved: "aaaaaaa6-0000-4000-8000-000000000001",
  copyBulk: "aaaaaaa6-0000-4000-8000-000000000002",
  slotFilled: "aaaaaaa7-0000-4000-8000-000000000001",
  slotPlaceholder: "aaaaaaa7-0000-4000-8000-000000000002",
  wishlist: "aaaaaaa8-0000-4000-8000-000000000001",
  block: "aaaaaaa9-0000-4000-8000-000000000001",
  decision: "aaaaaab1-0000-4000-8000-000000000001",
  unresolved: "aaaaaab2-0000-4000-8000-000000000001",
  snapshot: "aaaaaab3-0000-4000-8000-000000000001",
};

/**
 * A miniature but structurally complete collection, owned by `owner`. Real card ids
 * (the standing rule: verified TCGdex ids only — these three are the ones
 * supabase/seed.sql verified on 2026-09-07). Exercises every shape that could break in
 * transit: text[], integer[], uuid[], jsonb, a date, and the circular copy <-> slot pair.
 */
async function seedCollection(db: PGlite, owner: string): Promise<void> {
  await db.query(
    `insert into catalog_card (tcgdex_id, name, dex_id, set_id, local_id, types, stage, variants, artwork_hash, price_market)
     values ('sv03-026', 'Charmander', '{4}', 'sv03', '026', '{Fire}', 'Basic', '{"normal":true,"holo":false}'::jsonb, 'ab12cd34', 1.25),
            ('sv03-027', 'Charmeleon', '{5}', 'sv03', '027', '{Fire}', 'Stage1', '{"normal":true}'::jsonb, 'ef56ab78', 2.50),
            ('sv01-084', 'Ralts', '{280}', 'sv01', '084', '{Psychic}', 'Basic', '{"normal":true}'::jsonb, null, null)`,
  );
  await db.query(
    `insert into set_alias (locale, dex_code, tcgdex_set_id, source) values ('en', 'OBF', 'sv03', 'manual')`,
  );

  await db.query(
    `insert into haul (id, owner_id, date, source, notes) values ($1, $2, '2026-08-14', 'bulk-bin', 'first real haul')`,
    [IDS.haul, owner],
  );
  await db.query(
    `insert into binder (id, owner_id, name, type, pages, pockets_per_page, back_half_start_page, is_active)
     values ($1, $2, 'General 1', 'general', 40, 9, 21, true)`,
    [IDS.binder, owner],
  );
  await db.query(
    `insert into collection (id, owner_id, name, current_binder_ids, target_catalog_card_ids, mode)
     values ($1, $2, 'Kanto starters', $3, $4, 'finite')`,
    [IDS.collection, owner, [IDS.binder], ["sv03-026", "sv03-027"]],
  );
  await db.query(
    `insert into presence_group (id, owner_id, catalog_card_id, dex_variant_raw, desired_count)
     values ($1, $2, 'sv03-026', 'Reverse Holo', 2)`,
    [IDS.presenceGroup, owner],
  );
  await db.query(
    `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id)
     values ($1, $2, 4, 'red', $3)`,
    [IDS.line, owner, IDS.binder],
  );

  // copy.line_slot_id is filled here, which is exactly the circular reference the
  // promotion has to reconstruct in two passes.
  await db.query(
    `insert into copy (id, owner_id, catalog_card_id, variant, dex_variant_raw, presence_group_id, haul_id, role, binder_id, binder_half, color_band)
     values ($1, $2, 'sv03-026', 'reverse', 'Reverse Holo', $3, $4, 'shelved', $5, 'back', 'red')`,
    [IDS.copyShelved, owner, IDS.presenceGroup, IDS.haul, IDS.binder],
  );
  await db.query(
    `insert into copy (id, owner_id, catalog_card_id, haul_id, role) values ($1, $2, 'sv01-084', $3, 'bulk')`,
    [IDS.copyBulk, owner, IDS.haul],
  );
  await db.query(
    `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
     values ($1, $2, $3, 0, 'Basic', 'filled', $4)`,
    [IDS.slotFilled, owner, IDS.line, IDS.copyShelved],
  );
  await db.query(
    `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, target_catalog_card_id)
     values ($1, $2, $3, 1, 'Stage1', 'placeholder', 'sv03-027')`,
    [IDS.slotPlaceholder, owner, IDS.line],
  );
  await db.query(`update copy set line_slot_id = $1 where id = $2`, [
    IDS.slotFilled,
    IDS.copyShelved,
  ]);

  await db.query(
    `insert into wishlist_item (id, owner_id, line_slot_id, required_dex_id, chosen_catalog_card_id, alternate_catalog_card_ids, held_for_binder_id)
     values ($1, $2, $3, 5, 'sv03-027', $4, $5)`,
    [IDS.wishlist, owner, IDS.slotPlaceholder, ["sv01-084"], IDS.binder],
  );
  await db.query(
    `insert into binder_block (id, owner_id, binder_id, half, pocket_count, purpose, material, copy_id, line_id)
     values ($1, $2, $3, 'back', 3, 'line-terminated', 'repurposedDuplicate', $4, $5)`,
    [IDS.block, owner, IDS.binder, IDS.copyBulk, IDS.line],
  );
  await db.query(
    `insert into placement_decision (id, owner_id, haul_id, copy_id, decision, reason, resolved_by)
     values ($1, $2, $3, $4, 'shelved:back', 'line member', 'auto')`,
    [IDS.decision, owner, IDS.haul, IDS.copyShelved],
  );
  await db.query(
    `insert into unresolved_entry (id, owner_id, dex_id, dex_variant_raw, quantity, reason)
     values ($1, $2, 'me6-14', 'Normal', 3, 'UNKNOWN_SET')`,
    [IDS.unresolved, owner],
  );
  // Excluded on purpose: stale undo state must not follow the collection to production.
  await db.query(
    `insert into last_sync_snapshot (id, owner_id, snapshot) values ($1, $2, '{"ops":[]}'::jsonb)`,
    [IDS.snapshot, owner],
  );
}

/** `select` helper that keeps the assertions readable. */
async function one<T>(db: PGlite, sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await db.query<T>(sql, params);
  return rows[0];
}

async function count(db: PGlite, table: string): Promise<number> {
  const row = await one<{ n: number }>(db, `select count(*)::int as n from ${table}`);
  return Number(row.n);
}

describe("promote-collection: Testing -> Production", () => {
  let source: PGlite;
  let target: PGlite;

  beforeEach(async () => {
    [source, target] = await Promise.all([freshDb(), freshDb()]);
    await seedCollection(source, TESTING_OWNER);
    await target.query(`insert into auth.users (id, email) values ($1, $2)`, [
      PROD_OWNER,
      PROD_EMAIL,
    ]);
  });

  it("moves the whole collection and remaps every owner_id to the production user", async () => {
    const report = await promoteCollection({
      source,
      target,
      ownerEmail: PROD_EMAIL,
    });

    expect(report.written).toBe(true);
    expect(report.sourceOwner).toBe(TESTING_OWNER);
    expect(report.targetOwner).toBe(PROD_OWNER);

    // The remap: nothing at all is left owned by the Testing uuid.
    for (const table of [
      "haul",
      "binder",
      "collection",
      "presence_group",
      "evolution_line",
      "copy",
      "line_slot",
      "wishlist_item",
      "binder_block",
      "placement_decision",
      "unresolved_entry",
    ]) {
      const stale = await one<{ n: number }>(
        target,
        `select count(*)::int as n from ${table} where owner_id <> $1`,
        [PROD_OWNER],
      );
      expect(Number(stale.n), `${table} has rows not owned by the production user`).toBe(0);
    }

    // Row-for-row, both sides agree.
    for (const table of ["haul", "binder", "collection", "copy", "line_slot", "wishlist_item"]) {
      expect(await count(target, table), table).toBe(await count(source, table));
    }
  });

  it("reconstructs the circular copy <-> line_slot reference", async () => {
    await promoteCollection({ source, target, ownerEmail: PROD_EMAIL });

    const copy = await one<{ line_slot_id: string | null }>(
      target,
      `select line_slot_id from copy where id = $1`,
      [IDS.copyShelved],
    );
    expect(copy.line_slot_id).toBe(IDS.slotFilled);

    const slot = await one<{ copy_id: string | null }>(
      target,
      `select copy_id from line_slot where id = $1`,
      [IDS.slotFilled],
    );
    expect(slot.copy_id).toBe(IDS.copyShelved);

    // The bulk copy never had a slot; it must not have acquired one.
    const bulk = await one<{ line_slot_id: string | null }>(
      target,
      `select line_slot_id from copy where id = $1`,
      [IDS.copyBulk],
    );
    expect(bulk.line_slot_id).toBeNull();
  });

  it("carries array, jsonb and date columns across unchanged", async () => {
    await promoteCollection({ source, target, ownerEmail: PROD_EMAIL });

    const collection = await one<{
      current_binder_ids: string[];
      target_catalog_card_ids: string[];
    }>(target, `select current_binder_ids, target_catalog_card_ids from collection where id = $1`, [
      IDS.collection,
    ]);
    expect(collection.current_binder_ids).toEqual([IDS.binder]);
    expect(collection.target_catalog_card_ids).toEqual(["sv03-026", "sv03-027"]);

    const card = await one<{
      dex_id: number[];
      types: string[];
      variants: Record<string, boolean>;
    }>(target, `select dex_id, types, variants from catalog_card where tcgdex_id = 'sv03-026'`);
    expect(card.dex_id).toEqual([4]);
    expect(card.types).toEqual(["Fire"]);
    expect(card.variants).toEqual({ normal: true, holo: false });

    const wish = await one<{ alternate_catalog_card_ids: string[] }>(
      target,
      `select alternate_catalog_card_ids from wishlist_item where id = $1`,
      [IDS.wishlist],
    );
    expect(wish.alternate_catalog_card_ids).toEqual(["sv01-084"]);

    // A `date` must not drift by a day in transit.
    const sourceHaul = await one<{ date: unknown }>(source, `select date from haul where id = $1`, [
      IDS.haul,
    ]);
    const targetHaul = await one<{ date: unknown }>(target, `select date from haul where id = $1`, [
      IDS.haul,
    ]);
    expect(String(targetHaul.date)).toBe(String(sourceHaul.date));
  });

  it("leaves the collection visible under the production login's RLS", async () => {
    await promoteCollection({ source, target, ownerEmail: PROD_EMAIL });

    // Exactly the check that a naive dump silently fails: read as the authenticated
    // production user, with `owner_all` enforcing owner_id = auth.uid().
    await target.exec(`select set_config('request.jwt.claim.sub', '${PROD_OWNER}', false);`);
    await target.exec(`set role authenticated;`);
    expect(await count(target, "copy")).toBe(2);
    expect(await count(target, "binder")).toBe(1);
    expect(await count(target, "line_slot")).toBe(2);
    await target.exec(`reset role;`);
  });

  it("does not duplicate migration-owned config or carry the stale sync snapshot", async () => {
    const bandsBefore = await count(target, "color_band");
    await promoteCollection({ source, target, ownerEmail: PROD_EMAIL });

    // 0003 already put these in production; the promotion must not touch them.
    expect(await count(target, "color_band")).toBe(bandsBefore);
    expect(bandsBefore).toBe(10);
    expect(await count(target, "type_color_map")).toBe(await count(source, "type_color_map"));

    // Testing's undo state stays in Testing.
    expect(await count(source, "last_sync_snapshot")).toBe(1);
    expect(await count(target, "last_sync_snapshot")).toBe(0);
  });

  it("upserts the shared catalog over a partially-mirrored production", async () => {
    // Production's own mirror got as far as one card, with no artwork hash yet.
    await target.query(
      `insert into catalog_card (tcgdex_id, name, artwork_hash) values ('sv03-026', 'Charmander', null)`,
    );

    await promoteCollection({ source, target, ownerEmail: PROD_EMAIL });

    expect(await count(target, "catalog_card")).toBe(3);
    const card = await one<{ artwork_hash: string | null; price_market: string | null }>(
      target,
      `select artwork_hash, price_market from catalog_card where tcgdex_id = 'sv03-026'`,
    );
    expect(card.artwork_hash).toBe("ab12cd34");
    expect(Number(card.price_market)).toBe(1.25);
  });

  it("--dry-run reports the plan and writes nothing", async () => {
    const report = await promoteCollection({
      source,
      target,
      ownerEmail: PROD_EMAIL,
      dryRun: true,
    });

    expect(report.dryRun).toBe(true);
    expect(report.written).toBe(false);
    expect(report.counts.copy).toBe(2);
    expect(await count(target, "copy")).toBe(0);
    expect(await count(target, "catalog_card")).toBe(0);
  });
});

describe("promote-collection: preflight refusals", () => {
  let source: PGlite;
  let target: PGlite;

  beforeEach(async () => {
    [source, target] = await Promise.all([freshDb(), freshDb()]);
    await seedCollection(source, TESTING_OWNER);
    await target.query(`insert into auth.users (id, email) values ($1, $2)`, [
      PROD_OWNER,
      PROD_EMAIL,
    ]);
  });

  it("refuses when production's migration history is behind", async () => {
    const behind = await freshDb(MIGRATIONS.slice(0, 5));
    await behind.query(`insert into auth.users (id, email) values ($1, $2)`, [
      PROD_OWNER,
      PROD_EMAIL,
    ]);

    await expect(
      promoteCollection({ source, target: behind, ownerEmail: PROD_EMAIL }),
    ).rejects.toThrow(
      new RegExp(
        `migration histories differ[\\s\\S]*MISSING: ${MIGRATIONS.slice(5)
          .map((f) => f.split("_")[0])
          .join(", ")}`,
      ),
    );
    expect(await count(behind, "copy")).toBe(0);
  });

  it("refuses when the production user does not exist yet", async () => {
    await target.query(`delete from auth.users`);

    await expect(promoteCollection({ source, target, ownerEmail: PROD_EMAIL })).rejects.toThrow(
      /no production auth\.users row[\s\S]*Log into the production app once/,
    );
    expect(await count(target, "copy")).toBe(0);
  });

  it("refuses when no production owner is identifiable at all", async () => {
    await expect(promoteCollection({ source, target })).rejects.toThrow(
      /no production owner given/,
    );
  });

  it("refuses to run twice, because it would duplicate the collection", async () => {
    await promoteCollection({ source, target, ownerEmail: PROD_EMAIL });
    expect(await count(target, "copy")).toBe(2);

    await expect(promoteCollection({ source, target, ownerEmail: PROD_EMAIL })).rejects.toThrow(
      /already holds owner rows[\s\S]*not idempotent/,
    );
    expect(await count(target, "copy")).toBe(2);
  });

  it("refuses when Testing holds more than one owner, and accepts --source-owner", async () => {
    // Exactly what a `supabase db reset` leaves behind: seed rows beside the real ones.
    await source.query(
      `insert into haul (id, owner_id, source) values (gen_random_uuid(), $1, 'pack-rip')`,
      [SEED_OWNER],
    );

    await expect(promoteCollection({ source, target, ownerEmail: PROD_EMAIL })).rejects.toThrow(
      /rows for 2 owners[\s\S]*Pass --source-owner/,
    );
    expect(await count(target, "haul")).toBe(0);

    const report = await promoteCollection({
      source,
      target,
      ownerEmail: PROD_EMAIL,
      sourceOwner: TESTING_OWNER,
    });
    expect(report.written).toBe(true);
    // The seed owner's haul stayed behind.
    expect(await count(target, "haul")).toBe(1);
    expect(await count(source, "haul")).toBe(2);
  });

  it("refuses a --source-owner that owns nothing in Testing", async () => {
    await expect(
      promoteCollection({ source, target, ownerEmail: PROD_EMAIL, sourceOwner: SEED_OWNER }),
    ).rejects.toThrow(/owns no rows in Testing/);
  });

  it("refuses a --target-owner that is not a production user", async () => {
    await expect(
      promoteCollection({ source, target, targetOwner: "33333333-3333-3333-3333-333333333333" }),
    ).rejects.toThrow(/is not a user in production/);
  });

  it("refuses when production is missing a column Testing has", async () => {
    // Stands in for any hand-edit that drifted production away from the migrations.
    await target.exec(`alter table copy drop column dex_variant_raw`);

    await expect(promoteCollection({ source, target, ownerEmail: PROD_EMAIL })).rejects.toThrow(
      /Production's copy is missing column\(s\)[\s\S]*dex_variant_raw/,
    );
  });

  it("raises PromotionError, so the CLI prints a message rather than a stack", async () => {
    await target.query(`delete from auth.users`);
    await expect(
      promoteCollection({ source, target, ownerEmail: PROD_EMAIL }),
    ).rejects.toBeInstanceOf(PromotionError);
  });
});
