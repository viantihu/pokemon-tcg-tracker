/**
 * `listAll` pages past PostgREST's server-side `max-rows` cap.
 *
 * Why this matters right now: the catalog mirror is ~23.5k rows, and every full-table `select *` is
 * capped at the project's `max-rows` (1000 on Supabase by default) with NO error — the response just
 * stops. `loadPlanContext` reads the whole catalog for chain-building, viability and alternate ranking
 * (lib/plan/context.ts), so a truncated read would quietly plan against 4% of the catalog: wrong lines,
 * wrong alternates, no failure anywhere. Populating the Testing mirror (UIL-004) is exactly what makes
 * that live, so the paged read ships with it.
 *
 * The cap is modelled explicitly here, including the case where it is SMALLER than the page size —
 * which is why the loop advances by rows received rather than rows requested.
 */
import { describe, expect, it } from "vitest";
import { createRepo, type DbClient } from "@/lib/repo";
import { pageFiltered } from "@/lib/repo/base";

/**
 * A fake table that honours `range()`, truncates at `maxRows` like PostgREST — and ORDERS.
 *
 * `order()` used to be a no-op here, which made this suite unable to notice if `listAll` stopped
 * ordering by primary key. That matters: paging is only coherent over a STABLE window, so without the
 * `.order(pk)` the walk can repeat or skip rows between requests. The rows below are therefore stored
 * deliberately OUT of key order, so a fake that ignores `order` — or a `listAll` that stops calling it
 * — produces a visibly wrong walk instead of an accidentally correct one. (UIL-015's lesson: a double
 * that flatters the code under test certifies the wrong behaviour.)
 */
function cappedDb(rowCount: number, maxRows: number, opts: { counts?: boolean } = {}) {
  const inKeyOrder = Array.from({ length: rowCount }, (_, i) => ({
    tcgdex_id: `card-${String(i).padStart(5, "0")}`,
  }));
  // Stored shuffled, deterministically: the table has no intrinsic order, so the repo must impose one.
  const rows = [...inKeyOrder].reverse();
  const ranges: [number, number][] = [];
  const selects: string[] = [];
  const orderedBy: string[] = [];
  /** Whether the request in flight asked for the true total (`count: "exact"`), as PostgREST is asked. */
  let wantsCount = false;

  const query = {
    select: (cols: string, options?: { count?: "exact" }) => {
      selects.push(cols);
      wantsCount = options?.count === "exact";
      return query;
    },
    order: (col: string) => {
      orderedBy.push(col);
      return query;
    },
    range(from: number, to: number) {
      ranges.push([from, to]);
      // Compose the requested order keys, code-unit comparison (Postgres, not `localeCompare`).
      const sorted = orderedBy.length
        ? [...rows].sort((a, b) => {
            for (const key of orderedBy) {
              const av = String((a as Record<string, unknown>)[key]);
              const bv = String((b as Record<string, unknown>)[key]);
              if (av < bv) return -1;
              if (av > bv) return 1;
            }
            return 0;
          })
        : rows;
      const window = sorted.slice(from, to + 1).slice(0, maxRows);
      // A server that counts (`opts.counts`, as PostgREST does) reports the true total, whatever the cap let through.
      const count = opts.counts && wantsCount ? rows.length : null;
      return Promise.resolve({ data: window, error: null, count });
    },
  };
  return {
    db: { from: () => query } as unknown as DbClient,
    ranges,
    selects,
    orderedBy,
    ids: inKeyOrder.map((r) => r.tcgdex_id),
  };
}

const catalogRepo = createRepo("catalog_card", "tcgdex_id");

describe("createRepo().listAll", () => {
  it("returns EVERY row for a table far larger than one page", async () => {
    const { db, ids } = cappedDb(23_500, 1000);
    const out = await catalogRepo.listAll(db);
    expect(out).toHaveLength(23_500);
    expect(out.map((r) => r.tcgdex_id)).toEqual(ids);
  });

  it("still returns everything when the server cap is SMALLER than the requested page size", async () => {
    // Requesting 1000 but only ever getting 250 back: a fixed 1000-row stride would skip 750 each time.
    const { db, ids } = cappedDb(1_030, 250);
    const out = await catalogRepo.listAll(db, 1000);
    expect(out.map((r) => r.tcgdex_id)).toEqual(ids);
  });

  it("walks contiguous windows and stops on the first empty page", async () => {
    const { db, ranges } = cappedDb(2_500, 1000);
    await catalogRepo.listAll(db, 1000);
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
      [2500, 3499], // the probe that comes back empty and ends the walk
    ]);
  });

  it("handles an exact multiple of the page size (one extra empty probe, no duplicates)", async () => {
    const { db, ids } = cappedDb(2_000, 1000);
    const out = await catalogRepo.listAll(db, 1000);
    expect(out.map((r) => r.tcgdex_id)).toEqual(ids);
  });

  it("returns [] for an empty table", async () => {
    const { db } = cappedDb(0, 1000);
    expect(await catalogRepo.listAll(db)).toEqual([]);
  });
});

describe("createRepo().listAll ends on the server's count: no empty probe, so no round trip over `list`", () => {
  it("a table that fits one page is ONE request, as a single-page `list` was", async () => {
    const { db, ranges, ids } = cappedDb(695, 1000, { counts: true });
    const out = await catalogRepo.listAll(db);
    expect(out.map((r) => r.tcgdex_id)).toEqual(ids);
    expect(ranges).toEqual([[0, 999]]);
  });

  it("a bigger table pages to its count and stops there", async () => {
    const { db, ranges } = cappedDb(2_500, 1000, { counts: true });
    expect(await catalogRepo.listAll(db, 1000)).toHaveLength(2_500);
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("still returns everything when the cap is smaller than the page: the count is the total, not the page", async () => {
    const { db, ids } = cappedDb(1_030, 250, { counts: true });
    expect((await catalogRepo.listAll(db, 1000)).map((r) => r.tcgdex_id)).toEqual(ids);
  });

  it("an empty table is one request", async () => {
    const { db, ranges } = cappedDb(0, 1000, { counts: true });
    expect(await catalogRepo.listAll(db)).toEqual([]);
    expect(ranges).toHaveLength(1);
  });
});

describe("pageFiltered ends on a page's count too", () => {
  it("one request for a filtered read that fits one page; without a count, the empty probe as before", async () => {
    const calls: [number, number][] = [];
    const page = (withCount: boolean) => (from: number, to: number) => {
      calls.push([from, to]);
      const all = Array.from({ length: 12 }, (_, i) => ({ id: i }));
      return Promise.resolve({
        data: all.slice(from, to + 1),
        error: null,
        count: withCount ? all.length : null,
      });
    };
    expect(await pageFiltered("t", page(true))).toHaveLength(12);
    expect(calls).toEqual([[0, 999]]);
    calls.length = 0;
    expect(await pageFiltered("t", page(false))).toHaveLength(12);
    expect(calls).toEqual([
      [0, 999],
      [12, 1011],
    ]);
  });
});

describe("createRepo().listAllFields", () => {
  it("pages the whole table like listAll, but projects only the named columns", async () => {
    const { db, ids, selects } = cappedDb(2_500, 1000);
    const out = await catalogRepo.listAllFields(db, ["tcgdex_id"]);
    expect(out.map((r) => r.tcgdex_id)).toEqual(ids);
    // Every page requested exactly the projection, never `select *` — that is the whole point.
    expect(selects.every((s) => s === "tcgdex_id")).toBe(true);
  });

  it("joins multiple columns into one PostgREST projection", async () => {
    const { db, selects } = cappedDb(10, 1000);
    await catalogRepo.listAllFields(db, ["tcgdex_id", "name"]);
    expect(selects[0]).toBe("tcgdex_id,name");
  });
});
