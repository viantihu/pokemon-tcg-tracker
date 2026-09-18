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
 * DELIBERATELY NARROW: only the read/write surface `lib/repo` actually uses on these paths
 * (`select` / `eq` / `in` / `ilike` / `contains` / `overlaps` / `or` / `order` / `range` /
 * `maybeSingle` / `insert` / `update` / awaited-list) plus `rpc`. Anything else throws loudly rather
 * than quietly returning the wrong rows — if a repo grows a new call shape, the test fails instead
 * of lying. `ilike`/`contains`/`overlaps`/`or` added for UIL-039's `catalogCardRepo.browse`.
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

type Filter =
  | { kind: "eq" | "in"; col: string; value: unknown }
  | { kind: "is"; col: string }
  | { kind: "ilike"; col: string; pattern: string }
  | { kind: "contains" | "overlaps"; col: string; value: unknown }
  | { kind: "or"; clauses: { col: string; pattern: string }[] };

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`pglite-client: bad identifier ${name}`);
  return `"${name}"`;
}

type Row = Record<string, unknown>;

/**
 * PostgREST (and so supabase-js in production) serializes `numeric` columns as JSON numbers, but the
 * raw pg wire protocol — what PGlite hands back here — returns them as strings by default, to avoid
 * silent precision loss for values a JS `number` cannot represent exactly. Left unparsed, that string
 * reaches application code expecting the production shape (e.g. `fmtPrice`'s `p.toFixed(2)` in
 * lib/line/view.ts) and throws. OID 1700 is `numeric`; parsing it here — the one place every read in
 * this shim funnels through — keeps the fidelity this file exists for without widening it further.
 */
const NUMERIC_PARSERS = { 1700: (v: string) => Number(v) };

/**
 * A thenable query builder that compiles to one SELECT, INSERT, or UPDATE. Mirrors the repo layer's
 * usage only — `createRepo`'s five shapes (`insert(values).select().single()`,
 * `insertMany` the same without `.single()`, `update(patch).eq(pk, v).select().single()`, plus the
 * pre-existing read chains). Extended for UIL-048's `applyCollectionLog`, the first module under test
 * here that writes through direct repo calls rather than `apply_write_ops` — narrow on purpose, same
 * as the read surface above: an unsupported shape throws rather than silently doing nothing.
 */
class PgQuery {
  private cols = "*";
  private filters: Filter[] = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitOffset: { from: number; to: number } | null = null;
  private wantCount = false;
  private mode: "select" | "insert" | "update" = "select";
  private writeValues: Row | Row[] | null = null;
  private wantSingle = false;

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

  insert(values: Row | Row[]): this {
    this.mode = "insert";
    this.writeValues = values;
    return this;
  }

  update(patch: Row): this {
    this.mode = "update";
    this.writeValues = patch;
    return this;
  }

  single(): this {
    this.wantSingle = true;
    return this;
  }

  eq(col: string, value: unknown): this {
    this.filters.push({ kind: "eq", col, value });
    return this;
  }

  /** `IS NULL` — narrow to that one shape, the only one `listShelvedInSection`'s `half: null` needs;
   * `= NULL` is never true in SQL, so this cannot be `eq()` with a `null` value. */
  is(col: string, value: null): this {
    if (value !== null) throw new Error("pglite-client: is() only supports null");
    this.filters.push({ kind: "is", col });
    return this;
  }

  in(col: string, value: unknown[]): this {
    this.filters.push({ kind: "in", col, value });
    return this;
  }

  ilike(col: string, pattern: string): this {
    this.filters.push({ kind: "ilike", col, pattern });
    return this;
  }

  /** Array column contains ALL of `value` (`@>`) — e.g. `dex_id` holding a given species key. */
  contains(col: string, value: unknown[]): this {
    this.filters.push({ kind: "contains", col, value });
    return this;
  }

  /** Array column shares ANY element with `value` (`&&`) — e.g. `types` matching any raw type in a
   * color band's expansion. */
  overlaps(col: string, value: unknown[]): this {
    this.filters.push({ kind: "overlaps", col, value });
    return this;
  }

  /**
   * PostgREST's `or("a.ilike.x,b.ilike.y")` mini-language — narrow on purpose, same discipline as
   * the rest of this shim: only the `col.ilike.pattern` clause shape `search()`/`browse()` actually
   * emit is parsed; anything else throws rather than silently matching nothing.
   */
  or(expr: string): this {
    const clauses = expr.split(",").map((part) => {
      const m = /^([a-zA-Z_][a-zA-Z0-9_]*)\.ilike\.(.*)$/.exec(part);
      if (!m) throw new Error(`pglite-client: unsupported or() clause "${part}"`);
      return { col: m[1], pattern: m[2] };
    });
    this.filters.push({ kind: "or", clauses });
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderCol = col;
    // Honoured rather than ignored: silently sorting ascending for a `{ ascending: false }` caller is
    // the shape of double that certifies wrong behaviour (see tests/catalog/card-search.test.ts).
    this.orderAsc = opts?.ascending ?? true;
    return this;
  }

  /**
   * PostgREST's `range(from, to)` — INCLUSIVE both ends, so it compiles to
   * `limit (to - from + 1) offset from`. Needed by `pageAll`/`listAll`, which is how every read that
   * can exceed the row cap now works (UIL-031).
   */
  range(from: number, to: number): this {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
      throw new Error(`pglite-client: bad range(${from}, ${to})`);
    }
    this.limitOffset = { from, to };
    return this;
  }

  private whereClause(params: unknown[]): string {
    const where: string[] = [];
    for (const f of this.filters) {
      if (f.kind === "eq") {
        params.push(f.value);
        where.push(`${quoteIdent(f.col)} = $${params.length}`);
      } else if (f.kind === "is") {
        where.push(`${quoteIdent(f.col)} is null`);
      } else if (f.kind === "in") {
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
      } else if (f.kind === "ilike") {
        params.push(f.pattern);
        where.push(`${quoteIdent(f.col)} ilike $${params.length}`);
      } else if (f.kind === "contains") {
        params.push(f.value);
        where.push(`${quoteIdent(f.col)} @> $${params.length}`);
      } else if (f.kind === "overlaps") {
        params.push(f.value);
        where.push(`${quoteIdent(f.col)} && $${params.length}`);
      } else if (f.kind === "or") {
        const parts = f.clauses.map((c) => {
          params.push(c.pattern);
          return `${quoteIdent(c.col)} ilike $${params.length}`;
        });
        where.push(`(${parts.join(" or ")})`);
      }
    }
    return where.length > 0 ? ` where ${where.join(" and ")}` : "";
  }

  private compile(): [string, unknown[]] {
    const params: unknown[] = [];
    const sql =
      `select ${this.cols} from ${quoteIdent(this.table)}` +
      this.whereClause(params) +
      (this.orderCol
        ? ` order by ${quoteIdent(this.orderCol)} ${this.orderAsc ? "asc" : "desc"}`
        : "") +
      (this.limitOffset
        ? ` limit ${this.limitOffset.to - this.limitOffset.from + 1} offset ${this.limitOffset.from}`
        : "");
    return [sql, params];
  }

  private async rows(): Promise<Row[]> {
    const [sql, params] = this.compile();
    const res = await this.db.query<Row>(sql, params, { parsers: NUMERIC_PARSERS });
    return res.rows;
  }

  /**
   * The real row count for these filters, ignoring any range — see the note in `then`.
   *
   * The ORDER BY has to come off as well as the range. `select count(*) … order by tcgdex_id` is
   * invalid SQL ("must appear in the GROUP BY clause or be used in an aggregate function"), so leaving
   * it on made this throw for exactly the readers that matter: a paged read always orders by its
   * primary key. Ordering is meaningless for a scalar count anyway.
   */
  private async total(): Promise<number> {
    const saved = this.limitOffset;
    const savedCols = this.cols;
    const savedOrder = this.orderCol;
    this.limitOffset = null;
    this.orderCol = null;
    this.cols = "count(*)::int as n";
    try {
      const [sql, params] = this.compile();
      const res = await this.db.query<{ n: number }>(sql, params);
      return res.rows[0]?.n ?? 0;
    } finally {
      this.limitOffset = saved;
      this.cols = savedCols;
      this.orderCol = savedOrder;
    }
  }

  private async runInsert(): Promise<Row[]> {
    const rows = Array.isArray(this.writeValues) ? this.writeValues : [this.writeValues!];
    if (rows.length === 0) return [];
    const cols = Object.keys(rows[0]);
    const params: unknown[] = [];
    const valueRows = rows.map(
      (row) => `(${cols.map((c) => (params.push(row[c]), `$${params.length}`)).join(", ")})`,
    );
    const sql =
      `insert into ${quoteIdent(this.table)} (${cols.map(quoteIdent).join(", ")})` +
      ` values ${valueRows.join(", ")} returning *`;
    const res = await this.db.query<Row>(sql, params, { parsers: NUMERIC_PARSERS });
    return res.rows;
  }

  private async runUpdate(): Promise<Row[]> {
    const params: unknown[] = [];
    const patch = this.writeValues as Row;
    const setCols = Object.keys(patch);
    const setClause = setCols
      .map((c) => (params.push(patch[c]), `${quoteIdent(c)} = $${params.length}`))
      .join(", ");
    const sql =
      `update ${quoteIdent(this.table)} set ${setClause}` +
      this.whereClause(params) +
      ` returning *`;
    const res = await this.db.query<Row>(sql, params, { parsers: NUMERIC_PARSERS });
    return res.rows;
  }

  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const rows = await this.rows();
    return { data: rows[0] ?? null, error: null };
  }

  then<TResult1, TResult2 = never>(
    onFulfilled?:
      | ((value: {
          data: Row[] | Row | null;
          error: null;
          count: number | null;
        }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    const run =
      this.mode === "insert"
        ? this.runInsert()
        : this.mode === "update"
          ? this.runUpdate()
          : this.rows();
    return (
      run
        // `async` because the count below is a second query (see its note); #119's version needed none.
        .then(async (rows) => ({
          data: this.wantSingle ? (rows[0] ?? null) : rows,
          error: null as null,
          // NOT `rows.length`: with a `range` applied that is the page size, and reporting it as the
          // total is exactly how `assertReadComplete` would be fooled into thinking a truncated read
          // was complete. Counted with the same filters and NO limit/offset, so it stays the real total.
          count: this.wantCount ? await this.total() : null,
        }))
        .then(onFulfilled, onRejected)
    );
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
