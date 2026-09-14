/**
 * A `DbClient` (supabase-js) shim backed by the PGlite harness, so a server-side module can be run
 * END TO END against real Postgres — real migrations, real RLS, real `apply_write_ops` — instead of
 * against a hand-rolled fake whose semantics are the test author's guess.
 *
 * That distinction is the point. A fake DbClient proves a module emits the ops the author expected; it
 * cannot prove those ops do what the author expected once Postgres runs them, and it cannot catch a
 * mismatch between the fixture's row shape and the shape production actually stores (UIL-012 shipped
 * through a fully green suite exactly that way). Reads here go through the same SQL the repo layer's
 * PostgREST calls compile to, under `set role authenticated`, so RLS applies as it does in production.
 *
 * DELIBERATELY NARROW: only the read surface `lib/repo` actually uses on these paths
 * (`select` / `eq` / `in` / `order` / `maybeSingle` / awaited-list) plus `rpc`. Anything else throws
 * loudly rather than quietly returning the wrong rows — if a repo grows a new call shape, the test
 * fails instead of lying.
 */
import type { PGlite } from "@electric-sql/pglite";
import type { DbClient } from "@/lib/repo";

type Filter = { kind: "eq" | "in"; col: string; value: unknown };

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`pglite-client: bad identifier ${name}`);
  return `"${name}"`;
}

/** A thenable query builder that compiles to one SELECT. Mirrors the repo layer's usage only. */
class PgQuery {
  private cols = "*";
  private filters: Filter[] = [];
  private orderCol: string | null = null;

  constructor(
    private readonly db: PGlite,
    private readonly table: string,
  ) {}

  select(cols?: string, opts?: unknown): this {
    if (opts !== undefined) {
      throw new Error("pglite-client: select() options (count/head) are not supported");
    }
    if (cols && cols !== "*") {
      this.cols = cols
        .split(",")
        .map((c) => quoteIdent(c.trim()))
        .join(", ");
    }
    return this;
  }

  eq(col: string, value: unknown): this {
    this.filters.push({ kind: "eq", col, value });
    return this;
  }

  in(col: string, value: unknown[]): this {
    this.filters.push({ kind: "in", col, value });
    return this;
  }

  order(col: string): this {
    this.orderCol = col;
    return this;
  }

  private compile(): [string, unknown[]] {
    const params: unknown[] = [];
    const where: string[] = [];
    for (const f of this.filters) {
      if (f.kind === "eq") {
        params.push(f.value);
        where.push(`${quoteIdent(f.col)} = $${params.length}`);
      } else {
        const list = f.value as unknown[];
        if (list.length === 0) {
          where.push("false");
          continue;
        }
        const slots = list.map((v) => {
          params.push(v);
          return `$${params.length}`;
        });
        where.push(`${quoteIdent(f.col)} in (${slots.join(", ")})`);
      }
    }
    const sql =
      `select ${this.cols} from ${quoteIdent(this.table)}` +
      (where.length > 0 ? ` where ${where.join(" and ")}` : "") +
      (this.orderCol ? ` order by ${quoteIdent(this.orderCol)} asc` : "");
    return [sql, params];
  }

  private async rows(): Promise<Record<string, unknown>[]> {
    const [sql, params] = this.compile();
    const res = await this.db.query<Record<string, unknown>>(sql, params);
    return res.rows;
  }

  async maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: null }> {
    const rows = await this.rows();
    return { data: rows[0] ?? null, error: null };
  }

  then<TResult1, TResult2 = never>(
    onFulfilled?:
      | ((value: {
          data: Record<string, unknown>[];
          error: null;
        }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.rows()
      .then((rows) => ({ data: rows, error: null as null }))
      .then(onFulfilled, onRejected);
  }
}

/**
 * A `DbClient` over an open PGlite database. Writes must go through `rpc('apply_write_ops', …)` — the
 * only write path the collection-removal code uses, and the one whose atomicity is under test.
 */
export function pgliteClient(db: PGlite): DbClient {
  const client = {
    from(table: string) {
      return new PgQuery(db, table);
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      if (fn !== "apply_write_ops") throw new Error(`pglite-client: unsupported rpc ${fn}`);
      try {
        await db.query(`select ${quoteIdent(fn)}($1::jsonb)`, [JSON.stringify(args.payload)]);
        return { data: null, error: null };
      } catch (err) {
        // supabase-js reports DB failures in `error` rather than throwing; `applyWriteOps` rethrows.
        return { data: null, error: err as unknown };
      }
    },
  };
  return client as unknown as DbClient;
}
