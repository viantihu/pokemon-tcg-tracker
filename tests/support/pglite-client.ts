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
 *
 * `select(cols, { count: "exact" })` is supported (UIL-031's `assertReadComplete` needs it), and the
 * count it reports is real: this runs the query's actual SQL with no `LIMIT`/`OFFSET`, so `count` is
 * just `rows.length` — genuinely accurate, not a guess. What that does NOT do is model PostgREST's
 * `max-rows` cap: PGlite is real Postgres with no REST layer in front of it, so nothing here ever
 * truncates a response the way a live 1000+-row table would. This shim can prove a query wired for
 * truncation detection still returns the right rows on real Postgres/RLS; it cannot exercise the
 * detection actually firing — see `tests/repo/truncation-detection.test.ts` for that, against a fake
 * that models the cap explicitly instead.
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
  private wantCount = false;

  constructor(
    private readonly db: PGlite,
    private readonly table: string,
  ) {}

  select(cols?: string, opts?: { count?: "exact"; head?: boolean }): this {
    if (opts !== undefined) {
      if (opts.count !== "exact" || opts.head) {
        throw new Error('pglite-client: select() only supports { count: "exact" } (no head)');
      }
      this.wantCount = true;
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
          count: number | null;
        }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.rows()
      .then((rows) => ({
        data: rows,
        error: null as null,
        count: this.wantCount ? rows.length : null,
      }))
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
