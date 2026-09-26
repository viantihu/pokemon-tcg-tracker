/**
 * Migration 0026: the record's two whole-record deletes name the owner (P0, 2026-09-26).
 *
 * Supabase's pg_safeupdate refused `delete from dex_presence` inside `apply_write_ops` ("DELETE requires a WHERE
 * clause", 21000), so no import on Testing could be saved. PGlite does not load pg_safeupdate, so what this file
 * CAN prove is everything else about the change: 0026 is 0024's function with exactly those three statements
 * (and the comment above them) changed, `auth.uid()` resolves in the body as the signed-in owner, the deletes
 * still touch only her rows, and the service role is still refused. tests/db/no-unscoped-writes.test.ts refuses
 * the unscoped shape statically; the Database Engineer proves the rest on Testing's real Postgres.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyOps, asOwner, asSuperuser, freshRpcDb, OWNER } from "../support/pglite-rpc";

const OTHER = "00000000-0000-0000-0000-000000000002";
const CARD = "sv03-026";

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await db.exec(`insert into catalog_card (tcgdex_id, name) values ('${CARD}', 'Charmander')`);
  // Another owner's record, which nothing she does may touch.
  await db.exec(`
    insert into dex_presence (owner_id, catalog_card_id, dex_variant_raw, quantity)
      values ('${OTHER}', '${CARD}', 'Normal', 5);
    insert into dex_import (owner_id, file_total, row_count) values ('${OTHER}', 5, 1);
  `);
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

async function recordOf(owner: string) {
  await asSuperuser(db);
  const rows = await db.query<{ quantity: number }>(
    `select quantity from dex_presence where owner_id = $1 order by quantity`,
    [owner],
  );
  const header = await db.query<{ file_total: number }>(
    `select file_total from dex_import where owner_id = $1`,
    [owner],
  );
  await asOwner(db);
  return { rows: rows.rows.map((r) => r.quantity), fileTotal: header.rows[0]?.file_total ?? null };
}

const replace = (quantity: number) => ({
  op: "replace_dex_record" as const,
  rows: [{ catalog_card_id: CARD, dex_variant_raw: "Normal", quantity }],
  file_total: quantity,
  row_count: 1,
});

describe("0026 · the whole-record deletes are hers, by name", () => {
  it("replace_dex_record replaces HER record, twice over, and leaves another owner's alone", async () => {
    await applyOps(db, { ops: [replace(2)] });
    await applyOps(db, { ops: [replace(3)] }); // the second import deletes the first one's rows
    expect(await recordOf(OWNER)).toEqual({ rows: [3], fileTotal: 3 });
    expect(await recordOf(OTHER)).toEqual({ rows: [5], fileTotal: 5 });
  });

  it("clear_dex_record clears HER record and leaves another owner's alone", async () => {
    await applyOps(db, { ops: [replace(2)] });
    await applyOps(db, { ops: [{ op: "clear_dex_record" }] });
    expect(await recordOf(OWNER)).toEqual({ rows: [], fileTotal: null });
    expect(await recordOf(OTHER)).toEqual({ rows: [5], fileTotal: 5 });
  });

  it("the service role is still refused, before any delete runs", async () => {
    await asSuperuser(db);
    await db.exec(`set role service_role`);
    for (const op of [replace(1), { op: "clear_dex_record" as const }]) {
      await expect(
        db.query(`select apply_write_ops($1::jsonb)`, [JSON.stringify({ ops: [op] })]),
      ).rejects.toThrow(/runs only as the signed-in owner, not service_role/);
    }
    await db.exec(`reset role`);
    expect(await recordOf(OTHER)).toEqual({ rows: [5], fileTotal: 5 });
  });
});

/** Just the RPC definition from a migration file. */
function migrationFn(file: string): string {
  const sql = readFileSync(path.join(process.cwd(), "supabase", "migrations", file), "utf8");
  const at = sql.indexOf("\ncreate or replace function apply_write_ops(payload jsonb)");
  expect(at).toBeGreaterThan(0);
  return sql.slice(at);
}

describe("0026 · composes on 0024", () => {
  it("is 0024's function VERBATIM except the three deletes and the comment above them", () => {
    const base = migrationFn("0024_file_total_check.sql");
    const mine = migrationFn("0026_safeupdate_scoped_deletes.sql");
    const scoped = "delete from dex_presence where owner_id = auth.uid();";
    // Exactly three statements gained the owner; the verbatim comparison below pins everything else.
    expect(mine.split(scoped).length - 1).toBe(2);
    expect(mine.split("delete from dex_import where owner_id = auth.uid();").length - 1).toBe(1);
    const undone = mine
      .replaceAll(scoped, "delete from dex_presence;")
      .replace("delete from dex_import where owner_id = auth.uid();", "delete from dex_import;");
    const commentAt = (s: string) => [
      s.indexOf("      -- OWNER SCOPE IS RLS"),
      s.indexOf("\n\n      -- A full import REPLACES"),
    ];
    const [bFrom, bTo] = commentAt(base);
    const [mFrom, mTo] = commentAt(undone);
    expect(bFrom).toBeGreaterThan(0);
    expect(mFrom).toBeGreaterThan(0);
    expect(undone.slice(0, mFrom) + undone.slice(mTo)).toBe(base.slice(0, bFrom) + base.slice(bTo));
  });
});
