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
