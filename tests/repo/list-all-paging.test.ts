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
function cappedDb(rowCount: number, maxRows: number) {
  const inKeyOrder = Array.from({ length: rowCount }, (_, i) => ({
    tcgdex_id: `card-${String(i).padStart(5, "0")}`,
  }));
  // Stored shuffled, deterministically: the table has no intrinsic order, so the repo must impose one.
  const rows = [...inKeyOrder].reverse();
  const ranges: [number, number][] = [];
  const selects: string[] = [];
  const orderedBy: string[] = [];

  const query = {
    select: (cols: string) => {
      selects.push(cols);
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
      return Promise.resolve({ data: window, error: null });
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
