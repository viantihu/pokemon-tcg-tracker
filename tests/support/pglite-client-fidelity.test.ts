/**
 * Self-tests for the PGlite `DbClient` shim (tests/support/pglite-client.ts).
 *
 * A hand-written test double is production code with no tests of its own, and this one has now been
 * edited by three concurrent PRs. Every assertion here exists because getting it wrong makes the SUITE
 * agree with broken code rather than fail — the shim is upstream of ~60 test files, so a fidelity bug
 * here is invisible and load-bearing at the same time.
 *
 * The `count` case is the one with history. `count` was `rows.length`, which was exactly right until
 * `range()` existed; with a range applied it is the PAGE SIZE. Returning that as the total is precisely
 * how `assertReadComplete` (UIL-031) can be handed a truncated read and call it complete. Two open PRs
 * touch this method and the obvious three-way resolution drops the fix silently — mutating it back to
 * `rows.length` passed 559/559 before this file existed. This is the tripwire.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { freshRpcDb, seedCatalogCards } from "./pglite-rpc";
import { pgliteClient } from "./pglite-client";

let db: PGlite;
const IDS = Array.from({ length: 25 }, (_, i) => `sv03-${String(i).padStart(3, "0")}`);

beforeEach(async () => {
  db = await freshRpcDb();
  await seedCatalogCards(db, IDS);
});
afterEach(async () => {
  await db.close();
});

describe("count is the real total, not the page size", () => {
  it("reports the FULL row count when a range has narrowed the rows", async () => {
    const client = pgliteClient(db);
    const { data, count } = await client
      .from("catalog_card")
      .select("tcgdex_id", { count: "exact" })
      .order("tcgdex_id", { ascending: true })
      .range(0, 9);

    // The page really is narrowed…
    expect(data).toHaveLength(10);
    // …and the count is still the total. If this ever equals 10, `assertReadComplete` can be handed a
    // truncated read and told it is complete — see the file header.
    expect(count).toBe(25);
  });

  it("reports the total for a later page too, not the offset or the slice", async () => {
    const client = pgliteClient(db);
    const { data, count } = await client
      .from("catalog_card")
      .select("tcgdex_id", { count: "exact" })
      .order("tcgdex_id", { ascending: true })
      .range(20, 29);
    expect(data).toHaveLength(5); // only 25 rows exist
    expect(count).toBe(25);
  });

  it("honours filters in the count rather than counting the whole table", async () => {
    const client = pgliteClient(db);
    const { count } = await client
      .from("catalog_card")
      .select("tcgdex_id", { count: "exact" })
      .in("tcgdex_id", [IDS[0], IDS[1], IDS[2]])
      .range(0, 0);
    expect(count).toBe(3);
  });

  it("leaves count null when it was not asked for", async () => {
    const client = pgliteClient(db);
    const { count } = await client.from("catalog_card").select("tcgdex_id").range(0, 4);
    expect(count).toBeNull();
  });
});

describe("range and order mean what PostgREST means", () => {
  it("treats range bounds as INCLUSIVE on both ends", async () => {
    const client = pgliteClient(db);
    const { data } = await client
      .from("catalog_card")
      .select("tcgdex_id")
      .order("tcgdex_id", { ascending: true })
      .range(3, 5);
    // 3,4,5 — three rows, not two and not four.
    expect(data!.map((r) => r.tcgdex_id)).toEqual([IDS[3], IDS[4], IDS[5]]);
  });

  it("pages without gaps or repeats across consecutive ranges", async () => {
    const client = pgliteClient(db);
    const page = async (from: number, to: number) =>
      (
        await client
          .from("catalog_card")
          .select("tcgdex_id")
          .order("tcgdex_id", { ascending: true })
          .range(from, to)
      ).data!.map((r) => r.tcgdex_id as string);
    const all = [...(await page(0, 9)), ...(await page(10, 19)), ...(await page(20, 29))];
    expect(all).toEqual(IDS);
    expect(new Set(all).size).toBe(25);
  });

  it("actually reverses for { ascending: false } instead of silently sorting up", async () => {
    const client = pgliteClient(db);
    const { data } = await client
      .from("catalog_card")
      .select("tcgdex_id")
      .order("tcgdex_id", { ascending: false })
      .range(0, 2);
    expect(data!.map((r) => r.tcgdex_id)).toEqual([IDS[24], IDS[23], IDS[22]]);
  });

  it("rejects a nonsensical range rather than quietly returning something", async () => {
    const client = pgliteClient(db);
    expect(() => client.from("catalog_card").select("tcgdex_id").range(5, 2)).toThrow();
    expect(() => client.from("catalog_card").select("tcgdex_id").range(-1, 3)).toThrow();
  });
});
