/**
 * `catalogCardRepo.search` end-to-end over a fake DbClient (UIL-010).
 *
 * The parser is covered in ./collector-number.test.ts; this covers what the repo does with it — the
 * exact-vs-substring distinction, the ranking, and the dedup across the two queries. Five surfaces
 * (plan, backfill, collections, lookup, sync) all bottom out here, so a fix at this level fixes them
 * all and a regression here breaks them all.
 */
import { describe, expect, it } from "vitest";
import { catalogCardRepo } from "@/lib/repo";
import type { DbClient } from "@/lib/repo";

interface Card {
  tcgdex_id: string;
  name: string;
  set_id: string;
  set_name: string;
  local_id: string;
  is_digital_only: boolean;
}

const card = (over: Partial<Card> & Pick<Card, "tcgdex_id" | "name" | "local_id">): Card => ({
  set_id: over.tcgdex_id.split("-")[0],
  set_name: "Scarlet & Violet",
  is_digital_only: false,
  ...over,
});

const CATALOG: Card[] = [
  card({ tcgdex_id: "sv04-099", name: "Minior", local_id: "099" }), // the reported card
  card({ tcgdex_id: "sv01-99", name: "Wattrel", local_id: "99" }), // same number, unpadded set
  card({ tcgdex_id: "sv02-199", name: "Klawf", local_id: "199" }), // must NOT match "99"
  card({ tcgdex_id: "sv02-990", name: "Bogus", local_id: "990" }), // must NOT match "99"
  card({ tcgdex_id: "sv03-026", name: "Charmander", local_id: "026" }),
  card({ tcgdex_id: "sv05-001", name: "Minior Prism", local_id: "001" }),
  card({ tcgdex_id: "svp-099", name: "Digital Minior", local_id: "099", is_digital_only: true }),
];

/** Minimal query builder: honours eq / in / or(ilike) / order / limit the way PostgREST would. */
function fakeDb(rows: Card[]): DbClient {
  const make = () => {
    let out = [...rows];
    const q: Record<string, unknown> = {
      select: () => q,
      eq(col: string, val: unknown) {
        out = out.filter((r) => (r as unknown as Record<string, unknown>)[col] === val);
        return q;
      },
      in(col: string, vals: unknown[]) {
        const set = new Set(vals);
        out = out.filter((r) => set.has((r as unknown as Record<string, unknown>)[col]));
        return q;
      },
      or(expr: string) {
        // "name.ilike.%x%,set_name.ilike.%x%,..." — match if ANY predicate holds.
        const preds = expr.split(",").map((p) => {
          const [col, , pattern] = p.split(".");
          return { col, needle: pattern.replaceAll("%", "").toLowerCase() };
        });
        out = out.filter((r) =>
          preds.some(({ col, needle }) => {
            const v = (r as unknown as Record<string, unknown>)[col];
            return typeof v === "string" && v.toLowerCase().includes(needle);
          }),
        );
        return q;
      },
      order(col: string) {
        out = [...out].sort((a, b) =>
          String((a as unknown as Record<string, unknown>)[col]).localeCompare(
            String((b as unknown as Record<string, unknown>)[col]),
          ),
        );
        return q;
      },
      limit(n: number) {
        out = out.slice(0, n);
        return q;
      },
      then: <T>(resolve: (v: { data: Card[]; error: null }) => T) =>
        Promise.resolve({ data: out, error: null }).then(resolve),
    };
    return q;
  };
  return { from: () => make() } as unknown as DbClient;
}

const ids = (rows: { tcgdex_id: string }[]) => rows.map((r) => r.tcgdex_id);

describe("search by printed collector number", () => {
  it("finds the card for 099/182 — the query that used to return nothing at all", async () => {
    const found = await catalogCardRepo.search(fakeDb(CATALOG), "099/182");
    expect(ids(found)).toContain("sv04-099");
    expect(found.length).toBeGreaterThan(0);
  });

  it("ranks the exact number match first, ahead of name matches", async () => {
    const found = await catalogCardRepo.search(fakeDb(CATALOG), "099/182");
    expect(found[0].local_id).toBe("099");
  });

  it("matches across padding variants, since local_id padding varies by set", async () => {
    const found = await catalogCardRepo.search(fakeDb(CATALOG), "99");
    expect(ids(found)).toContain("sv04-099"); // stored padded
    expect(ids(found)).toContain("sv01-99"); // stored unpadded
  });

  it("ranks 199 and 990 BELOW the exact matches — exact first, not substring", async () => {
    // The text half legitimately still substring-matches 199/990 via `local_id.ilike.%99%`; what
    // must not happen is either of them displacing the card she actually asked for.
    const found = await catalogCardRepo.search(fakeDb(CATALOG), "99");
    const exact = found.slice(0, 2).map((r) => r.local_id);
    expect(exact.sort()).toEqual(["099", "99"]);
    for (const id of ["sv02-199", "sv02-990"]) {
      const at = ids(found).indexOf(id);
      if (at !== -1) expect(at).toBeGreaterThan(1);
    }
  });

  it("still excludes digital-only printings", async () => {
    const found = await catalogCardRepo.search(fakeDb(CATALOG), "099/182");
    expect(ids(found)).not.toContain("svp-099");
  });

  it("returns no duplicates when a card matches both the number and the text", async () => {
    const found = await catalogCardRepo.search(fakeDb(CATALOG), "minior 099");
    expect(new Set(ids(found)).size).toBe(found.length);
  });
});

describe("search by name still works", () => {
  it("matches a name substring", async () => {
    const found = await catalogCardRepo.search(fakeDb(CATALOG), "charmander");
    expect(ids(found)).toEqual(["sv03-026"]);
  });

  it("finds both cards for a name plus a number, number first", async () => {
    const found = await catalogCardRepo.search(fakeDb(CATALOG), "minior 099");
    expect(found[0].tcgdex_id).toBe("sv04-099");
    expect(ids(found)).toContain("sv05-001"); // "Minior Prism", via the text half
  });

  it("returns [] for a blank query without hitting the DB", async () => {
    expect(await catalogCardRepo.search(fakeDb(CATALOG), "   ")).toEqual([]);
  });

  it("honours the limit", async () => {
    const found = await catalogCardRepo.search(fakeDb(CATALOG), "99", 1);
    expect(found).toHaveLength(1);
  });
});
