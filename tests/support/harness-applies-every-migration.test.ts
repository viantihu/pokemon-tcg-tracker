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
import {
  applyOps,
  asOwner,
  asSuperuser,
  freshRpcDb,
  MIGRATIONS,
  MIGRATIONS_DIR,
  OWNER,
  seedBinders,
  seedCollections,
} from "./pglite-rpc";

describe("the PGlite harness applies every migration on disk", () => {
  const onDisk = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const versionsOnDisk = onDisk.map((f) => f.split("_")[0]);

  it("the harness's list IS the directory, in version order", () => {
    expect([...MIGRATIONS]).toEqual(onDisk);
    expect(onDisk.length).toBeGreaterThanOrEqual(14); // 0001–0014 exist at the time of writing
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
      // And the RPC is the COMPOSED function — the last migration to replace it won: 0014's branch is
      // present alongside 0013's patch keys (see both migrations' headers on why neither file alone is it).
      const fn = await db.query<{ def: string }>(
        `select pg_get_functiondef('apply_write_ops(jsonb)'::regprocedure) as def`,
      );
      expect(fn.rows[0].def).toContain("delete_set_alias");
      expect(fn.rows[0].def).toContain("resolved_decision_collection_id");
    } finally {
      await db.close();
    }
  });
});

describe("the composed apply_write_ops writes UIL-078's marker with a REAL collection id", () => {
  /**
   * #188's tests wrote the marker through the repo layer (applyDecision) and cleared it through the RPC
   * (releaseSlotOps → nulls). Nothing had yet pushed a NON-NULL resolved_decision_collection_id through
   * `update_slot` itself — the branch 0013 added, carried forward verbatim by 0014. This does, as the
   * authenticated owner, and reads it back; it also proves the FK to `collection` is real (a made-up id
   * is refused, and the whole op set rolls back).
   */
  const B1 = "1c000000-0000-0000-0000-0000000000c1";
  const L1 = "10000000-0000-0000-0000-0000000000c1";
  const S1 = "50000000-0000-0000-0000-0000000000c1";
  const COLL = "c0110000-0000-0000-0000-0000000000c1";

  it("update_slot sets kind / choice / collection id together, and nulls them together", async () => {
    const db = await freshRpcDb();
    try {
      await seedBinders(db, [{ id: B1, type: "general", name: "B" }]);
      await seedCollections(db, [{ id: COLL, name: "Fire Collection" }]);
      await db.exec(`
        insert into catalog_card (tcgdex_id, name) values ('mark-card', 'Mark Card');
        insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id)
          values ('${L1}', '${OWNER}', 9, 'red', '${B1}');
        insert into line_slot (id, owner_id, line_id, stage_index, stage, state, target_catalog_card_id)
          values ('${S1}', '${OWNER}', '${L1}', 0, 'Basic', 'placeholder', 'mark-card');
      `);
      await asOwner(db);
      await applyOps(db, {
        ops: [
          {
            op: "update_slot",
            id: S1,
            patch: {
              resolved_decision_kind: "collection-vs-line",
              resolved_decision_choice: "collection-wins",
              resolved_decision_collection_id: COLL,
            },
          },
        ],
      });
      await asSuperuser(db);
      const marked = await db.query<Record<string, string | null>>(
        `select state, resolved_decision_kind, resolved_decision_choice, resolved_decision_collection_id
           from line_slot where id = $1`,
        [S1],
      );
      expect(marked.rows[0]).toEqual({
        state: "placeholder", // untouched: absent keys leave columns alone
        resolved_decision_kind: "collection-vs-line",
        resolved_decision_choice: "collection-wins",
        resolved_decision_collection_id: COLL,
      });

      // A collection id that does not exist is refused by the FK — and nothing else in the set lands.
      await asOwner(db);
      await expect(
        applyOps(db, {
          ops: [
            { op: "update_slot", id: S1, patch: { note: "should roll back" } },
            {
              op: "update_slot",
              id: S1,
              patch: { resolved_decision_collection_id: "c0110000-0000-0000-0000-00000000dead" },
            },
          ],
        }),
      ).rejects.toThrow();
      await asSuperuser(db);
      const after = await db.query<{ note: string | null; cid: string | null }>(
        `select note, resolved_decision_collection_id as cid from line_slot where id = $1`,
        [S1],
      );
      expect(after.rows[0]).toEqual({ note: null, cid: COLL });

      // And the release path's shape — all three keys null in one patch — clears them together.
      await asOwner(db);
      await applyOps(db, {
        ops: [
          {
            op: "update_slot",
            id: S1,
            patch: {
              resolved_decision_kind: null,
              resolved_decision_choice: null,
              resolved_decision_collection_id: null,
            },
          },
        ],
      });
      await asSuperuser(db);
      const cleared = await db.query<Record<string, string | null>>(
        `select resolved_decision_kind, resolved_decision_choice, resolved_decision_collection_id
           from line_slot where id = $1`,
        [S1],
      );
      expect(cleared.rows[0]).toEqual({
        resolved_decision_kind: null,
        resolved_decision_choice: null,
        resolved_decision_collection_id: null,
      });
    } finally {
      await db.close();
    }
  });
});
