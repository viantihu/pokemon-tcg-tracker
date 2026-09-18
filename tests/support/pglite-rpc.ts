/**
 * Shared PGlite harness for the M10 `apply_write_ops` atomicity tests (dev-spec §4 DoD: migrations
 * apply to a fresh DB; §5 M10: commits are truly atomic). Runs REAL Postgres/plpgsql in WASM (no
 * Docker), applying the frozen 0001–0007 + the new 0008, then replicating the platform grants and
 * `auth.uid()` shim Supabase provides so the SECURITY INVOKER function runs under the authenticated
 * owner's RLS — exactly as production does. Never edits a migration file.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import type { CatalogCard } from "@/lib/engine";
import type { WritePayload } from "@/lib/repo";

export const OWNER = "00000000-0000-0000-0000-000000000001";

const MIGRATIONS = [
  "0001_init.sql",
  "0002_domain.sql",
  "0003_config.sql",
  "0004_catalog_artwork.sql",
  "0005_collection_mode.sql",
  "0006_commit_rpc.sql",
  "0007_backfill_ops.sql",
  "0008_collection_removal_ops.sql",
  // 0009/0010 were missing from this list (a pre-existing gap, not from this PR) — every PGlite test
  // was silently running one schema version behind whatever actually ships. Restored here so this harness
  // reflects the real migration history rather than a snapshot frozen at 0008.
  "0009_set_metadata.sql",
  "0010_release_stale_line_slots.sql",
  // 0011 (relink) is a one-time data repair, same shape as 0010 — a no-op on a fresh/empty test DB,
  // included so the harness's schema stays in sync with what actually ships rather than needing every
  // future migration remembered here by hand one at a time.
  "0011_relink_unambiguous_line_slots.sql",
  // UIL-052's own migration (this PR). Numbered 0012 per the Senior BA's allocation — originally
  // authored as 0011, renumbered once 0011_relink_unambiguous_line_slots.sql (a different,
  // independently-developed migration) landed on develop first and claimed that number. UIL-078's
  // #188 ships 0013, not 0012, so 0012 is this PR's. Two files sharing one prefix is not a git
  // conflict (different filenames), so a numbering collision is only caught by checking file-by-file
  // against develop — do that on every rebase, not just this once.
  "0012_collection_updated_at.sql",
];

// Supabase provides auth.uid() + the anon/authenticated/service_role roles; PGlite (vanilla PG) does
// not, so we shim exactly those before applying the migrations (never editing the frozen files).
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

/** Fresh DB with 0001→0008 applied, platform grants replicated. Ends as the bootstrap superuser. */
export async function freshRpcDb(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_SHIMS);
  for (const f of MIGRATIONS) await db.exec(migrationSql(f));
  // Supabase grants base-table privileges to these roles as a platform default; RLS is the security
  // boundary on top. Replicate it so `set role authenticated` can write through the RPC.
  await db.exec(`
    grant usage on schema public to authenticated, service_role, anon;
    grant all on all tables in schema public to authenticated, service_role;
  `);
  return db;
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
