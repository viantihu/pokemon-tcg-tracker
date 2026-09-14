/**
 * UIL-031 — `copyRepo.listUnplaced` used to detect truncation and throw; it now pages instead
 * (`lib/repo/base.ts`'s `pageFiltered`), because throwing here would lock her out of the one screen
 * (the Haul Plan) that lets her work the queue back down below the cap.
 *
 * `cappedTable` models a server that caps a bare page at `maxRows` and correctly serves a requested
 * `.range()` window up to that same cap — the shape `pageFiltered` drives. What this proves is
 * narrower than "truncation can no longer occur in production": it proves `listUnplaced` walks
 * multiple pages (tracked `.range()` calls) and that the queue's "oldest first" order — `created_at`
 * ties broken by `id` — survives intact across the page boundary, with no duplicate or skipped row.
 * `tests/support/pglite-client.ts` has no cap to model, so this cannot be re-verified against real
 * Postgres/RLS the way UIL-031's own detection could only be reasoned about, not observed, here.
 */
import { describe, expect, it } from "vitest";
import { copyRepo, type DbClient } from "@/lib/repo";

type Row = Record<string, unknown>;

function cappedTable(rows: Row[], maxRows: number) {
  const rangeCalls: [number, number][] = [];
  const filters: ((r: Row) => boolean)[] = [];
  const orderKeys: { col: string; ascending: boolean }[] = [];

  const sortedView = () => {
    const matched = rows.filter((r) => filters.every((f) => f(r)));
    return [...matched].sort((a, b) => {
      for (const { col, ascending } of orderKeys) {
        const av = String(a[col] ?? "");
        const bv = String(b[col] ?? "");
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        if (cmp !== 0) return ascending ? cmp : -cmp;
      }
      return 0;
    });
  };

  const query = {
    select() {
      return query;
    },
    eq(col: string, val: unknown) {
      filters.push((r) => r[col] === val);
      return query;
    },
    is(col: string, val: unknown) {
      filters.push((r) => (r[col] ?? null) === val);
      return query;
    },
    order(col: string, opts?: { ascending?: boolean }) {
      orderKeys.push({ col, ascending: opts?.ascending !== false });
      return query;
    },
    range(from: number, to: number) {
      rangeCalls.push([from, to]);
      const window = sortedView()
        .slice(from, to + 1)
        .slice(0, maxRows);
      return Promise.resolve({ data: window, error: null });
    },
  };

  const db = { from: () => query } as unknown as DbClient;
  return { db, rangeCalls };
}

describe("UIL-031 — copyRepo.listUnplaced pages past a single page", () => {
  it("returns every unplaced copy, in stable oldest-first order, across the page boundary", async () => {
    const COUNT = 1200;
    // created_at repeats every 24 rows so `id` genuinely has to break ties — a fixture with unique
    // timestamps would never exercise the tiebreaker the ordering contract depends on.
    const unplaced: Row[] = Array.from({ length: COUNT }, (_, i) => ({
      id: `c${String(i).padStart(5, "0")}`,
      role: "bulk",
      binder_id: null,
      line_slot_id: null,
      created_at: `2026-01-${String(1 + Math.floor(i / 24)).padStart(2, "0")}`,
    }));
    // Placed copies mixed in — the filter must still exclude them once paging is in play.
    const placed: Row[] = Array.from({ length: 15 }, (_, i) => ({
      id: `p${i}`,
      role: "shelved",
      binder_id: "b1",
      line_slot_id: null,
      created_at: "2026-01-01",
    }));
    // Stored shuffled, deterministically — an implementation that stopped ordering would still
    // "work" on an already-sorted fixture and hide the bug (UIL-015's lesson).
    const shuffled = [...placed, ...unplaced].reverse();

    const { db, rangeCalls } = cappedTable(shuffled, 1000);
    const out = await copyRepo.listUnplaced(db);

    expect(out).toHaveLength(COUNT);
    expect(out.every((r) => r.role === "bulk")).toBe(true);
    // The point of this fix: multiple pages walked, not one capped page.
    expect(rangeCalls.length).toBeGreaterThan(1);

    // Strictly non-decreasing (created_at, id) across the ENTIRE result, including the page
    // boundary at index 999/1000 — a broken tiebreaker or a re-sort-per-page bug shows up as a
    // reversal or a repeat right there, not as a missing row count.
    for (let i = 1; i < out.length; i++) {
      const prev = out[i - 1] as Row;
      const cur = out[i] as Row;
      const prevKey = `${prev.created_at} ${prev.id}`;
      const curKey = `${cur.created_at} ${cur.id}`;
      expect(curKey > prevKey).toBe(true);
    }
  });
});
