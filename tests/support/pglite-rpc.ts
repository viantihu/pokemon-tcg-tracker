/**
 * Shared PGlite harness for the M10 `apply_write_ops` atomicity tests (dev-spec §4 DoD: migrations
 * apply to a fresh DB; §5 M10: commits are truly atomic). Runs REAL Postgres/plpgsql in WASM (no
 * Docker), applying the migrations listed below in order, then replicating the platform grants and
 * `auth.uid()` shim Supabase provides so the SECURITY INVOKER function runs under the authenticated
 * owner's RLS — exactly as production does. Never edits a migration file.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import type { CatalogCard, Variant } from "@/lib/engine";
import type { DraftItem } from "@/lib/plan/context";
import type { WritePayload } from "@/lib/repo";

export const OWNER = "00000000-0000-0000-0000-000000000001";

export const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");

/**
 * EVERY migration on disk, in filename order — read, not listed. The hand-kept list this replaced ran
 * one, then two, then six versions behind what actually ships (UIL-029's fourth harness-fidelity fault
 * and its successors), and each time a PGlite test was passing against a schema production no longer
 * had. `freshRpcDb` records each applied version in the same `supabase_migrations.schema_migrations`
 * table the Supabase CLI writes, so tests/support/harness-applies-every-migration.test.ts can prove the
 * applied set equals the directory rather than trusting this constant.
 */
export const MIGRATIONS: readonly string[] = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

// Supabase provides auth.uid() + the anon/authenticated/service_role roles; PGlite (vanilla PG) does
// not, so we shim exactly those before applying the migrations (never editing the frozen files).
const SUPABASE_SHIMS = `
  create schema if not exists auth;
  create schema if not exists supabase_migrations;
  create table if not exists supabase_migrations.schema_migrations (version text primary key);
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
  return readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
}

/**
 * Fresh DB with `MIGRATIONS` applied, platform grants replicated. Ends as the bootstrap superuser.
 *
 * `before` stops short of a version (e.g. "0025"), so a migration's BACKFILL can be tested against rows
 * seeded under the schema it upgrades; finish with `applyMigration`. Absent, every migration is applied.
 */
export async function freshRpcDb(options: { before?: string } = {}): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_SHIMS);
  for (const f of MIGRATIONS) {
    if (options.before && f.split("_")[0] >= options.before) break;
    await db.exec(migrationSql(f));
    await db.query(`insert into supabase_migrations.schema_migrations (version) values ($1)`, [
      f.split("_")[0],
    ]);
  }
  // Supabase grants base-table privileges to these roles as a platform default; RLS is the security
  // boundary on top. Replicate it so `set role authenticated` can write through the RPC.
  await db.exec(`
    grant usage on schema public to authenticated, service_role, anon;
    grant all on all tables in schema public to authenticated, service_role;
  `);
  await db.exec(FIXTURE_AUTOGROUP);
  return db;
}

/**
 * FIXTURE SEEDING ONLY: a copy the bootstrap SUPERUSER inserts with no presence group gets one, keyed like an
 * import would key it (owner, card, Dex variant — `'Normal'` when the fixture names none). UIL-098 part 4.
 *
 * Why: 0023 makes `copy.presence_group_id` NOT NULL, because every real copy comes from a Dex import or a
 * Sync-page match and carries its group. Fixtures written before 0023 seed "a copy she already has" without
 * one; this gives them the group their real counterpart would have, instead of hand-editing every seed.
 *
 * Why it cannot hide an app bug: it fires ONLY for a superuser. App code runs as `authenticated` (the owner,
 * via `asOwner`), exactly as in production, and gets no help — an app path that writes an ungrouped copy
 * still fails on 0023's NOT NULL. tests/copy/copy-group-required.test.ts pins both halves.
 */
const FIXTURE_AUTOGROUP = `
  create or replace function test_fixture_autogroup() returns trigger language plpgsql as $$
  begin
    if new.presence_group_id is null
       and (select rolsuper from pg_roles where rolname = current_user) then
      insert into presence_group (owner_id, catalog_card_id, dex_variant_raw, desired_count)
        values (new.owner_id, new.catalog_card_id, coalesce(new.dex_variant_raw, 'Normal'), 0)
        on conflict (owner_id, catalog_card_id, dex_variant_raw) do update
          set desired_count = presence_group.desired_count
        returning id into new.presence_group_id;
    end if;
    return new;
  end $$;
  create trigger test_fixture_autogroup before insert on copy
    for each row execute function test_fixture_autogroup();
`;

/** Apply one migration file by name, as `freshRpcDb` does (for a `before`-built database). */
export async function applyMigration(db: PGlite, file: string): Promise<void> {
  await db.exec(migrationSql(file));
  await db.query(`insert into supabase_migrations.schema_migrations (version) values ($1)`, [
    file.split("_")[0],
  ]);
}

/** Switch the session to the authenticated owner (RLS on; auth.uid() = OWNER). */
export async function asOwner(db: PGlite): Promise<void> {
  await db.exec(`select set_config('request.jwt.claim.sub', '${OWNER}', false);`);
  await db.exec(`set role authenticated;`);
}

/** Back to the bootstrap superuser (bypasses RLS) — for seeding shared/pre-existing rows + asserts. */
export async function asSuperuser(db: PGlite): Promise<void> {
  await db.exec(`reset role;`);
}

/** Apply a write set through the RPC (as whatever role is current). Mirrors lib/repo applyWriteOps. */
export async function applyOps(db: PGlite, payload: WritePayload): Promise<void> {
  const body = { ops: payload.ops, resync_group_ids: payload.resyncGroupIds ?? [] };
  await db.query(`select apply_write_ops($1::jsonb)`, [JSON.stringify(body)]);
}

/** Insert minimal catalog_card rows (superuser) so copy/slot/wishlist FKs resolve. */
/**
 * Seed catalog rows from real engine fixtures, WITH the columns placement actually reads.
 *
 * `seedCatalogCards` below writes `tcgdex_id` and `name` only, which is right for tests that assert on
 * writes and only need the foreign key to resolve. It is actively misleading for anything that runs the
 * cascade: with `set_id`, `local_id` and `artwork_group_id` all null, `isDuplicateCard` can never match,
 * so NO card is a duplicate of any other and every card routes as if it were the first of its kind.
 * A duplicate-detection test against that seed passes while proving nothing — the same class of trap as
 * a test double that agrees with the code.
 *
 * So: use this whenever the cascade's decision is what is under test, and `seedCatalogCards` when only
 * the FK matters. Takes the engine's own `CatalogCard` fixtures, so the row shape cannot drift from the
 * shape `toCatalogCard` expects to read back.
 */
export async function seedCatalogCardsFull(db: PGlite, cards: CatalogCard[]): Promise<void> {
  for (const c of cards) {
    await db.query(
      `insert into catalog_card
         (tcgdex_id, name, dex_id, set_id, set_name, local_id, rarity, types, stage, evolve_from,
          variants, artwork_group_id, card_class, is_digital_only, image_url)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       on conflict (tcgdex_id) do update set
         dex_id = excluded.dex_id, set_id = excluded.set_id, local_id = excluded.local_id,
         types = excluded.types, stage = excluded.stage, evolve_from = excluded.evolve_from,
         variants = excluded.variants, artwork_group_id = excluded.artwork_group_id,
         card_class = excluded.card_class`,
      [
        c.tcgdexId,
        c.name,
        c.dexId ?? [],
        c.setId,
        c.setName,
        c.localId,
        c.rarity,
        c.types ?? [],
        c.stage,
        c.evolveFrom,
        JSON.stringify(c.variants ?? {}),
        c.artworkGroupId,
        c.cardClass ?? "standard",
        c.isDigitalOnly ?? false,
        null,
      ],
    );
  }
}

export async function seedCatalogCards(db: PGlite, ids: string[]): Promise<void> {
  const unique = [...new Set(ids)].filter(Boolean);
  for (const id of unique) {
    await db.query(
      `insert into catalog_card (tcgdex_id, name) values ($1, $1) on conflict (tcgdex_id) do nothing`,
      [id],
    );
  }
}

/** Insert binder rows owned by OWNER (superuser). */
export async function seedBinders(
  db: PGlite,
  binders: { id: string; type: "general" | "specialty"; name?: string }[],
): Promise<void> {
  for (const b of binders) {
    await db.query(`insert into binder (id, owner_id, name, type) values ($1, $2, $3, $4)`, [
      b.id,
      OWNER,
      b.name ?? b.id,
      b.type,
    ]);
  }
}

/** The raw Dex string a seeded copy of each variant carries — display only, as sync stores it. */
const DEX_RAW: Record<string, string> = { normal: "Normal", holo: "Holo", reverse: "Reverse Holo" };

/**
 * Copies her Dex import created, waiting in her haul — the only thing the Haul Plan places (UIL-098 part
 * 2). Seeded the way sync leaves them: `role = 'haul'`, no placement, and in a presence group per
 * (printing, raw variant), so a test's copy looks like a real import's rather than a hand-made twin.
 * Superuser. Two entries of one printing share one group, as two copies of one Dex row do.
 */
export async function seedHaulCopies(
  db: PGlite,
  copies: { id: string; catalogCardId: string; variant?: string; dexVariantRaw?: string }[],
): Promise<void> {
  for (const c of copies) {
    const raw = c.dexVariantRaw ?? DEX_RAW[c.variant ?? "normal"] ?? "Normal";
    const group = await db.query<{ id: string }>(
      `insert into presence_group (owner_id, catalog_card_id, dex_variant_raw, desired_count)
         values ($1, $2, $3, 1)
       on conflict (owner_id, catalog_card_id, dex_variant_raw)
         do update set desired_count = presence_group.desired_count + 1
       returning id`,
      [OWNER, c.catalogCardId, raw],
    );
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, variant, dex_variant_raw, presence_group_id, role)
         values ($1, $2, $3, $4, $5, $6, 'haul')`,
      [c.id, OWNER, c.catalogCardId, c.variant ?? "normal", raw, group.rows[0].id],
    );
  }
}

/**
 * A Haul Plan draft row for a copy waiting in her haul. The draft id IS the copy id, exactly as the screen
 * builds it from the queue (`loadPendingPlacementDraft`), because the Plan only ever places copies her
 * import made (UIL-098 part 2). Seed the copy with `seedHaulRows`.
 */
export function haulRow(id: string, tcgdexId: string, variant: Variant = "normal"): DraftItem {
  return { id, tcgdexId, variant, existingCopyId: id };
}

/**
 * Seed the haul copies a draft routes, plus a stub catalog row for any printing the test has not seeded
 * itself — only where none exists, so a test's own full row always wins (and a namespaced `ja:` id the
 * test seeded with its locale is never re-inserted without one, which its check constraint refuses).
 * Superuser.
 */
export async function seedHaulRows(db: PGlite, rows: DraftItem[]): Promise<void> {
  for (const id of new Set(rows.map((r) => r.tcgdexId))) {
    await db.query(
      `insert into catalog_card (tcgdex_id, name)
         select $1, $1 where not exists (select 1 from catalog_card where tcgdex_id = $1)`,
      [id],
    );
  }
  await seedHaulCopies(
    db,
    rows.map((r) => ({
      id: r.existingCopyId ?? r.id,
      catalogCardId: r.tcgdexId,
      variant: r.variant,
    })),
  );
}

/** Insert collection rows owned by OWNER (superuser), optionally pre-seeded with targets + binders. */
export async function seedCollections(
  db: PGlite,
  collections: {
    id: string;
    name?: string;
    targetCatalogCardIds?: string[];
    currentBinderIds?: string[];
    mode?: "finite" | "open";
  }[],
): Promise<void> {
  for (const c of collections) {
    await db.query(
      `insert into collection (id, owner_id, name, target_catalog_card_ids, current_binder_ids, mode)
         values ($1, $2, $3, $4, $5, $6)`,
      [
        c.id,
        OWNER,
        c.name ?? c.id,
        c.targetCatalogCardIds ?? [],
        c.currentBinderIds ?? [],
        c.mode ?? "finite",
      ],
    );
  }
}

/** Collect every catalog_card_id a payload references (copy / slot target / wishlist chosen+alts). */
export function referencedCatalogIds(payload: WritePayload): string[] {
  const ids: string[] = [];
  for (const op of payload.ops) {
    if (op.op === "insert_copy") ids.push(op.catalog_card_id);
    if (op.op === "insert_slot" && op.target_catalog_card_id) ids.push(op.target_catalog_card_id);
    if (op.op === "insert_wishlist") {
      if (op.chosen_catalog_card_id) ids.push(op.chosen_catalog_card_id);
      ids.push(...op.alternate_catalog_card_ids);
    }
    if (op.op === "insert_presence_group") ids.push(op.catalog_card_id);
    if (op.op === "insert_unresolved_entry" && op.manual_match_id) ids.push(op.manual_match_id);
  }
  return [...new Set(ids)];
}

/** Row count of a table (as current role — superuser sees all; authenticated sees own via RLS). */
export async function count(db: PGlite, table: string): Promise<number> {
  const r = await db.query<{ n: number }>(`select count(*)::int as n from ${table}`);
  return r.rows[0].n;
}

/**
 * ORPHANED COPIES — the invariant UIL-014 and UIL-022 both exist to protect, defined ONCE.
 *
 * A shelved copy sitting in a binder some collection lives in, whose catalog id is on NO collection
 * that lives in that binder. Such a copy occupies a real pocket while being invisible in every
 * collection and wishlist view (both keyed off `target_catalog_card_ids`) — she would only find it by
 * flipping through the binder by hand.
 *
 * Lives here rather than in each test file so the two fixes cannot come to rest on two subtly
 * different readings of "orphan". Run it as superuser (or as the owner — RLS then scopes it to her
 * rows, which is all a test seeds anyway).
 */
export async function orphanedCopies(db: PGlite): Promise<string[]> {
  const r = await db.query<{ id: string }>(`
    select cp.id
    from copy cp
    where cp.role = 'shelved'
      and cp.binder_id is not null
      and exists (select 1 from collection c where cp.binder_id = any (c.current_binder_ids))
      and not exists (
        select 1 from collection c
        where cp.binder_id = any (c.current_binder_ids)
          and cp.catalog_card_id = any (c.target_catalog_card_ids)
      )
    order by cp.id
  `);
  return r.rows.map((row) => row.id);
}
