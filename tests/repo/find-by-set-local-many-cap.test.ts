/**
 * UIL-028 — `findBySetLocalMany` chunks its ids, and each chunk is ONE unpaged PostgREST response, so a
 * chunk whose rows exceed the server's `max-rows` cap would be silently cut. Nothing reaches the cap at
 * the default chunk of 200 today; the danger was that nothing SAID so, and raising `chunkSize` to 2000
 * read as a harmless speed-up. Now every chunk asks for the true total and throws by name if the cap
 * cut it — because `lib/sync/catalog-lookup.ts` marks every requested id fetched, a cut chunk would
 * otherwise turn real cards into "proven absences" parked in the unresolved queue.
 *
 * The fake below models the one PostgREST behaviour this hinges on, as `truncation-detection.test.ts`
 * does for UIL-031: the same request that caps `data` at `maxRows` still reports the true filtered
 * total via `count` when asked for `{ count: "exact" }` (Content-Range). PGlite cannot model the cap —
 * it is real Postgres with no REST layer — so a fake is the honest instrument here.
 *
 * Revert check: without the guard, case 2 resolves with exactly 1,000 rows and no error.
 */
import { describe, expect, it } from "vitest";
import { catalogCardRepo, type DbClient } from "@/lib/repo";

type Row = Record<string, unknown>;
const CAP = 1000; // Supabase's default max-rows

/** `eq` + `in` + `{ count: "exact" }`, data capped at `maxRows`, count the true filtered total. */
function cappedCatalog(rows: Row[], maxRows: number, requests: number[] = []) {
  const make = () => {
    const filters: ((r: Row) => boolean)[] = [];
    let wantCount = false;
    const q = {
      select(_cols: string, opts?: { count?: string }) {
        wantCount = opts?.count === "exact";
        return q;
      },
      eq(col: string, v: unknown) {
        filters.push((r) => r[col] === v);
        return q;
      },
      in(col: string, vs: unknown[]) {
        requests.push(vs.length);
        const s = new Set(vs);
        filters.push((r) => s.has(r[col]));
        return q;
      },
      then<T>(resolve: (v: { data: Row[]; error: null; count: number | null }) => T) {
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({
          data: matched.slice(0, maxRows),
          error: null,
          count: wantCount ? matched.length : null,
        }).then(resolve);
      },
    };
    return q;
  };
  return { from: () => make() } as unknown as DbClient;
}

const pad = (n: number) => String(n).padStart(3, "0");
/** `n` collector numbers in one set, `printings` rows each (a healthy mirror has 1). */
const set = (n: number, printings = 1): Row[] =>
  Array.from({ length: n * printings }, (_, i) => ({
    tcgdex_id: `sv04-${pad((i % n) + 1)}${printings > 1 ? `-p${Math.floor(i / n)}` : ""}`,
    set_id: "sv04",
    local_id: pad((i % n) + 1),
  }));
const ids = (n: number) => Array.from({ length: n }, (_, i) => pad(i + 1));

describe("UIL-028 · findBySetLocalMany refuses a chunk the row cap cut, rather than returning it as complete", () => {
  it("the default chunk of 200 on 1,200 single-printing ids: six requests, every row back, no error", async () => {
    const requests: number[] = [];
    const db = cappedCatalog(set(1200), CAP, requests);
    const rows = await catalogCardRepo.findBySetLocalMany(db, "sv04", ids(1200));
    expect(rows).toHaveLength(1200);
    expect(requests).toEqual([200, 200, 200, 200, 200, 200]);
  });

  it("chunkSize 2000 on the same fixture: one request, the cap cuts it to 1,000 — throws by name", async () => {
    const requests: number[] = [];
    const db = cappedCatalog(set(1200), CAP, requests);
    await expect(catalogCardRepo.findBySetLocalMany(db, "sv04", ids(1200), 2000)).rejects.toThrow(
      /read 1000 of 1200 row\(s\)[\s\S]*findBySetLocalMany\(sv04\)[\s\S]*lower chunkSize/,
    );
    expect(requests).toEqual([1200]);
  });

  it("the default is safe only while the mirror is healthy: 200 ids × 6 printings is 1,200 rows in ONE chunk — throws too", async () => {
    const db = cappedCatalog(set(200, 6), CAP);
    await expect(catalogCardRepo.findBySetLocalMany(db, "sv04", ids(200))).rejects.toThrow(
      /read 1000 of 1200 row\(s\)/,
    );
  });

  it("a client that reports no total (the sync suites' doubles) is not a false positive", async () => {
    const rows = set(1200);
    const db = {
      from: () => {
        const q = {
          select: () => q,
          eq: () => q,
          in: () => q,
          then: <T>(resolve: (v: { data: Row[]; error: null }) => T) =>
            Promise.resolve({ data: rows.slice(0, 5), error: null }).then(resolve),
        };
        return q;
      },
    } as unknown as DbClient;
    expect(await catalogCardRepo.findBySetLocalMany(db, "sv04", ids(5))).toHaveLength(5);
  });
});
