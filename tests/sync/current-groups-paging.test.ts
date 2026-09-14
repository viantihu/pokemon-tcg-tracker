/**
 * UIL-031 follow-up — `loadCurrentGroups` (the reconciler's `current`) must page past a single
 * page's worth of rows rather than take one capped read, because a short read here is not merely
 * incomplete, it is WRONG: the reconciler would conclude she owns fewer copies than she does and add
 * duplicates for cards she already has.
 *
 * `multiCappedDb` below models a server that caps a BARE select (no `.range()`) at `maxRows` — the
 * shape `createRepo().list()` used before this fix — and correctly returns a requested `.range()`
 * window up to that same cap — the shape `listAll`/`pageAll` uses. What this proves is narrower than
 * "truncation can no longer occur in production": it proves `loadCurrentGroups` actually walks
 * multiple pages (tracked via `rangeCallsByTable`) and the join across a page boundary still finds
 * the right copies for the right group. `tests/support/pglite-client.ts` has no cap at all, so this
 * cannot be re-verified against real Postgres/RLS the way UIL-031's own detection could only be
 * reasoned about, not observed, in this environment.
 */
import { describe, expect, it } from "vitest";
import type { DbClient } from "@/lib/repo";
import { loadCurrentGroups } from "@/lib/sync/pipeline";

type Row = Record<string, unknown>;

function multiCappedDb(tables: Record<string, { rows: Row[]; maxRows: number }>) {
  // Populated up front — `.from(table)` is called fresh on EVERY page `pageAll` walks, so this must
  // accumulate across calls rather than being reset inside `makeQuery`.
  const rangeCallsByTable: Record<string, [number, number][]> = {};
  for (const table of Object.keys(tables)) rangeCallsByTable[table] = [];

  function makeQuery(table: string, rows: Row[], maxRows: number) {
    let wantCount = false;
    const orderedBy: string[] = [];

    const sortedView = () =>
      orderedBy.length
        ? [...rows].sort((a, b) => {
            for (const k of orderedBy) {
              const av = String(a[k] ?? "");
              const bv = String(b[k] ?? "");
              if (av < bv) return -1;
              if (av > bv) return 1;
            }
            return 0;
          })
        : rows;

    const query = {
      select(_cols: string, opts?: { count?: string }) {
        wantCount = opts?.count === "exact";
        return query;
      },
      order(col: string) {
        orderedBy.push(col);
        return query;
      },
      range(from: number, to: number) {
        rangeCallsByTable[table].push([from, to]);
        const window = sortedView()
          .slice(from, to + 1)
          .slice(0, maxRows);
        return Promise.resolve({ data: window, error: null, count: null });
      },
      then<T>(resolve: (v: { data: Row[]; error: null; count: number | null }) => T) {
        // A bare select (no .range()) — the shape a pre-fix list() call takes — hits the cap.
        const page = sortedView().slice(0, maxRows);
        return Promise.resolve({
          data: page,
          error: null,
          count: wantCount ? rows.length : null,
        }).then(resolve);
      },
    };
    return query;
  }

  const db = {
    from: (table: string) => {
      const t = tables[table];
      if (!t) throw new Error(`multiCappedDb: no fixture registered for table "${table}"`);
      return makeQuery(table, t.rows, t.maxRows);
    },
  } as unknown as DbClient;

  return { db, rangeCallsByTable };
}

describe("UIL-031 follow-up — loadCurrentGroups pages past a single page", () => {
  it("returns every presence group and copy across the page boundary, not just the first page", async () => {
    const GROUP_COUNT = 1200;
    // Stored out of primary-key order, like list-all-paging.test.ts's cappedDb — a listAll that
    // stopped ordering by pk would still "work" on an in-order fixture and hide the bug.
    const groups: Row[] = Array.from({ length: GROUP_COUNT }, (_, i) => {
      const n = GROUP_COUNT - 1 - i;
      return {
        id: `g${String(n).padStart(5, "0")}`,
        catalog_card_id: `card-${n}`,
        dex_variant_raw: "Normal",
      };
    });
    const copies: Row[] = groups.map((g, i) => ({
      id: `c${String(GROUP_COUNT - 1 - i).padStart(5, "0")}`,
      presence_group_id: g.id,
      role: "shelved",
      binder_id: "b1",
      binder_half: "front",
      color_band: "red",
      line_slot_id: null,
      created_at: "2026-01-01",
    }));

    const { db, rangeCallsByTable } = multiCappedDb({
      presence_group: { rows: groups, maxRows: 1000 },
      copy: { rows: copies, maxRows: 1000 },
    });

    const out = await loadCurrentGroups(db);

    expect(out).toHaveLength(GROUP_COUNT);
    // The point of this fix: both reads actually walked MULTIPLE pages, not one capped page.
    expect(rangeCallsByTable.presence_group.length).toBeGreaterThan(1);
    expect(rangeCallsByTable.copy.length).toBeGreaterThan(1);
    // A group whose row only exists past the first page still finds its copy — the join survives
    // the page boundary, not just the row count.
    const lastGroup = out.find((g) => g.catalogCardId === `card-${GROUP_COUNT - 1}`);
    expect(lastGroup?.copies).toHaveLength(1);
    expect(lastGroup?.copies[0]?.binderId).toBe("b1");
  });
});
