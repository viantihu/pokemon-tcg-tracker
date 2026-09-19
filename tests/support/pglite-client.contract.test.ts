/**
 * The PGlite `DbClient` shim's CONTRACT, pinned against real Postgres (UIL-029).
 *
 * The shim exists so server modules can be tested end to end instead of against a hand-rolled fake, but
 * the shim itself is a fake of supabase-js/PostgREST, and this project has found five fidelity faults in
 * it by reading rather than by a test failing: `count` reporting the page size under `.range()` (would
 * have re-armed UIL-031's truncation hazard), `order()` ignoring `{ ascending: false }`, `numeric` coming
 * back as a string, `head: true` unsupported, and — this week — `maybeSingle` handing back the FIRST of
 * several rows where PostgREST errors, and timestamps arriving as `Date` where production gets a string.
 * Each fault class below is one `it`, each against a 1,200-row table so the paging cases cannot pass
 * vacuously (the RCA's RC-5 ask). The PR body records one mutation per class that fails it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { DbClient } from "@/lib/repo";
import { asOwner, freshRpcDb, OWNER, seedBinders, seedCollections } from "./pglite-rpc";
import { pgliteClient } from "./pglite-client";

const ROWS = 1200;
const B1 = "1c000000-0000-0000-0000-0000000000c1";

let pg: PGlite;
let db: DbClient;

beforeEach(async () => {
  pg = await freshRpcDb();
  // 1,200 catalog rows with a sortable key and a numeric price — past PostgREST's default 1,000 max-rows.
  await pg.exec(`
    insert into catalog_card (tcgdex_id, name, set_id, local_id, price_market)
    select 'bulk-' || lpad(i::text, 4, '0'), 'Card ' || i, 'bulk', lpad(i::text, 4, '0'), (i % 100) + 0.25
      from generate_series(1, ${ROWS}) as i;
  `);
  await seedBinders(db_(pg), [{ id: B1, type: "specialty", name: "B" }]);
  db = pgliteClient(pg);
});
afterEach(async () => {
  await pg.close();
});
const db_ = (p: PGlite) => p;

/** Loosen the typed client for raw contract calls — the shape under test IS the loose one repos rely on. */
const loose = () =>
  db as unknown as {
    from: (t: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

describe("shim contract · count is the TOTAL, not the page (UIL-031's guard depends on it)", () => {
  it("count: exact under range(0, 99) reports 1,200 while data holds 100", async () => {
    const { data, count, error } = await loose()
      .from("catalog_card")
      .select("*", { count: "exact" })
      .order("tcgdex_id")
      .range(0, 99);
    expect(error).toBeNull();
    expect(data).toHaveLength(100);
    expect(count).toBe(ROWS);
  });

  it("consecutive ranges tile the table with no gap and no overlap", async () => {
    const seen = new Set<string>();
    for (let from = 0; from < ROWS; from += 500) {
      const { data } = await loose()
        .from("catalog_card")
        .select("tcgdex_id")
        .order("tcgdex_id")
        .range(from, from + 499);
      for (const r of data) seen.add(r.tcgdex_id);
    }
    expect(seen.size).toBe(ROWS);
  });

  it("head: true returns data null with the real total", async () => {
    const { data, count, error } = await loose()
      .from("catalog_card")
      .select("*", { count: "exact", head: true });
    expect(error).toBeNull();
    expect(data).toBeNull();
    expect(count).toBe(ROWS);
  });

  it("count: exact with a filter counts the FILTERED rows", async () => {
    const { count } = await loose()
      .from("catalog_card")
      .select("*", { count: "exact" })
      .eq("set_id", "nope");
    expect(count).toBe(0);
  });
});

describe("shim contract · order() honours the direction it is given", () => {
  it("descending puts the last key first", async () => {
    const { data } = await loose()
      .from("catalog_card")
      .select("tcgdex_id")
      .order("tcgdex_id", { ascending: false })
      .range(0, 0);
    expect(data[0].tcgdex_id).toBe("bulk-1200");
  });

  it("ascending (the default) puts the first key first", async () => {
    const { data } = await loose()
      .from("catalog_card")
      .select("tcgdex_id")
      .order("tcgdex_id")
      .range(0, 0);
    expect(data[0].tcgdex_id).toBe("bulk-0001");
  });
});

describe("shim contract · single-row reads behave like PostgREST", () => {
  it("maybeSingle on zero rows → data null, no error", async () => {
    const r = await loose().from("catalog_card").select("*").eq("tcgdex_id", "nope").maybeSingle();
    expect(r).toEqual({ data: null, error: null });
  });

  it("maybeSingle on exactly one row → that row", async () => {
    const r = await loose()
      .from("catalog_card")
      .select("*")
      .eq("tcgdex_id", "bulk-0007")
      .maybeSingle();
    expect(r.error).toBeNull();
    expect(r.data.name).toBe("Card 7");
  });

  it("maybeSingle on TWO rows → an error (PGRST116), never the first row silently", async () => {
    const r = await loose().from("catalog_card").select("*").eq("set_id", "bulk").maybeSingle();
    expect(r.data).toBeNull();
    expect(r.error).toMatchObject({ code: "PGRST116" });
    expect(r.error.message).toMatch(/multiple/);
  });

  it("single on zero rows → an error, not a silent null (an update that matched nothing must not read as success)", async () => {
    const r = await loose()
      .from("catalog_card")
      .update({ name: "renamed" })
      .eq("tcgdex_id", "nope")
      .select()
      .single();
    expect(r.data).toBeNull();
    expect(r.error).toMatchObject({ code: "PGRST116" });
  });
});

describe("shim contract · column types arrive in production's shape", () => {
  it("numeric comes back as a JS number, not a string", async () => {
    const { data } = await loose()
      .from("catalog_card")
      .select("price_market")
      .eq("tcgdex_id", "bulk-0003");
    expect(data[0].price_market).toBe(3.25);
    expect(typeof data[0].price_market).toBe("number");
  });

  it("timestamptz comes back as an ISO-8601 STRING that new Date() parses, not a Date", async () => {
    await seedCollections(pg, [{ id: "c0110000-0000-0000-0000-0000000000c1", name: "T" }]);
    await asOwner(pg);
    const { data } = await loose().from("collection").select("created_at, updated_at");
    const v = data[0].created_at;
    expect(typeof v).toBe("string");
    expect(v).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(Number.isNaN(new Date(v).getTime())).toBe(false);
    // The bump trigger's column (0012) has the same shape.
    expect(typeof data[0].updated_at).toBe("string");
  });

  it("array columns come back as arrays", async () => {
    const { data } = await loose()
      .from("catalog_card")
      .select("dex_id, types")
      .eq("tcgdex_id", "bulk-0001");
    expect(Array.isArray(data[0].dex_id)).toBe(true);
    expect(Array.isArray(data[0].types)).toBe(true);
  });
});

describe("shim contract · it refuses shapes it does not model, rather than guessing", () => {
  it("an unsupported not() shape throws", () => {
    expect(() => loose().from("catalog_card").select("*").not("set_id", "eq", "x")).toThrow(
      /not\(\)/,
    );
  });

  it("in() with an empty list matches nothing", async () => {
    const { data } = await loose().from("catalog_card").select("tcgdex_id").in("tcgdex_id", []);
    expect(data).toEqual([]);
  });
});

// Keep the OWNER import meaningful for readers: RLS-scoped reads above run under it via asOwner().
void OWNER;
