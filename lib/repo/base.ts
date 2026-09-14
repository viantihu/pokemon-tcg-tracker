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
 * Guards a "read everything" query against PostgREST's silent `max-rows` truncation (UIL-031).
 *
 * Call only on a query built with `.select(cols, { count: "exact" })` and NO `.range()`/`.limit()` —
 * a query that means to return every matching row. `count` then carries the true total PostgREST
 * counted server-side, independent of how many rows the cap actually let through; if that is more
 * than we got back, the response was silently cut off, so this throws rather than let a partial
 * result masquerade as complete. A deliberately bounded read (e.g. `catalogCardRepo.search`'s
 * `limit`) must never pass `count: "exact"` through here — fewer rows than exist is its whole point,
 * not a truncation.
 *
 * Checking `rows.length < count` rather than `rows.length === CAP` means this needs no cap constant
 * at all: it catches truncation at whatever `max-rows` the project is actually configured to, not
 * just the Supabase default of 1000.
 */
export function assertReadComplete(table: string, rows: unknown[], count: number | null): void {
  if (count !== null && rows.length < count) {
    throw new Error(
      `${table}: read ${rows.length} of ${count} row(s) — the server's row cap truncated this ` +
        `"read everything" query. Use listAll()/pageAll for a table that can grow past the cap.`,
    );
  }
}

/**
 * Read every row of `table`, projecting `columns`, paged past the server's `max-rows` cap.
 *
 * Ordered by the primary key so the window is stable across requests, and advanced by rows RECEIVED
 * rather than rows requested — the server cap can be smaller than `pageSize`, which a fixed stride
 * would skip over. Costs one extra empty-page request at the end in exchange for being correct at any
 * cap. Shared by `listAll` and `listAllFields` so there is only one paging implementation to get right.
 */
async function pageAll<R>(
  db: DbClient,
  table: string,
  pk: string,
  columns: string,
  pageSize: number,
): Promise<R[]> {
  const out: R[] = [];
  for (let from = 0; ;) {
    const { data, error } = await loose(db)
      .from(table)
      .select(columns)
      .order(pk, { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as R[];
    out.push(...page);
    if (page.length === 0) return out;
    from += page.length;
    if (out.length > LIST_ALL_HARD_CAP) {
      throw new Error(
        `listAll(${table}) exceeded ${LIST_ALL_HARD_CAP} rows — refusing to page on.`,
      );
    }
  }
}

/**
 * Drives a FILTERED, custom-ordered read past the server's `max-rows` cap (UIL-031). Unlike
 * `pageAll` — which pages a whole table ordered by its primary key — the caller builds each page
 * itself: `page(from, to)` must apply the SAME filters and the SAME order on every call, ending in
 * `.range(from, to)`. That lets a bespoke finder like `copyRepo.listUnplaced` (filtered on role and
 * placement, ordered oldest-first) page instead of throwing on truncation, without `pageAll` having
 * to know its filters.
 *
 * The order the caller applies MUST be a TOTAL order (no ties) — `.range()` only tiles correctly
 * over rows in a fixed sequence, so an order that can tie (a timestamp, say) needs a unique
 * tiebreaker appended, the way `listUnplaced` orders `created_at` then `id`. An order with ties can
 * skip or duplicate rows across a page boundary.
 */
export async function pageFiltered<R>(
  table: string,
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
  pageSize = 1000,
): Promise<R[]> {
  const out: R[] = [];
  for (let from = 0; ;) {
    const { data, error } = await page(from, from + pageSize - 1);
    if (error) throw error;
    const rows = (data ?? []) as R[];
    out.push(...rows);
    if (rows.length === 0) return out;
    from += rows.length;
    if (out.length > LIST_ALL_HARD_CAP) {
      throw new Error(
        `pageFiltered(${table}) exceeded ${LIST_ALL_HARD_CAP} rows — refusing to page on.`,
      );
    }
  }
}

/**
 * A single-column-primary-key CRUD repo for `table`, keyed on `pk` (default `"id"`).
 * Config tables use their natural key (`color_band.band`, `type_color_map.card_type`).
 */
export function createRepo<T extends TableName>(table: T, pk: string = "id") {
  return {
    table,
    pk,

    /**
     * A SINGLE page of the table, for a table known to be small (config, binders) — PostgREST caps
     * every response at the project's server-side `max-rows` (1000 on Supabase by default), and if
     * the table has grown past that this throws rather than silently hand back a partial list
     * (UIL-031). For a full-table read whose correctness depends on completeness on a table that CAN
     * grow past the cap, use `listAll` instead, which pages rather than throwing.
     */
    async list(db: DbClient): Promise<Row<T>[]> {
      const { data, error, count } = await loose(db).from(table).select("*", { count: "exact" });
      if (error) throw error;
      const rows = (data ?? []) as Row<T>[];
      assertReadComplete(table, rows, count);
      return rows;
    },

    /**
     * Every row, paged past the server's `max-rows` cap (see `list` and `pageAll`).
     */
    async listAll(db: DbClient, pageSize = 1000): Promise<Row<T>[]> {
      return pageAll<Row<T>>(db, table, pk, "*", pageSize);
    },

    /**
     * Every row, but only the named columns. Same paging discipline as `listAll` for a fraction of the
     * bytes: for a caller that needs completeness across the whole table yet reads only a handful of
     * fields, `select *` is pure waste. The plan state stamp is the motivating case — it has to see
     * every copy's placement on every visit to `/plan`, and a copy row carries a dozen columns it does
     * not look at (see lib/plan/fingerprint.ts).
     *
     * `fields` is checked against `Row<T>`, so a renamed column is a compile error rather than a
     * digest that silently folds `undefined` into itself.
     */
    async listAllFields<K extends keyof Row<T> & string>(
      db: DbClient,
      fields: readonly K[],
      pageSize = 1000,
    ): Promise<Pick<Row<T>, K>[]> {
      return pageAll<Pick<Row<T>, K>>(db, table, pk, fields.join(","), pageSize);
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
