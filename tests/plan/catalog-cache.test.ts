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
import { chainFor } from "@/lib/engine";
import {
  CATALOG_CACHE_TTL_MS,
  catalogCacheIsWarm,
  catalogCardsOf,
  clearCatalogCache,
  loadCatalogCached,
  toCatalogCard,
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

/* ------------------------- her catalog keeps its identity (the TL's profile, 2026-10-02) ------------------------- */

/**
 * Every per-catalog index the engine keeps is a WeakMap keyed by the catalog ARRAY, so a new array per request was a
 * cold index per request. These pin when the array is the same one and when it must not be.
 */
describe("her merged catalog is the same array while nothing changed, and a new one when anything did", () => {
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const standIn = (owner: string, n: number, name = `Mine ${n}`) => ({
    tcgdex_id: `user:en:${owner.slice(0, 8)}-${n}`,
    name,
    dex_id: [5],
    evolve_from: "Charmander",
    types: ["Fire"],
    variants: { normal: true },
    source: "user",
    owner_id: owner,
    is_digital_only: false,
  });

  /** The mirror, paged, and each owner's stand-ins, read FRESH (new objects) on every call, as a real read is. */
  function ownersDb(mirrorCount: number) {
    let mirrorRows = Array.from({ length: mirrorCount }, (_, i) => ({
      tcgdex_id: `card-${String(i).padStart(5, "0")}`,
      name: i % 2 === 0 ? "Charmander" : "Charmeleon",
      dex_id: [4 + (i % 2)],
      evolve_from: i % 2 === 0 ? null : "Charmander",
      types: ["Fire"],
      variants: { normal: true },
      source: "tcgdex",
      owner_id: null,
      is_digital_only: false,
    }));
    const theirs = new Map<string, Record<string, unknown>[]>([
      [A, []],
      [B, []],
    ]);
    /** When set, the next stand-in read waits for it: a request still reading while another reloads the mirror. */
    let hold: Promise<void> | null = null;
    const client = (owner: string) =>
      ({
        from: () => {
          const q: Record<string, unknown> = {
            select: () => q,
            eq: () => q,
            order: () => q,
            then: (resolve: (v: unknown) => void) => {
              const rows = structuredClone(theirs.get(owner) ?? []);
              const gate = hold;
              hold = null;
              const answer = () => resolve({ data: rows, error: null, count: rows.length });
              if (gate) void gate.then(answer);
              else answer();
            },
            range: (from: number, to: number) =>
              Promise.resolve({ data: mirrorRows.slice(from, to + 1), error: null }),
          };
          return q;
        },
      }) as unknown as DbClient;
    return {
      as: client,
      theirs,
      /** The mirror job lands a card: the next mirror load reads it. */
      mirrorGains: (id: string) => {
        mirrorRows = [...mirrorRows, { ...mirrorRows[0], tcgdex_id: id }];
      },
      /** Hold the next stand-in read open until the returned release is called. */
      holdNextStandInRead: () => {
        let release!: () => void;
        hold = new Promise<void>((r) => (release = r));
        return release;
      },
    };
  }

  it("with her stand-ins read back the same, every call hands back the same array", async () => {
    const { as, theirs } = ownersDb(4);
    theirs.set(A, [standIn(A, 1), standIn(A, 2)]);
    const first = await loadCatalogCached(as(A));
    const second = await loadCatalogCached(as(A));
    expect(first.map((r) => r.tcgdex_id)).toEqual([
      "card-00000",
      "card-00001",
      "card-00002",
      "card-00003",
      `user:en:${A.slice(0, 8)}-1`,
      `user:en:${A.slice(0, 8)}-2`,
    ]);
    expect(second).toBe(first);
    // ...and so the card array the engine reads, and every index keyed by it.
    expect(catalogCardsOf(second)).toBe(catalogCardsOf(first));
  });

  it("a stand-in added, edited or removed makes a new array, holding exactly what she has now", async () => {
    const { as, theirs } = ownersDb(2);
    theirs.set(A, [standIn(A, 1)]);
    const before = await loadCatalogCached(as(A));

    theirs.set(A, [standIn(A, 1), standIn(A, 2)]);
    const added = await loadCatalogCached(as(A));
    expect(added).not.toBe(before);
    expect(added.map((r) => r.tcgdex_id)).toContain(`user:en:${A.slice(0, 8)}-2`);

    // The same id, one column changed: a signature of ids alone would miss this.
    theirs.set(A, [standIn(A, 1), standIn(A, 2, "Renamed")]);
    const edited = await loadCatalogCached(as(A));
    expect(edited).not.toBe(added);
    expect(edited.at(-1)?.name).toBe("Renamed");

    theirs.set(A, [standIn(A, 2, "Renamed")]);
    const removed = await loadCatalogCached(as(A));
    expect(removed).not.toBe(edited);
    expect(removed.map((r) => r.tcgdex_id)).not.toContain(`user:en:${A.slice(0, 8)}-1`);
    expect(await loadCatalogCached(as(A))).toBe(removed);
  });

  it("an owner with no stand-ins left gets the mirror itself, as before", async () => {
    const { as, theirs } = ownersDb(2);
    theirs.set(A, [standIn(A, 1)]);
    const mine = await loadCatalogCached(as(A));
    theirs.set(A, []);
    const none = await loadCatalogCached(as(A));
    expect(none).not.toBe(mine);
    expect(none).toBe(await loadCatalogCached(as(B)));
    expect(none.map((r) => r.tcgdex_id)).toEqual(["card-00000", "card-00001"]);
  });

  it("a new mirror load makes a new array: after it expires, and after the cache is cleared", async () => {
    const { as, theirs } = ownersDb(2);
    theirs.set(A, [standIn(A, 1)]);
    const t0 = 1_000_000;
    const first = await loadCatalogCached(as(A), { now: t0 });
    expect(await loadCatalogCached(as(A), { now: t0 + CATALOG_CACHE_TTL_MS - 1 })).toBe(first);
    const reloaded = await loadCatalogCached(as(A), { now: t0 + CATALOG_CACHE_TTL_MS });
    expect(reloaded).not.toBe(first);
    expect(reloaded).toEqual(first);
    clearCatalogCache();
    expect(await loadCatalogCached(as(A), { now: t0 + CATALOG_CACHE_TTL_MS })).not.toBe(reloaded);
  });

  it("a request that read the mirror before a reload never hands its catalog to one after it", async () => {
    const { as, theirs, mirrorGains, holdNextStandInRead } = ownersDb(2);
    theirs.set(A, [standIn(A, 1)]);
    const t0 = 1_000_000;
    await loadCatalogCached(as(A), { now: t0 });
    // Her request reads the cached mirror, and is still reading her stand-ins...
    const release = holdNextStandInRead();
    const slow = loadCatalogCached(as(A), { now: t0 + 1 });
    // ...while another request finds the entry expired and loads the mirror again, with a new card in it.
    mirrorGains("card-new");
    await loadCatalogCached(as(B), { now: t0 + CATALOG_CACHE_TTL_MS });
    release();
    const old = await slow;
    expect(old.map((r) => r.tcgdex_id)).not.toContain("card-new");
    // Her next request is on the new load: a catalog made from the one before is not hers to keep.
    const next = await loadCatalogCached(as(A), { now: t0 + CATALOG_CACHE_TTL_MS });
    expect(next).not.toBe(old);
    expect(next.map((r) => r.tcgdex_id)).toContain("card-new");
  });

  it("two owners never share an array, whoever reads first, and each keeps her own while unchanged", async () => {
    for (const [first, second] of [
      [A, B],
      [B, A],
    ]) {
      clearCatalogCache();
      const { as, theirs } = ownersDb(2);
      theirs.set(A, [standIn(A, 1)]);
      theirs.set(B, [standIn(B, 1)]);
      const x1 = await loadCatalogCached(as(first));
      const y1 = await loadCatalogCached(as(second));
      const x2 = await loadCatalogCached(as(first));
      const y2 = await loadCatalogCached(as(second));
      expect(y1).not.toBe(x1);
      expect(x2).toBe(x1);
      expect(y2).toBe(y1);
      const idsOf = (rows: readonly { tcgdex_id: string }[]) => rows.map((r) => r.tcgdex_id);
      expect(idsOf(x1)).toContain(`user:en:${first.slice(0, 8)}-1`);
      expect(idsOf(x1)).not.toContain(`user:en:${second.slice(0, 8)}-1`);
      expect(idsOf(y1)).toContain(`user:en:${second.slice(0, 8)}-1`);
      expect(idsOf(y1)).not.toContain(`user:en:${first.slice(0, 8)}-1`);
      // The mirror's cards are made once and shared by both; each owner's own are hers.
      const xc = catalogCardsOf(x1);
      const yc = catalogCardsOf(y1);
      expect(yc[0]).toBe(xc[0]);
      expect(yc.at(-1)).not.toBe(xc.at(-1));
    }
  });

  it("the engine reads the same cards a fresh adaptation would make, and its chain carries over between requests", async () => {
    const { as, theirs } = ownersDb(6);
    theirs.set(A, [standIn(A, 1)]);
    const rows = await loadCatalogCached(as(A));
    const cards = catalogCardsOf(rows);
    expect(cards).toEqual(rows.map(toCatalogCard));
    const charmeleon = cards.find((c) => c.tcgdexId === "card-00001")!;
    const chain = chainFor(charmeleon, cards);
    expect(chain.map((n) => n.dexId)).toEqual([4, 5]);
    // The next request: a new read of her stand-ins, the same catalog, the same chain object (not rebuilt).
    const next = catalogCardsOf(await loadCatalogCached(as(A)));
    expect(
      chainFor(
        next.find((c) => c.tcgdexId === "card-00001")!,
        next,
      ),
    ).toBe(chain);
  });

  it("her shared rows and cards are frozen outside production, and left unfrozen in it", async () => {
    const { as, theirs } = ownersDb(2);
    theirs.set(A, [standIn(A, 1)]);
    const rows = await loadCatalogCached(as(A));
    const cards = catalogCardsOf(rows);
    expect(Object.isFrozen(rows.at(-1))).toBe(true);
    expect(Object.isFrozen(cards)).toBe(true);
    expect(cards.every((c) => Object.isFrozen(c) && Object.isFrozen(c.variants))).toBe(true);
    expect(() => {
      (cards[0] as { name: string }).name = "Renamed";
    }).toThrow(TypeError);

    vi.stubEnv("NODE_ENV", "production");
    try {
      clearCatalogCache();
      const prodRows = await loadCatalogCached(as(A));
      const prodCards = catalogCardsOf(prodRows);
      expect(Object.isFrozen(prodRows)).toBe(false);
      expect(Object.isFrozen(prodCards)).toBe(false);
      expect(Object.isFrozen(prodCards.at(-1))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
