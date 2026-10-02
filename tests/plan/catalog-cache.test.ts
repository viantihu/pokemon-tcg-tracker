/**
 * The catalog cache behind per-card commits (UIL-027).
 *
 * Each "Done" click is now its own commit, and every commit builds a plan context, which pages the whole
 * ~23.5k-row mirror. On a button pressed hundreds of times in a sitting that is the cost that made the
 * per-card model unshippable.
 *
 * The equivalence bar for this work was "a scoped context must produce byte-identical placement
 * decisions to the full one". Caching rather than scoping meets that bar BY CONSTRUCTION — the same rows
 * come back, so anything derived from them is unchanged. These tests pin exactly that (the rows are the
 * same rows), plus the cache's own behaviour: freshness window, expiry, explicit invalidation, and the
 * concurrent-callers case that matters when several cards commit in quick succession on a cold instance.
 *
 * Query COUNTS, never elapsed time. `artwork.test.ts:303` is the standing example of what a wall-clock
 * assertion does on a shared runner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CATALOG_CACHE_TTL_MS,
  catalogCacheIsWarm,
  clearCatalogCache,
  loadCatalogCached,
} from "@/lib/plan";
import type { DbClient } from "@/lib/repo";

/** A fake honouring `listAllMirror`'s chain: select → eq → order → range, paged, counting requests. */
function pagingDb(rowCount: number, pageSize = 1000, standIns: Record<string, unknown>[] = []) {
  let requests = 0;
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    tcgdex_id: `card-${String(i).padStart(5, "0")}`,
    name: `Card ${i}`,
    local_id: String(i),
    dex_id: [i],
  }));
  const db = {
    from: () => {
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        order: () => q,
        // `listStandIns` awaits the query itself (no range): her own stand-ins (0033), none unless given.
        then: (resolve: (v: unknown) => void) =>
          resolve({ data: standIns, error: null, count: standIns.length }),
        range: (from: number, to: number) => {
          requests += 1;
          return Promise.resolve({
            data: rows.slice(from, Math.min(to + 1, from + pageSize)),
            error: null,
          });
        },
      };
      return q;
    },
  } as unknown as DbClient;
  return { db, requests: () => requests, rowCount };
}

beforeEach(() => {
  // Module-level state: every test starts cold, or they leak into each other.
  clearCatalogCache();
});

describe("the cache serves repeat reads without touching the database", () => {
  it("pages the mirror once, then answers from memory", async () => {
    const { db, requests } = pagingDb(2_500);

    const first = await loadCatalogCached(db);
    const afterFirst = requests();
    expect(first).toHaveLength(2_500);
    expect(afterFirst).toBeGreaterThan(1); // genuinely paged, not one request

    // Five more commits in the same sitting.
    for (let i = 0; i < 5; i++) await loadCatalogCached(db);
    expect(requests()).toBe(afterFirst);
  });

  it("returns the SAME rows from cache — which is why placement cannot change", async () => {
    const { db } = pagingDb(50);
    const fresh = await loadCatalogCached(db);
    const cached = await loadCatalogCached(db);
    // Identical content, and the same array instance: nothing is re-derived or re-shaped between
    // callers, so `toCatalogCard` and everything downstream sees exactly what it saw before.
    expect(cached).toEqual(fresh);
    expect(cached).toBe(fresh);
  });

  it("reports warmth honestly", async () => {
    const { db } = pagingDb(10);
    expect(catalogCacheIsWarm()).toBe(false);
    await loadCatalogCached(db);
    expect(catalogCacheIsWarm()).toBe(true);
  });
});

describe("staleness is bounded", () => {
  it("re-reads once the entry has expired", async () => {
    const { db, requests } = pagingDb(1_200);
    const t0 = 1_000_000;

    await loadCatalogCached(db, { now: t0 });
    const afterFirst = requests();

    // Still inside the window.
    await loadCatalogCached(db, { now: t0 + CATALOG_CACHE_TTL_MS - 1 });
    expect(requests()).toBe(afterFirst);

    // Past it — a mirror run that landed in the meantime becomes visible.
    await loadCatalogCached(db, { now: t0 + CATALOG_CACHE_TTL_MS });
    expect(requests()).toBeGreaterThan(afterFirst);
  });

  it("clearCatalogCache forces a re-read", async () => {
    const { db, requests } = pagingDb(100);
    await loadCatalogCached(db);
    const afterFirst = requests();
    clearCatalogCache();
    await loadCatalogCached(db);
    expect(requests()).toBeGreaterThan(afterFirst);
  });

  it("a fresh entry is not warm once expired", async () => {
    const { db } = pagingDb(10);
    const t0 = 5_000;
    await loadCatalogCached(db, { now: t0 });
    expect(catalogCacheIsWarm({ now: t0 })).toBe(true);
    expect(catalogCacheIsWarm({ now: t0 + CATALOG_CACHE_TTL_MS })).toBe(false);
  });
});

describe("the shared rows are read-only: frozen outside production", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("here every cached row, what it holds, and the array are frozen, so a caller's write throws", async () => {
    const { db } = pagingDb(3);
    const rows = await loadCatalogCached(db);
    expect(Object.isFrozen(rows)).toBe(true);
    expect(rows.every((r) => Object.isFrozen(r) && Object.isFrozen(r.dex_id))).toBe(true);
    expect(() => {
      (rows[0] as { name: string }).name = "Renamed";
    }).toThrow(TypeError);
    expect(() => (rows[0].dex_id as number[]).push(99)).toThrow(TypeError);
    expect(() => (rows as unknown[]).sort()).toThrow(TypeError);
    // ...and still frozen when served from memory to the next caller.
    expect(Object.isFrozen((await loadCatalogCached(db))[1])).toBe(true);
  });

  it("with her stand-ins merged in, the array she gets is frozen too (an in-place sort cannot depend on having one)", async () => {
    const { db } = pagingDb(2, 1000, [{ tcgdex_id: "user:en:x", name: "Mine", dex_id: [1] }]);
    const rows = await loadCatalogCached(db);
    expect(rows.map((r) => r.tcgdex_id)).toEqual(["card-00000", "card-00001", "user:en:x"]);
    expect(Object.isFrozen(rows)).toBe(true);
    expect(Object.isFrozen(rows[0])).toBe(true);
  });

  it("production hands out the same rows UNFROZEN: a write nothing caught never becomes a crash there", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { db } = pagingDb(2);
    const rows = await loadCatalogCached(db);
    expect(Object.isFrozen(rows)).toBe(false);
    expect(Object.isFrozen(rows[0])).toBe(false);
  });
});

describe("concurrent commits share one load", () => {
  it("does not start a second paging walk while the first is in flight", async () => {
    const { db, requests } = pagingDb(3_000);

    // Three cards committed back-to-back on a cold instance, none awaited before the next starts.
    const [a, b, c] = await Promise.all([
      loadCatalogCached(db),
      loadCatalogCached(db),
      loadCatalogCached(db),
    ]);

    expect(a).toHaveLength(3_000);
    expect(b).toBe(a);
    expect(c).toBe(a);
    // One walk of 3 pages plus the terminating empty probe — not three walks.
    expect(requests()).toBeLessThanOrEqual(4);
  });

  it("recovers from a failed load rather than caching the failure", async () => {
    let attempt = 0;
    const db = {
      from: () => {
        const q: Record<string, unknown> = {
          select: () => q,
          eq: () => q,
          order: () => q,
          then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null, count: 0 }),
          range: () => {
            attempt += 1;
            return attempt === 1
              ? Promise.resolve({ data: null, error: { message: "connection reset" } })
              : Promise.resolve({ data: [], error: null });
          },
        };
        return q;
      },
    } as unknown as DbClient;

    await expect(loadCatalogCached(db)).rejects.toThrow();
    // The in-flight promise must be cleared on failure, or every later commit inherits the rejection.
    expect(catalogCacheIsWarm()).toBe(false);
    await expect(loadCatalogCached(db)).resolves.toEqual([]);
  });
});
