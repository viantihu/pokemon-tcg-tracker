/**
 * UIL-031 — a "read everything" query must fail loudly, not silently hand back a partial list, when
 * PostgREST's server-side `max-rows` cap truncates it.
 *
 * `cappedCountingTable` below models the ONE thing this bug hinges on: the SAME request that caps
 * `data` at `maxRows` still reports the true FILTERED total via `count` when asked for
 * `{ count: "exact" }` — that is PostgREST's documented `Content-Range` behaviour, not a guess. What
 * this suite proves is that `list()` / `listWaiting()` / `listUnplaced()` react correctly to that
 * combination once it happens. It does NOT prove PostgREST actually sends that combination against a
 * live, truly-capped table — no real PostgREST server is reachable in this environment (PGlite is
 * real Postgres with no REST layer in front of it, so it has no `max-rows` or `Content-Range` to
 * model), and forcing a real 1000+-row table on Testing's Supabase project is out of scope here. See
 * the PR description for that distinction.
 */
import { describe, expect, it } from "vitest";
import { copyRepo, createRepo, unresolvedEntryRepo, type DbClient } from "@/lib/repo";

type Row = Record<string, unknown>;

/**
 * A fake table honouring `eq` / `is` / `order` (composing multiple calls, like `listUnplaced` does)
 * and reporting `count` as the FILTERED total while capping `data` at `maxRows` — the same shape
 * `list-all-paging.test.ts`'s `cappedDb` uses for `.range()`, but for the `count: "exact"` path
 * instead. Rows are supplied out of the expected order so an ordering bug shows up rather than being
 * flattered away (UIL-015's lesson).
 */
function cappedCountingTable(rows: Row[], maxRows: number) {
  const query = {
    filters: [] as ((r: Row) => boolean)[],
    orderKeys: [] as { col: string; ascending: boolean }[],
    wantCount: false,
    select(_cols: string, opts?: { count?: string }) {
      this.wantCount = opts?.count === "exact";
      return this;
    },
    eq(col: string, val: unknown) {
      this.filters.push((r) => r[col] === val);
      return this;
    },
    is(col: string, val: unknown) {
      this.filters.push((r) => (r[col] ?? null) === val);
      return this;
    },
    order(col: string, opts?: { ascending?: boolean }) {
      this.orderKeys.push({ col, ascending: opts?.ascending !== false });
      return this;
    },
    then<T>(resolve: (v: { data: Row[]; error: null; count: number | null }) => T) {
      let matched = rows.filter((r) => this.filters.every((f) => f(r)));
      for (const { col, ascending } of [...this.orderKeys].reverse()) {
        matched = [...matched].sort((a, b) => {
          const av = String(a[col] ?? "");
          const bv = String(b[col] ?? "");
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return ascending ? cmp : -cmp;
        });
      }
      const total = matched.length;
      const page = matched.slice(0, maxRows);
      return Promise.resolve({
        data: page,
        error: null,
        count: this.wantCount ? total : null,
      }).then(resolve);
    },
  };
  return { from: () => query } as unknown as DbClient;
}

describe("UIL-031 — createRepo().list() throws rather than silently truncate", () => {
  const repo = createRepo("binder");

  it("throws when the table has grown past the server's row cap", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: `b${4 - i}` })); // stored out of order
    const db = cappedCountingTable(rows, 3);
    await expect(repo.list(db)).rejects.toThrow(/truncated/i);
  });

  it("returns every row when the table is under the cap", async () => {
    const rows = [{ id: "b1" }, { id: "b2" }];
    const db = cappedCountingTable(rows, 1000);
    await expect(repo.list(db)).resolves.toHaveLength(2);
  });
});

describe("UIL-031 — unresolvedEntryRepo.listWaiting throws rather than silently truncate", () => {
  it("throws when WAITING entries alone exceed the cap, even with other statuses present", async () => {
    const waiting = Array.from({ length: 4 }, (_, i) => ({ id: `w${3 - i}`, status: "WAITING" }));
    const resolved = [{ id: "r0", status: "RESOLVED" }]; // must not count toward the cap check
    const db = cappedCountingTable([...resolved, ...waiting], 3);
    await expect(unresolvedEntryRepo.listWaiting(db)).rejects.toThrow(/truncated/i);
  });

  it("returns every WAITING entry when under the cap", async () => {
    const rows = [
      { id: "w1", status: "WAITING" },
      { id: "w2", status: "WAITING" },
      { id: "r0", status: "RESOLVED" },
    ];
    const db = cappedCountingTable(rows, 1000);
    const out = await unresolvedEntryRepo.listWaiting(db);
    expect(out.map((r) => r.id)).toEqual(["w1", "w2"]);
  });
});

describe("UIL-031 — copyRepo.listUnplaced throws rather than silently truncate", () => {
  const unplaced = (id: string, createdAt: string) => ({
    id,
    role: "bulk",
    binder_id: null,
    line_slot_id: null,
    created_at: createdAt,
  });
  const placed = { id: "p0", role: "shelved", binder_id: "b1", line_slot_id: null, created_at: "" };

  it("throws when unplaced copies alone exceed the cap, even with placed copies present", async () => {
    const rows = [
      placed,
      unplaced("u3", "2026-09-03"),
      unplaced("u1", "2026-09-01"),
      unplaced("u2", "2026-09-02"),
      unplaced("u4", "2026-09-04"),
    ];
    const db = cappedCountingTable(rows, 3);
    await expect(copyRepo.listUnplaced(db)).rejects.toThrow(/truncated/i);
  });

  it("returns every unplaced copy, oldest first, when under the cap", async () => {
    const rows = [
      placed,
      unplaced("u3", "2026-09-03"),
      unplaced("u1", "2026-09-01"),
      unplaced("u2", "2026-09-02"),
    ];
    const db = cappedCountingTable(rows, 1000);
    const out = await copyRepo.listUnplaced(db);
    expect(out.map((r) => r.id)).toEqual(["u1", "u2", "u3"]);
  });
});
