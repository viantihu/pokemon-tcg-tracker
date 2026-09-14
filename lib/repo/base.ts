/**
 * Thin, typed data-access layer over Supabase (dev-spec §5 M1). Every route handler, Server
 * Component, and Server Action calls the repo — never `db.from(...)` directly — so table and
 * column names live in one place and RLS-scoped queries stay consistent.
 *
 * A repo does NOT create its own client: the caller passes a `DbClient` (from
 * `lib/supabase/server.ts` for RLS-scoped access, or a service-role client for catalog sync).
 * This keeps the repo pure of request/cookie concerns and trivially unit-testable.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

export type DbClient = SupabaseClient<Database>;

type PublicSchema = Database["public"];
export type TableName = keyof PublicSchema["Tables"] & string;
export type Row<T extends TableName> = PublicSchema["Tables"][T]["Row"];
export type Insert<T extends TableName> = PublicSchema["Tables"][T]["Insert"];
export type Update<T extends TableName> = PublicSchema["Tables"][T]["Update"];

export type ViewName = keyof PublicSchema["Views"] & string;
export type ViewRow<T extends ViewName> = PublicSchema["Views"][T]["Row"];

/**
 * supabase-js resolves its query-builder result types from a *literal* table name; a generic table
 * name collapses them into unusable conditional types. So the generic factory drives the builder
 * through a schema-less view of the same client, then re-applies the precise `Row<T>` / `Insert<T>`
 * types at the boundary. Bespoke per-aggregate finders below use literal table names and stay fully
 * inferred without this shim.
 */
function loose(db: DbClient): SupabaseClient {
  return db as unknown as SupabaseClient;
}

/**
 * Safety stop for `listAll` so a paging bug can never spin forever. Sized well above the biggest
 * table we mirror (~23.5k `catalog_card` rows) with room to grow.
 */
const LIST_ALL_HARD_CAP = 200_000;

/**
 * A single-column-primary-key CRUD repo for `table`, keyed on `pk` (default `"id"`).
 * Config tables use their natural key (`color_band.band`, `type_color_map.card_type`).
 */
export function createRepo<T extends TableName>(table: T, pk: string = "id") {
  return {
    table,
    pk,

    /**
     * A SINGLE page of the table. PostgREST caps every response at the project's server-side
     * `max-rows` (1000 on Supabase by default), so this SILENTLY TRUNCATES on any table bigger than
     * that. Use it only where the table is known-small (config, binders); for a full-table read whose
     * correctness depends on completeness, use `listAll`.
     */
    async list(db: DbClient): Promise<Row<T>[]> {
      const { data, error } = await loose(db).from(table).select("*");
      if (error) throw error;
      return (data ?? []) as Row<T>[];
    },

    /**
     * Every row, paged past the server's `max-rows` cap (see `list`). Ordered by the primary key so
     * the window is stable across requests, and advanced by rows RECEIVED rather than rows requested
     * — the server cap can be smaller than `pageSize`, which a fixed stride would skip over. Costs
     * one extra empty-page request at the end in exchange for being correct at any cap.
     */
    async listAll(db: DbClient, pageSize = 1000): Promise<Row<T>[]> {
      const out: Row<T>[] = [];
      for (let from = 0; ;) {
        const { data, error } = await loose(db)
          .from(table)
          .select("*")
          .order(pk, { ascending: true })
          .range(from, from + pageSize - 1);
        if (error) throw error;
        const page = (data ?? []) as Row<T>[];
        out.push(...page);
        if (page.length === 0) return out;
        from += page.length;
        if (out.length > LIST_ALL_HARD_CAP) {
          throw new Error(
            `listAll(${table}) exceeded ${LIST_ALL_HARD_CAP} rows — refusing to page on.`,
          );
        }
      }
    },

    /**
     * Row count only — no rows transferred (`head: true`). Used where something needs to know THAT a
     * table changed without paying to read it (see lib/plan/fingerprint.ts).
     */
    async count(db: DbClient): Promise<number> {
      const { count, error } = await loose(db)
        .from(table)
        .select("*", { count: "exact", head: true });
      if (error) throw error;
      return count ?? 0;
    },

    async getByPk(db: DbClient, value: string | number): Promise<Row<T> | null> {
      const { data, error } = await loose(db).from(table).select("*").eq(pk, value).maybeSingle();
      if (error) throw error;
      return (data as Row<T> | null) ?? null;
    },

    async insert(db: DbClient, values: Insert<T>): Promise<Row<T>> {
      const { data, error } = await loose(db).from(table).insert(values).select().single();
      if (error) throw error;
      return data as Row<T>;
    },

    async insertMany(db: DbClient, values: Insert<T>[]): Promise<Row<T>[]> {
      const { data, error } = await loose(db).from(table).insert(values).select();
      if (error) throw error;
      return (data ?? []) as Row<T>[];
    },

    async update(db: DbClient, value: string | number, patch: Update<T>): Promise<Row<T>> {
      const { data, error } = await loose(db)
        .from(table)
        .update(patch)
        .eq(pk, value)
        .select()
        .single();
      if (error) throw error;
      return data as Row<T>;
    },

    async remove(db: DbClient, value: string | number): Promise<void> {
      const { error } = await loose(db).from(table).delete().eq(pk, value);
      if (error) throw error;
    },
  };
}
