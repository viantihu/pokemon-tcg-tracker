/**
 * The PGlite harness applies EVERY migration on disk — proven, not assumed.
 *
 * Four times (UIL-029) a PGlite-backed test was green against a schema that was one, two, then six
 * versions behind develop, because `tests/support/pglite-rpc.ts` kept its migration list by hand and
 * nobody remembered to extend it. Every one of those was found by a developer reading, never by a test
 * failing. This is the test that would have failed: `freshRpcDb` now records each version it applies in
 * the same `supabase_migrations.schema_migrations` table the Supabase CLI writes, and this compares the
 * recorded set against the directory. A migration file that exists but was not applied — a filter
 * typo, a hand-kept list creeping back, a file the sort put out of order — fails here.
 */
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { freshRpcDb, MIGRATIONS, MIGRATIONS_DIR } from "./pglite-rpc";

describe("the PGlite harness applies every migration on disk", () => {
  const onDisk = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const versionsOnDisk = onDisk.map((f) => f.split("_")[0]);

  it("the harness's list IS the directory, in version order", () => {
    expect([...MIGRATIONS]).toEqual(onDisk);
    expect(onDisk.length).toBeGreaterThanOrEqual(13); // 0001–0013 exist at the time of writing
    expect([...versionsOnDisk].sort()).toEqual(versionsOnDisk); // filename order == version order
  });

  it("a fresh harness DB has recorded exactly those versions as applied", async () => {
    const db = await freshRpcDb();
    try {
      const r = await db.query<{ version: string }>(
        `select version from supabase_migrations.schema_migrations order by version`,
      );
      expect(r.rows.map((x) => x.version)).toEqual(versionsOnDisk);
      // And the schema really is at the head: a column only the latest migrations add is present.
      const cols = await db.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_name = 'line_slot' and column_name = 'resolved_decision_collection_id'`,
      );
      expect(cols.rows).toHaveLength(1);
    } finally {
      await db.close();
    }
  });
});
