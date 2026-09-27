/**
 * Every re-issue of `apply_write_ops` keeps the one before it (the composition chain).
 *
 * Each migration that changes `apply_write_ops` re-issues the WHOLE function: the previous body verbatim plus the
 * parts it marks. A migration written against an older body (a branch opened before a peer's re-issue merged) would
 * pass every one of its own tests and silently drop the newer migration's ops and rules the moment it deploys. That
 * is the stale-base class this repo has hit before, and the UIL-127 design first drafted its re-issue on 0029's body
 * while 0030 was already cleared.
 *
 * So this reads the migrations in order and requires each re-issue to contain every line of the previous one, in
 * order, once whitespace and a trailing comma are normalised. A line a migration deliberately rewrites is listed
 * below with its reason; nothing else may go missing. It needs no database and runs on every PR.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DIR = path.join(process.cwd(), "supabase", "migrations");
const HEAD = "\ncreate or replace function apply_write_ops(payload jsonb)";

/**
 * Lines of the PREVIOUS body that a migration deliberately rewrote (normalised). Add an entry only with the reason;
 * an entry for a migration not on this branch yet is harmless.
 */
const REWRITTEN: Record<string, { lines: string[]; why: string }> = {
  "0021_wishlist_slot_ops.sql": {
    lines: ["insert into placement_decision (id, haul_id, copy_id, decision, reason, resolved_by)"],
    why: "the placement_decision insert's column list was extended",
  },
  "0026_safeupdate_scoped_deletes.sql": {
    lines: ["delete from dex_presence;", "delete from dex_import;"],
    why: "whole-record deletes gained an owner WHERE (pg_safeupdate, 2026-09-26)",
  },
  "0030_line_open_closed.sql": {
    lines: ["id, binder_id, half, pocket_count, purpose, material, copy_id, line_id, created_at"],
    why: "the binder_block insert's column list gained line_slot_id (UIL-121)",
  },
  "0032_third_pocket_stays.sql": {
    lines: [
      "and ((select count(*) from line_slot s where s.line_id = l.id) >= 3",
      "or exists (select 1 from line_slot s where s.line_id = l.id and s.state <> 'filled'))",
      "select count(*) into n_block from binder_block where line_id = lid;",
    ],
    why: "the third-pocket rule no longer requires a complete line, and delete_line no longer counts energy fillers (UIL-121)",
  },
};

/** A line as SQL reads it: whitespace collapsed, a trailing comma dropped. */
const norm = (l: string) => l.trim().replace(/\s+/g, " ").replace(/,$/, "");

/** The function's body as this migration defines it, or null when the migration does not re-issue it. */
function bodyOf(sql: string): string | null {
  const at = sql.indexOf(HEAD);
  if (at < 0) return null;
  const end = sql.indexOf("\n$$;", at);
  expect(end, "apply_write_ops has no closing $$;").toBeGreaterThan(at);
  return sql.slice(at, end);
}

/** The previous body's lines missing (in order) from the next body, less the ones the next migration rewrote. */
function dropped(previous: string, next: string, rewritten: string[] = []): string[] {
  const base = previous
    .split("\n")
    .map(norm)
    .filter((l) => l && !l.startsWith("--"));
  const mine = next.split("\n").map(norm);
  const allowed = new Set(rewritten);
  const missing: string[] = [];
  let at = 0;
  for (const l of base) {
    const found = mine.indexOf(l, at);
    if (found >= 0) at = found + 1;
    else if (!allowed.has(l)) missing.push(l);
  }
  return missing;
}

const REISSUES = readdirSync(DIR)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort()
  .map((file) => ({ file, body: bodyOf(readFileSync(path.join(DIR, file), "utf8")) }))
  .filter((r): r is { file: string; body: string } => r.body !== null);

describe("apply_write_ops · each re-issue keeps the one before it", () => {
  it("there is a chain to check", () => {
    expect(REISSUES.length).toBeGreaterThanOrEqual(2);
    expect(REISSUES[0].file).toBe("0006_commit_rpc.sql");
  });

  it.each(REISSUES.slice(1).map((r, i) => [r.file, REISSUES[i].file, r.body, REISSUES[i].body]))(
    "%s keeps every line of %s",
    (file, _prev, body, previous) => {
      expect(dropped(previous, body, REWRITTEN[file]?.lines)).toEqual([]);
    },
  );

  /** The newest body, as lines, with the index of each line's normalised form counted. */
  const newest = () => {
    const lines = REISSUES[REISSUES.length - 1].body.split("\n");
    const count = new Map<string, number>();
    for (const l of lines) count.set(norm(l), (count.get(norm(l)) ?? 0) + 1);
    const unique = (i: number) =>
      !!norm(lines[i]) && !norm(lines[i]).startsWith("--") && count.get(norm(lines[i])) === 1;
    return { lines, unique };
  };

  it("ORDER is kept too: two adjacent lines swapped is caught (QA on #418)", () => {
    const { lines, unique } = newest();
    const i = lines.findIndex((_, k) => k + 1 < lines.length && unique(k) && unique(k + 1));
    expect(i).toBeGreaterThan(0);
    const swapped = [...lines];
    [swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]];
    expect(dropped(lines.join("\n"), swapped.join("\n"))).not.toEqual([]);
  });

  it("ORDER is kept too: a branch moved below the next one is caught (QA on #418)", () => {
    // The branch order carries meaning: a branch ahead of the unknown-op raise, a check appended last.
    const { lines } = newest();
    const whens = lines.flatMap((l, k) => (/^\s*when '\w+' then\s*$/.test(l) ? [k] : []));
    expect(whens.length).toBeGreaterThanOrEqual(3);
    const [a, b, c] = whens.slice(-3); // move the last-but-two branch below the last-but-one
    const moved = [
      ...lines.slice(0, a),
      ...lines.slice(b, c),
      ...lines.slice(a, b),
      ...lines.slice(c),
    ];
    expect(moved.length).toBe(lines.length);
    expect(dropped(lines.join("\n"), moved.join("\n"))).not.toEqual([]);
  });

  it("a re-issue written on an OLDER body is caught: it drops the newer lines", () => {
    // The shape the check exists for: the next migration composed on the body before the newest one.
    const [older, newest] = REISSUES.slice(-2);
    expect(dropped(newest.body, older.body).length).toBeGreaterThan(0);
  });
});
