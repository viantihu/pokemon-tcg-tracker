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
 * `maybeSingle` / `insert` / `update` / `upsert` / awaited-list / `{ count: "exact", head: true }`) plus
 * `rpc`. Anything else throws loudly rather
 * than quietly returning the wrong rows — if a repo grows a new call shape, the test fails instead
 * of lying. `ilike`/`contains`/`overlaps`/`or` added for UIL-039's `catalogCardRepo.browse`;
 * `not(col, "is", null)` for UIL-046's retry-sweep test, which drives the sync resolver's set-name
 * fallback (`catalogCardRepo.findSetIdsByName`) on real Postgres.
 *
 * Failures are reported the way supabase-js reports them: a Postgres error (anything with a SQLSTATE)
 * comes back as `{ data: null, error: { code, message, details, hint } }`, never as a rejected promise,
 * so a call site's `if (error) throw error` is the path exercised here. Only the shim's OWN refusals
 * (an unmodelled call shape) throw.
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
  | { kind: "eq" | "neq" | "in"; col: string; value: unknown }
  | { kind: "is"; col: string }
  | { kind: "not-null"; col: string }
  | { kind: "ilike"; col: string; pattern: string }
  | { kind: "contains" | "overlaps"; col: string; value: unknown }
  | { kind: "or"; clauses: { col: string; pattern: string }[] };

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`pglite-client: bad identifier ${name}`);
  return `"${name}"`;
}

type Row = Record<string, unknown>;

/** The shape supabase-js reports a PostgREST failure in — a plain object, not an Error (lib/errors.ts). */
interface PostgrestLikeError {
  code: string;
  message: string;
  details: string | null;
  hint: string | null;
}

/**
 * A Postgres failure, in the shape supabase-js reports it: `{ data: null, error }` with `code` the
 * SQLSTATE ("23505" unique_violation, "21000" cardinality_violation, "42703" undefined_column) — never a
 * rejected promise. The shim used to reject with PGlite's raw error, so a call site's
 * `if (error) throw error` was never the path exercised here (UIL-029 contract suite, the upsert case).
 * Only errors carrying a SQLSTATE are translated; the shim's own refusals ("pglite-client: …") throw.
 */
function asPostgrestError(err: unknown): PostgrestLikeError | null {
  const e = err as { code?: unknown; message?: unknown; detail?: unknown; hint?: unknown } | null;
  if (!e || typeof e.code !== "string" || !/^[0-9A-Z]{5}$/.test(e.code)) return null;
  if (typeof e.message !== "string") return null;
  return {
    code: e.code,
    message: e.message,
    details: typeof e.detail === "string" ? e.detail : null,
    hint: typeof e.hint === "string" ? e.hint : null,
  };
}

/** PGRST116, as PostgREST raises it when `.single()` / `.maybeSingle()` does not identify exactly one row. */
function multipleRows(n: number): PostgrestLikeError {
  return {
    code: "PGRST116",
    message: "JSON object requested, multiple (or no) rows returned",
    details: `Results contain ${n} rows, application/vnd.pgrst.object+json requires 1 row`,
    hint: null,
  };
}

/**
 * PostgREST (and so supabase-js in production) serializes `numeric` columns as JSON numbers, but the
 * raw pg wire protocol — what PGlite hands back here — returns them as strings by default, to avoid
 * silent precision loss for values a JS `number` cannot represent exactly. Left unparsed, that string
 * reaches application code expecting the production shape (e.g. `fmtPrice`'s `p.toFixed(2)` in
 * lib/line/view.ts) and throws. OID 1700 is `numeric`; parsing it here — the one place every read in
 * this shim funnels through — keeps the fidelity this file exists for without widening it further.
 */
/**
 * Postgres `timestamptz` / `timestamp` come off the wire as text ("2026-09-19 16:00:00.123456+00"); PGlite's
 * default parser turns them into a JS `Date`, but PostgREST — what production reads through — hands the app
 * a STRING. Readers do `new Date(x)` on it. The shim's promise is therefore: a timestamp column is an
 * ISO-8601 string that `new Date()` parses (`toISOString()` form, so `Z`, not PostgREST's `+00:00`
 * spelling — byte-identity is not promised, parseability and ordering are). A `timestamp` without zone is
 * read as UTC. Pinned by tests/support/pglite-client.contract.test.ts (UIL-029).
 */
function pgTimestampToIso(raw: string, hasZone: boolean): string {
  let s = raw.replace(" ", "T");
  if (hasZone) {
    if (/[+-]\d\d$/.test(s)) s += ":00";
  } else {
    s += "Z";
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? raw : d.toISOString();
}

/** Every column parser the shim applies — see the notes on each. OID 1700 numeric, 1114 timestamp, 1184 timestamptz. */
const PARSERS = {
  1700: (v: string) => Number(v),
  1114: (v: string) => pgTimestampToIso(v, false),
  1184: (v: string) => pgTimestampToIso(v, true),
};

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
  /**
   * Every `.order()` in call order, as PostgREST applies them: the first is the primary sort and each
   * later one breaks its ties. This used to keep only the LAST call, so `.order("created_at").order("id")`
   * — the Haul Plan queue's "oldest first" — sorted by id alone here while production sorted oldest
   * first; caught by UIL-098's Backfill tests, which place the oldest waiting copy.
   */
  private orders: { col: string; asc: boolean; nullsFirst?: boolean }[] = [];
  private limitOffset: { from: number; to: number } | null = null;
  private wantCount = false;
  private mode: "select" | "insert" | "update" | "upsert" = "select";
  private conflictCol: string | null = null;
  private writeValues: Row | Row[] | null = null;
  private wantSingle = false;
  private wantHead = false;

  constructor(
    private readonly db: PGlite,
    private readonly table: string,
  ) {}

  select(cols?: string, opts?: { count?: "exact"; head?: boolean }): this {
    if (opts !== undefined) {
      if (opts.count !== "exact") {
        throw new Error('pglite-client: select() only supports { count: "exact" }');
      }
      this.wantCount = true;
      // `head: true` is PostgREST's "count only, no rows" (createRepo's `count()`); honoured here by
      // skipping the row query and answering `data: null` with the real total (UIL-032's loader test).
      if (opts.head) this.wantHead = true;
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

  /**
   * `upsert(rows, { onConflict })` — PostgREST's `INSERT … ON CONFLICT (col) DO UPDATE SET every other
   * supplied column = excluded.<col>`, the shape `catalogCardRepo.upsertMany` sends for the mirror
   * (UIL-029: tests/catalog/mirror.test.ts moved off a hand-written double onto this). Without
   * `onConflict` the conflict target is the table's PRIMARY KEY, read from the catalog at run time —
   * composite keys included — which is what supabase-js/PostgREST do and the shape `setAliasRepo.upsert`
   * sends (`set_alias` keys on (locale, dex_code)); a table with no primary key is refused rather than
   * guessed. Narrow: at most one explicit conflict column, `ignoreDuplicates` not modelled. Postgres
   * itself supplies the behaviour the old double had to hand-code — "cannot affect row a second time"
   * when a batch repeats a key.
   */
  upsert(rows: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }): this {
    if (opts?.onConflict?.includes(",") || opts?.ignoreDuplicates) {
      throw new Error(
        "pglite-client: upsert() supports one onConflict column or none (the primary key), no ignoreDuplicates",
      );
    }
    this.mode = "upsert";
    this.conflictCol = opts?.onConflict ?? null;
    this.writeValues = rows;
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

  /**
   * `<> value`. PostgREST's `neq`, added for `copyRepo.ownedCatalogCardIdSet`'s "every role except the
   * one that is not a card" (UIL-093) — asking it as a list of the roles that DO count is what went
   * stale when UIL-088 added a third one.
   *
   * SQL's three-valued logic is the same here as in production: `col <> v` is NULL, not true, for a NULL
   * column, so a nullable column's NULL rows do not match. Every caller so far uses it on `role`, which
   * is NOT NULL.
   */
  neq(col: string, value: unknown): this {
    this.filters.push({ kind: "neq", col, value });
    return this;
  }

  /** `IS NULL` — narrow to that one shape, the only one `listShelvedInSection`'s `half: null` needs;
   * `= NULL` is never true in SQL, so this cannot be `eq()` with a `null` value. */
  is(col: string, value: null): this {
    if (value !== null) throw new Error("pglite-client: is() only supports null");
    this.filters.push({ kind: "is", col });
    return this;
  }

  /** `IS NOT NULL` — the one `not()` shape a repo uses (`catalogCardRepo.findSetIdsByName`'s
   * `.not("set_id", "is", null)`, on the sync resolver's set-name fallback). Anything else throws. */
  not(col: string, op: string, value: unknown): this {
    if (op !== "is" || value !== null) {
      throw new Error('pglite-client: not() only supports ("is", null)');
    }
    this.filters.push({ kind: "not-null", col });
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

  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }): this {
    // Honoured rather than ignored: silently sorting ascending for a `{ ascending: false }` caller is
    // the shape of double that certifies wrong behaviour (see tests/catalog/card-search.test.ts). Same
    // for `nullsFirst`, which Postgres otherwise defaults the opposite way for a descending sort.
    this.orders.push({ col, asc: opts?.ascending ?? true, nullsFirst: opts?.nullsFirst });
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
      } else if (f.kind === "neq") {
        params.push(f.value);
        where.push(`${quoteIdent(f.col)} <> $${params.length}`);
      } else if (f.kind === "is") {
        where.push(`${quoteIdent(f.col)} is null`);
      } else if (f.kind === "not-null") {
        where.push(`${quoteIdent(f.col)} is not null`);
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
      (this.orders.length > 0
        ? ` order by ${this.orders
            .map(
              (o) =>
                `${quoteIdent(o.col)} ${o.asc ? "asc" : "desc"}` +
                (o.nullsFirst === undefined ? "" : o.nullsFirst ? " nulls first" : " nulls last"),
            )
            .join(", ")}`
        : "") +
      (this.limitOffset
        ? ` limit ${this.limitOffset.to - this.limitOffset.from + 1} offset ${this.limitOffset.from}`
        : "");
    return [sql, params];
  }

  private async rows(): Promise<Row[]> {
    const [sql, params] = this.compile();
    const res = await this.db.query<Row>(sql, params, { parsers: PARSERS });
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
    const savedOrder = this.orders;
    this.limitOffset = null;
    this.orders = [];
    this.cols = "count(*)::int as n";
    try {
      const [sql, params] = this.compile();
      const res = await this.db.query<{ n: number }>(sql, params);
      return res.rows[0]?.n ?? 0;
    } finally {
      this.limitOffset = saved;
      this.cols = savedCols;
      this.orders = savedOrder;
    }
  }

  /** The table's primary-key columns in index order: `upsert()`'s conflict target when none is given. */
  private async primaryKey(): Promise<string[]> {
    const res = await this.db.query<{ attname: string }>(
      `select a.attname
         from pg_index i
         join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where i.indrelid = $1::regclass and i.indisprimary
        order by array_position(i.indkey::int2[], a.attnum)`,
      [quoteIdent(this.table)],
    );
    if (res.rows.length === 0) {
      throw new Error(
        `pglite-client: upsert() on ${this.table} needs onConflict — the table has no primary key`,
      );
    }
    return res.rows.map((r) => r.attname);
  }

  private async runInsert(): Promise<Row[]> {
    const rows = Array.isArray(this.writeValues) ? this.writeValues : [this.writeValues!];
    if (rows.length === 0) return [];
    const cols = Object.keys(rows[0]);
    const params: unknown[] = [];
    const valueRows = rows.map(
      (row) => `(${cols.map((c) => (params.push(row[c]), `$${params.length}`)).join(", ")})`,
    );
    // PostgREST's upsert: `on conflict (<target>) do update set` EVERY supplied column to its excluded
    // value, the key columns included (a no-op for them, and it keeps a key-only payload valid SQL).
    const conflict =
      this.mode === "upsert"
        ? ` on conflict (${(this.conflictCol ? [this.conflictCol] : await this.primaryKey())
            .map(quoteIdent)
            .join(", ")}) do update set ${cols
            .map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`)
            .join(", ")}`
        : "";
    const sql =
      `insert into ${quoteIdent(this.table)} (${cols.map(quoteIdent).join(", ")})` +
      ` values ${valueRows.join(", ")}${conflict} returning *`;
    const res = await this.db.query<Row>(sql, params, { parsers: PARSERS });
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
    const res = await this.db.query<Row>(sql, params, { parsers: PARSERS });
    return res.rows;
  }

  /**
   * PostgREST's `maybeSingle`: zero rows → `data: null`; ONE row → that row; MORE than one → an error
   * (PGRST116, "JSON object requested, multiple (or no) rows returned"), because the caller asked for an
   * object and the query did not identify one. The shim used to hand back the first row silently — a
   * fidelity gap that would let a repo call which can match two rows pass here while erroring in
   * production (UIL-029 contract suite).
   */
  async maybeSingle(): Promise<{ data: Row | null; error: PostgrestLikeError | null }> {
    let rows: Row[];
    try {
      rows = await this.rows();
    } catch (err) {
      const pg = asPostgrestError(err);
      if (!pg) throw err;
      return { data: null, error: pg };
    }
    if (rows.length > 1) return { data: null, error: multipleRows(rows.length) };
    return { data: rows[0] ?? null, error: null };
  }

  then<TResult1, TResult2 = never>(
    onFulfilled?:
      | ((value: {
          data: Row[] | Row | null;
          error: PostgrestLikeError | null;
          count: number | null;
        }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    const run = this.wantHead
      ? Promise.resolve([] as Row[])
      : this.mode === "insert" || this.mode === "upsert"
        ? this.runInsert()
        : this.mode === "update"
          ? this.runUpdate()
          : this.rows();
    return (
      run
        // `async` because the count below is a second query (see its note); #119's version needed none.
        .then(async (rows) => ({
          data: this.wantHead ? null : this.wantSingle ? (rows[0] ?? null) : rows,
          // `.single()` promises exactly one row; PostgREST errors (PGRST116) on zero or several, and so
          // does this — an update that matched no row must not read as a silent success here.
          error: this.wantSingle && rows.length !== 1 ? multipleRows(rows.length) : null,
          // NOT `rows.length`: with a `range` applied that is the page size, and reporting it as the
          // total is exactly how `assertReadComplete` would be fooled into thinking a truncated read
          // was complete. Counted with the same filters and NO limit/offset, so it stays the real total.
          count: this.wantCount ? await this.total() : null,
        }))
        // A Postgres error (anything with a SQLSTATE) comes back in `error`, as supabase-js reports it —
        // never as a rejection. The shim's own refusals carry no SQLSTATE and still throw.
        .catch((err: unknown) => {
          const pg = asPostgrestError(err);
          if (!pg) throw err;
          return { data: null, error: pg, count: null };
        })
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
