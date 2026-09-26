/**
 * No DELETE or UPDATE without a WHERE clause in the live body of any function the migrations define.
 *
 * Supabase loads pg_safeupdate for PostgREST sessions. It refuses such a statement ("DELETE requires a WHERE
 * clause", SQLSTATE 21000), even inside a function and even on a table RLS already scopes, because it checks the
 * statement as written, before RLS adds its filter. The PGlite harness does not load it, so 0022's three
 * whole-record deletes passed every test and then failed every import on Testing (2026-09-26, fixed in 0026).
 * This reads each function's LAST definition (the one that runs; older migrations are frozen and superseded)
 * and refuses the shape before it ships. Migration-time statements outside a function, like 0012's one-off
 * backfill, run as `postgres` over a direct connection without pg_safeupdate, so they are not checked.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DIR = path.join(process.cwd(), "supabase", "migrations");
const FILES = readdirSync(DIR)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort();

/** Every `create [or replace] function name(args) … as $tag$ body $tag$` in a migration, in order. */
function functionBodies(sql: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re =
    /create\s+(?:or\s+replace\s+)?function\s+([\w."]+)\s*\(([^)]*)\)[\s\S]*?\bas\s+(\$\w*\$)([\s\S]*?)\3/gi;
  for (const m of sql.matchAll(re)) {
    const args = m[2].replace(/\s+/g, " ").trim().toLowerCase();
    out.push({ name: `${m[1].replace(/"/g, "").toLowerCase()}(${args})`, body: m[4] });
  }
  return out;
}

/**
 * The body with comments and string literals blanked, so neither can hide or fake a keyword or a `;`. One
 * left-to-right pass: an apostrophe inside a comment ("the caller's rows") must not open a string, and `--`
 * inside a string must not open a comment.
 */
function code(body: string): string {
  let out = "";
  for (let i = 0; i < body.length;) {
    if (body.startsWith("--", i)) {
      const end = body.indexOf("\n", i);
      i = end < 0 ? body.length : end;
    } else if (body.startsWith("/*", i)) {
      const end = body.indexOf("*/", i + 2);
      i = end < 0 ? body.length : end + 2;
      out += " ";
    } else if (body[i] === "'") {
      let j = i + 1;
      while (j < body.length && !(body[j] === "'" && body[j + 1] !== "'"))
        j += body[j] === "'" ? 2 : 1;
      i = j + 1;
      out += "''";
    } else {
      out += body[i++];
    }
  }
  return out;
}

/** Each DELETE / UPDATE statement in a body that has no WHERE clause, as its first line. */
export function unscopedWrites(body: string): string[] {
  const bad: string[] = [];
  for (const raw of code(body).split(";")) {
    const st = raw.replace(/\s+/g, " ").trim();
    // `update <table> set`, never `on conflict … do update set` (an upsert is an INSERT to pg_safeupdate).
    const write =
      /\b(delete\s+from\s+[\w."]+|update\s+(?!set\b)[\w."]+(?:\s+(?:as\s+)?\w+)?\s+set)\b/i.exec(
        st,
      );
    if (!write) continue;
    if (!/\bwhere\b/i.test(st.slice(write.index)))
      bad.push(st.slice(write.index, write.index + 80));
  }
  return bad;
}

/** The body each function runs today: its last definition across the migrations, in order. */
function liveBodies(files = FILES): Map<string, { file: string; body: string }> {
  const live = new Map<string, { file: string; body: string }>();
  for (const f of files) {
    for (const fn of functionBodies(readFileSync(path.join(DIR, f), "utf8"))) {
      live.set(fn.name, { file: f, body: fn.body });
    }
  }
  return live;
}

describe("every function the migrations define writes only WHERE-scoped rows", () => {
  it("finds the functions (so an empty scan cannot pass)", () => {
    const live = liveBodies();
    expect([...live.keys()]).toContain("apply_write_ops(payload jsonb)");
    expect(live.size).toBeGreaterThanOrEqual(5);
    expect(live.get("apply_write_ops(payload jsonb)")!.file).toBe(
      FILES.filter((f) =>
        /create or replace function apply_write_ops/.test(readFileSync(path.join(DIR, f), "utf8")),
      ).at(-1),
    );
  });

  it("no live function body has a DELETE or UPDATE without WHERE", () => {
    const found = [...liveBodies()].flatMap(([name, { file, body }]) =>
      unscopedWrites(body).map((s) => `${file} ${name}: ${s}`),
    );
    expect(found).toEqual([]);
  });

  it("would have caught the 2026-09-26 failure: 0024's live body has exactly the three unscoped deletes", () => {
    const before = liveBodies(FILES.filter((f) => f < "0026"));
    const { file, body } = before.get("apply_write_ops(payload jsonb)")!;
    expect(file).toBe("0024_file_total_check.sql");
    expect(unscopedWrites(body)).toEqual([
      "delete from dex_presence",
      "delete from dex_presence",
      "delete from dex_import",
    ]);
  });
});

describe("the guard itself", () => {
  it.each([
    ["an unscoped delete", "delete from t;"],
    ["an unscoped update", "update t set a = 1;"],
    ["an aliased update", "update t as x set a = 1;"],
    ["a WHERE only in a comment", "delete from t -- where id = 1\n;"],
    ["a WHERE only in a string", "update t set note = 'where';"],
    ["a statement after a comment with an apostrophe", "-- the caller's rows\ndelete from t;"],
  ])("refuses %s", (_, body) => {
    expect(unscopedWrites(body)).toHaveLength(1);
  });

  it.each([
    ["a scoped delete", "delete from t where id = 1;"],
    ["a scoped update", "update t set a = 1 where id = 2;"],
    ["an update … from … where", "update t set a = u.a from u where u.id = t.id;"],
    ["a delete … using … where", "delete from t using u where u.id = t.id;"],
    ["an upsert", "insert into t (a) values (1) on conflict (a) do update set a = excluded.a;"],
    ["a select", "select count(*) from t;"],
    [
      "a scoped delete after a string with an escaped quote",
      "raise notice 'it''s';\ndelete from t where id = 1;",
    ],
  ])("allows %s", (_, body) => {
    expect(unscopedWrites(body)).toEqual([]);
  });
});
