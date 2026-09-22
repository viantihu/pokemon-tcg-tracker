/**
 * Batched catalog lookups must be BYTE-IDENTICAL to the serial ones (sync perf).
 *
 * The sync resolved ~685 rows with one awaited round trip per localId candidate — the 20–35 seconds
 * she waits on an import. The tempting fix is to fire them concurrently or fold them into one
 * `in`-list, and that would be a correctness regression wearing the costume of a speedup:
 * `resolveAgainstCatalog` has an INTRA-PASS DATA DEPENDENCY. On a set-code miss it resolves the set by
 * name, learns an alias, caches it in `sessionAliases`, and every LATER row of that set then resolves
 * through the alias instead of the name path ("one match drains the set"). Fired concurrently, none of
 * the siblings would see it, and the answer could depend on scheduling.
 *
 * So the algorithm is untouched and only the PORT changed. These tests hold it to that:
 *
 *   - identical results, row for row, serial vs prefetched — over an export whose set code must be
 *     NAME-RESOLVED, because an export whose sets are all already aliased would pass while proving
 *     nothing;
 *   - the drain still drains in the prefetched path;
 *   - a key absent from the index is only treated as absent when it was actually prefetched;
 *   - and far fewer queries, asserted as a COUNT of calls rather than as elapsed time. No timing
 *     assertions: `artwork.test.ts` already shows what a wall-clock bound does on a shared runner.
 */
import { describe, expect, it } from "vitest";
import {
  buildCatalogPrefetch,
  prefetchedCatalogPort,
  resolveAgainstCatalog,
  type CatalogLookupResult,
  type CatalogPort,
} from "@/lib/sync/catalog-lookup";
import { resolveDexId, SET_ALIAS_SEED } from "@/lib/sync/resolve";
import type { DbClient } from "@/lib/repo";

/**
 * A fake mirror. `me06` is the real TCGdex set id; the Dex export calls it `me6`, which is NOT in the
 * alias seed — so it can only be reached by name resolution, which is the case that matters.
 */
const CARDS: Record<string, { tcgdexId: string }[]> = {
  "me06:014": [{ tcgdexId: "me06-014" }],
  "me06:020": [{ tcgdexId: "me06-020" }],
  "sv03:026": [{ tcgdexId: "sv03-026" }],
  "sv03:027": [{ tcgdexId: "sv03-027" }],
};

const SET_NAMES: Record<string, string[]> = { "Mega Brave": ["me06"] };

interface Counting extends CatalogPort {
  calls: {
    findBySetLocal: number;
    findSetIdsByName: number;
    learnAlias: number;
    findSetIdsFoldingCase: number;
  };
}

function countingPort(): Counting {
  const calls = {
    findBySetLocal: 0,
    findSetIdsByName: 0,
    learnAlias: 0,
    findSetIdsFoldingCase: 0,
  };
  return {
    calls,
    async findBySetLocal(setId, localId) {
      calls.findBySetLocal += 1;
      return CARDS[`${setId}:${localId}`] ?? [];
    },
    async findSetIdsByName(setName) {
      calls.findSetIdsByName += 1;
      return SET_NAMES[setName] ?? [];
    },
    async findSetIdsFoldingCase(setId) {
      calls.findSetIdsFoldingCase += 1;
      const want = setId.toLowerCase();
      return [...new Set(Object.keys(CARDS).map((k) => k.split(":")[0]))].filter(
        (id) => id.toLowerCase() === want,
      );
    },
    async learnAlias() {
      calls.learnAlias += 1;
    },
  };
}

/** The export under test: two rows of a name-resolvable unknown set, plus two ordinary rows. */
const ROWS = [
  { Id: "me6-14", Locale: "English", Set: "Mega Brave" },
  { Id: "sv03-26", Locale: "English", Set: "Obsidian Flames" },
  { Id: "me6-20", Locale: "English", Set: "Mega Brave" }, // the sibling the drain must reach
  { Id: "sv03-27", Locale: "English", Set: "Obsidian Flames" },
];

/** Walk the rows exactly as the pipeline does: one at a time, one shared sessionAliases map. */
async function runPass(port: CatalogPort): Promise<CatalogLookupResult[]> {
  const sessionAliases = new Map<string, string>();
  const out: CatalogLookupResult[] = [];
  for (const r of ROWS) {
    const resolved = resolveDexId({ Id: r.Id, Locale: r.Locale }, SET_ALIAS_SEED);
    out.push(await resolveAgainstCatalog(port, { Set: r.Set }, resolved, sessionAliases));
  }
  return out;
}

/** Build the prefetch the pipeline would build, from the same rows. */
function prefetchFor(rows: typeof ROWS) {
  const index = new Map<string, { tcgdexId: string }[]>();
  const fetched = new Set<string>();
  for (const r of rows) {
    const resolved = resolveDexId({ Id: r.Id, Locale: r.Locale }, SET_ALIAS_SEED);
    for (const c of resolved.localIdCandidates) {
      const k = `${resolved.setId}:${c}`;
      fetched.add(k);
      if (CARDS[k]) index.set(k, CARDS[k]);
    }
  }
  return { index, fetched };
}

describe("prefetched lookups match serial ones exactly", () => {
  it("produces identical results over an export that must NAME-RESOLVE a set code", async () => {
    const serial = await runPass(countingPort());

    const { index, fetched } = prefetchFor(ROWS);
    const batched = await runPass(prefetchedCatalogPort(countingPort(), index, fetched));

    expect(batched).toEqual(serial);
    // Sanity: this export really does exercise the path in question, otherwise the equality is vacuous.
    expect(serial[0].learnedAlias).toEqual({
      locale: "en",
      dexCode: "me6",
      tcgdexSetId: "me06",
    });
    expect(serial.map((r) => r.catalogCardId)).toEqual([
      "me06-014",
      "sv03-026",
      "me06-020",
      "sv03-027",
    ]);
  });

  it("still drains the set within the pass — the sibling resolves without its own name lookup", async () => {
    const { index, fetched } = prefetchFor(ROWS);
    const port = countingPort();
    const results = await runPass(prefetchedCatalogPort(port, index, fetched));

    // Row 3 is the sibling. It resolved, and the alias was learned exactly once for the whole set.
    expect(results[2].catalogCardId).toBe("me06-020");
    expect(port.calls.learnAlias).toBe(1);
    // The name was looked up once, not once per row of that set (memoized in the port).
    expect(port.calls.findSetIdsByName).toBe(1);
  });

  it("cuts the per-row round trips", async () => {
    const serialPort = countingPort();
    await runPass(serialPort);

    const { index, fetched } = prefetchFor(ROWS);
    const batchedPort = countingPort();
    await runPass(prefetchedCatalogPort(batchedPort, index, fetched));

    // Only the mid-pass retries against the learned set can still hit the wire.
    expect(batchedPort.calls.findBySetLocal).toBeLessThan(serialPort.calls.findBySetLocal);
  });
});

describe("the prefetch never invents an absence", () => {
  it("falls through to a live query for a key it did not prefetch", async () => {
    const port = countingPort();
    // Index and fetched are both empty: nothing is known, so nothing may be assumed.
    const wrapped = prefetchedCatalogPort(port, new Map(), new Set());
    expect(await wrapped.findBySetLocal("sv03", "026")).toEqual([{ tcgdexId: "sv03-026" }]);
    expect(port.calls.findBySetLocal).toBe(1);
  });

  it("trusts an empty result ONLY for a key that was actually prefetched", async () => {
    const port = countingPort();
    // "sv03:999" was asked for and genuinely has no card — that absence is knowledge.
    const wrapped = prefetchedCatalogPort(port, new Map(), new Set(["sv03:999"]));
    expect(await wrapped.findBySetLocal("sv03", "999")).toEqual([]);
    expect(port.calls.findBySetLocal).toBe(0); // no wasted round trip
    // A different key was never fetched, so it must still be asked.
    await wrapped.findBySetLocal("sv03", "026");
    expect(port.calls.findBySetLocal).toBe(1);
  });

  it("memoizes a live miss so repeated rows of the same card do not re-query", async () => {
    const port = countingPort();
    const wrapped = prefetchedCatalogPort(port, new Map(), new Set());
    await wrapped.findBySetLocal("nope", "001");
    await wrapped.findBySetLocal("nope", "001");
    expect(port.calls.findBySetLocal).toBe(1);
  });
});

describe("buildCatalogPrefetch groups by set", () => {
  /** Minimal DbClient honouring `.eq("set_id").in("local_id")`, counting queries. */
  function fakeDb() {
    let queries = 0;
    const rows = Object.entries(CARDS).flatMap(([k, v]) => {
      const [set_id, local_id] = k.split(":");
      return v.map((c) => ({ tcgdex_id: c.tcgdexId, set_id, local_id }));
    });
    const db = {
      from: () => {
        let setId: string | null = null;
        let localIds: string[] = [];
        const q: Record<string, unknown> = {
          select: () => q,
          eq: (_c: string, v: string) => {
            setId = v;
            return q;
          },
          in: (_c: string, v: string[]) => {
            localIds = v;
            queries += 1;
            return Promise.resolve({
              data: rows.filter((r) => r.set_id === setId && localIds.includes(r.local_id)),
              error: null,
            });
          },
        };
        return q;
      },
    } as unknown as DbClient;
    return { db, queryCount: () => queries };
  }

  it("issues one query per distinct set, not one per candidate", async () => {
    const { db, queryCount } = fakeDb();
    const wants = [
      { setId: "sv03", candidates: ["026", "26"] },
      { setId: "sv03", candidates: ["027", "27"] },
      { setId: "me06", candidates: ["014", "14"] },
    ];
    const { index, fetched, queries } = await buildCatalogPrefetch(db, wants);

    expect(queries).toBe(2); // sv03 + me06, though there are 6 candidates across 3 wants
    expect(queryCount()).toBe(2);
    expect(index.get("sv03:026")).toEqual([{ tcgdexId: "sv03-026" }]);
    // Every candidate asked for is recorded as fetched, including the ones with no card.
    expect(fetched.has("sv03:26")).toBe(true);
    expect(index.has("sv03:26")).toBe(false);
  });

  it("skips wants with no set or no candidates rather than querying for nothing", async () => {
    const { db, queryCount } = fakeDb();
    const { queries } = await buildCatalogPrefetch(db, [
      { setId: "", candidates: ["001"] },
      { setId: "sv03", candidates: [] },
    ]);
    expect(queries).toBe(0);
    expect(queryCount()).toBe(0);
  });
});
