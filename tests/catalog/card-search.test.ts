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

/**
 * UIL-015's real collision shape. McDonald's Collection set ids are numeric-prefixed
 * (`2011bw` … `2024sv`), and digits sort before letters, so every one of them precedes `me02.5`
 * under `order("set_id")`. Each holds an unpadded `11`; Wurmple is the padded `011` she typed.
 */
const MCDONALDS_SETS = [
  "2011bw",
  "2012bw",
  "2014xy",
  "2015xy",
  "2016xy",
  "2017sm",
  "2018sm",
  "2019sm",
  "2021swsh",
  "2022swsh",
  "2023sv",
  "2024sv",
];

const COLLISION_CATALOG: Card[] = [
  ...MCDONALDS_SETS.map((setId) =>
    card({
      tcgdex_id: `${setId}-11`,
      name: `McDonald's promo ${setId}`,
      local_id: "11",
      set_id: setId,
      set_name: "McDonald's Collection",
    }),
  ),
  // The card she actually asked for, in a set that sorts AFTER all twelve.
  card({
    tcgdex_id: "me02.5-011",
    name: "Wurmple",
    local_id: "011",
    set_id: "me02.5",
    set_name: "Ascended Heroes",
  }),
];

/** Minimal query builder: honours eq / in / or(ilike) / order / limit the way PostgREST would. */
function fakeDb(rows: Card[]): DbClient {
  const make = () => {
    let out = [...rows];
    const orderKeys: string[] = [];
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
      /**
       * Multiple `.order()` calls COMPOSE in PostgREST (primary, then secondary) — they do not
       * replace each other. An earlier version of this fake re-sorted on each call, which silently
       * masked UIL-015: the second `.order("local_id")` undid the `set_id` ordering and floated the
       * padded match to the top, so the pre-fix query looked correct here while being wrong in
       * production. Comparison is by code unit, not `localeCompare`, because that is what puts
       * DIGITS BEFORE LETTERS — the whole reason `2011bw` outranks `me02.5`.
       */
      order(col: string) {
        orderKeys.push(col);
        out = [...out].sort((a, b) => {
          for (const key of orderKeys) {
            const av = String((a as unknown as Record<string, unknown>)[key]);
            const bv = String((b as unknown as Record<string, unknown>)[key]);
            if (av < bv) return -1;
            if (av > bv) return 1;
          }
          return 0;
        });
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

describe("padding-variant precedence (UIL-015)", () => {
  it("returns Wurmple for 011/217, not the McDonald's cards that sort before it", async () => {
    const found = await catalogCardRepo.search(fakeDb(COLLISION_CATALOG), "011/217", 5);
    // Pre-fix this returned five McDonald's promos and NO Wurmple at all. The bug was the exact
    // match being crowded OUT, not the stripped-form matches existing — those are legitimate
    // lower-precedence results, so the assertion is about rank, not exclusion.
    expect(ids(found)).toContain("me02.5-011");
    expect(found[0].tcgdex_id).toBe("me02.5-011");
  });

  it("puts the typed form first even when the other form fills the whole limit", async () => {
    // limit 3 with twelve stripped-form collisions available: the padded match must still lead.
    const found = await catalogCardRepo.search(fakeDb(COLLISION_CATALOG), "011", 3);
    expect(found[0].local_id).toBe("011");
    expect(found).toHaveLength(3);
  });

  it("is symmetric: typing the UNPADDED form ranks the unpadded matches first", async () => {
    // This is why the rule is "the form she typed", not "padded first" — padded-first would rank
    // me02.5-011 above the 11 she actually asked for.
    const found = await catalogCardRepo.search(fakeDb(COLLISION_CATALOG), "11", 3);
    expect(found[0].local_id).toBe("11");
    expect(ids(found)).not.toContain("me02.5-011");
  });

  it("still falls back to the other form when the typed one has no match", async () => {
    // A set storing only the unpadded form: `local_id` padding varies by set (0002_domain.sql), so
    // the fallback is what keeps those reachable.
    const onlyUnpadded = [
      card({ tcgdex_id: "sv09-11", name: "Lone Card", local_id: "11", set_id: "sv09" }),
    ];
    const found = await catalogCardRepo.search(fakeDb(onlyUnpadded), "011/182", 5);
    expect(ids(found)).toEqual(["sv09-11"]);
  });

  it("does not let the number query starve the free-text half of its limit", async () => {
    const found = await catalogCardRepo.search(fakeDb(COLLISION_CATALOG), "011", 20);
    // All 13 number matches, none duplicated.
    expect(new Set(ids(found)).size).toBe(found.length);
    expect(found[0].tcgdex_id).toBe("me02.5-011");
  });
});
