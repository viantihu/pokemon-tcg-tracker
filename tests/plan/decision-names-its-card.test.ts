/**
 * UIL-094 (migration 0025) — placement history keeps the card it is about.
 *
 * `placement_decision.copy_id` is ON DELETE SET NULL, so a retired or removed card used to leave decision
 * rows that named nothing. 0025 adds `catalog_card_id` / `variant` / `dex_variant_raw`, fills them from the
 * copy whenever a decision about a copy is written (a BEFORE INSERT trigger, so every writer is covered,
 * present and future), and backfills the rows whose copy still exists.
 *
 * The Senior BA's conditions, pinned here: a decision whose copy_id is NULL at insert stays unnamed (no
 * guessing); the migration never touches `apply_write_ops`; and — the promise itself — a decision keeps its
 * card after the copy is gone. Real Postgres (PGlite), real RLS, the real RPC.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { buildRemoveCopyOps } from "@/lib/copy/remove";
import {
  applyMigration,
  applyOps,
  asOwner,
  asSuperuser,
  freshRpcDb,
  MIGRATIONS,
  MIGRATIONS_DIR,
  OWNER,
  seedCatalogCards,
} from "../support/pglite-rpc";

const FILE = "0025_decision_names_its_card.sql";
const SQL = readFileSync(path.join(MIGRATIONS_DIR, FILE), "utf8");
const CARD = "sv03-026";
const COPY = "c0000000-0000-4000-8000-000000000001";
const OTHER_OWNER = "00000000-0000-0000-0000-0000000000ff";
const OTHER_COPY = "c0000000-0000-4000-8000-0000000000ff";

let db: PGlite;
afterEach(async () => {
  await db?.close();
});

async function seedCopy(id = COPY, owner = OWNER): Promise<void> {
  await asSuperuser(db);
  await db.query(
    `insert into copy (id, owner_id, catalog_card_id, variant, dex_variant_raw, role)
       values ($1, $2, $3, 'reverse', 'Reverse Holo', 'haul')`,
    [id, owner, CARD],
  );
}
async function decisions() {
  await asSuperuser(db);
  const r = await db.query<{
    id: string;
    copy_id: string | null;
    catalog_card_id: string | null;
    variant: string | null;
    dex_variant_raw: string | null;
  }>(
    `select id, copy_id, catalog_card_id, variant, dex_variant_raw from placement_decision order by id`,
  );
  return r.rows;
}
const decision = (id: string, copyId: string | null, extra: Record<string, string> = {}) =>
  ({
    op: "insert_decision",
    id,
    haul_id: null,
    copy_id: copyId,
    decision: "test",
    reason: "test",
    resolved_by: "user",
    ...extra,
  }) as never;

describe("UIL-094 · 0025's shape", () => {
  it("is migration 0025, and never replaces apply_write_ops", () => {
    expect(MIGRATIONS).toContain(FILE);
    expect(SQL).not.toMatch(/create\s+(or\s+replace\s+)?function\s+(public\.)?apply_write_ops/i);
  });

  it("adds the three columns with NO foreign key — a label that must outlive the catalog", async () => {
    db = await freshRpcDb();
    const fks = await db.query<{ n: number }>(
      `select count(*)::int n from information_schema.key_column_usage k
         join information_schema.table_constraints t on t.constraint_name = k.constraint_name
        where t.constraint_type = 'FOREIGN KEY' and k.table_name = 'placement_decision'
          and k.column_name in ('catalog_card_id', 'variant', 'dex_variant_raw')`,
    );
    expect(fks.rows[0].n).toBe(0);
    const cols = await db.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns
        where table_name = 'placement_decision'
          and column_name in ('catalog_card_id', 'variant', 'dex_variant_raw') order by column_name`,
    );
    expect(cols.rows).toEqual([
      { column_name: "catalog_card_id", is_nullable: "YES" },
      { column_name: "dex_variant_raw", is_nullable: "YES" },
      { column_name: "variant", is_nullable: "YES" },
    ]);
  });

  it("the trigger function is SECURITY INVOKER with a pinned search_path", async () => {
    db = await freshRpcDb();
    const fn = await db.query<{ secdef: boolean; config: string[] | null }>(
      `select prosecdef as secdef, proconfig as config from pg_proc
        where proname = 'placement_decision_name_its_card'`,
    );
    expect(fn.rows).toEqual([{ secdef: false, config: ["search_path=public, pg_temp"] }]);
  });
});

describe("UIL-094 · a decision names its card", () => {
  it("a decision about a copy is named from it, by whichever writer inserts it", async () => {
    db = await freshRpcDb();
    await seedCatalogCards(db, [CARD]);
    await seedCopy();
    await asOwner(db);
    await applyOps(db, { ops: [decision("d0000000-0000-4000-8000-000000000001", COPY)] });
    expect(await decisions()).toEqual([
      {
        id: "d0000000-0000-4000-8000-000000000001",
        copy_id: COPY,
        catalog_card_id: CARD,
        variant: "reverse",
        dex_variant_raw: "Reverse Holo",
      },
    ]);
  });

  it("…and KEEPS it after the copy is gone — 'Not mine' writes the decision, then deletes the copy", async () => {
    // The UIL-094 promise, through the real removal op list (decision first, delete second, one txn).
    db = await freshRpcDb();
    await seedCatalogCards(db, [CARD]);
    await seedCopy();
    await asOwner(db);
    const ops = buildRemoveCopyOps({
      copy: {
        id: COPY,
        haul_id: null,
        catalog_card_id: CARD,
        variant: "reverse",
        dex_variant_raw: "Reverse Holo",
      } as never,
      reopenSlotId: null,
      demoteLineId: null,
      formerPlacement: "in your haul",
      rememberKey: null,
    });
    // The order the trigger depends on: the decision BEFORE the delete.
    expect(ops.map((o) => o.op)).toEqual(["insert_decision", "delete_copy"]);
    await applyOps(db, { ops });
    const [row] = await decisions();
    expect(row.copy_id).toBeNull(); // ON DELETE SET NULL, as ever
    expect(row).toMatchObject({
      catalog_card_id: CARD,
      variant: "reverse",
      dex_variant_raw: "Reverse Holo",
    });
  });

  it("a decision whose copy_id is NULL at insert stays unnamed — the trigger never guesses", async () => {
    db = await freshRpcDb();
    await seedCatalogCards(db, [CARD]);
    await seedCopy(); // a copy EXISTS, so a guess would have something to find
    await asOwner(db);
    await applyOps(db, { ops: [decision("d0000000-0000-4000-8000-000000000002", null)] });
    expect(await decisions()).toMatchObject([
      { copy_id: null, catalog_card_id: null, variant: null, dex_variant_raw: null },
    ]);
  });

  it("a name the writer supplies is never overwritten (the Production promotion copies it)", async () => {
    db = await freshRpcDb();
    await seedCatalogCards(db, [CARD, "sv03-027"]);
    await seedCopy();
    await asSuperuser(db);
    await db.query(
      `insert into placement_decision (owner_id, copy_id, decision, reason, resolved_by, catalog_card_id, variant, dex_variant_raw)
         values ($1, $2, 'test', 'test', 'user', 'sv03-027', 'normal', 'Normal')`,
      [OWNER, COPY],
    );
    expect(await decisions()).toMatchObject([
      { catalog_card_id: "sv03-027", variant: "normal", dex_variant_raw: "Normal" },
    ]);
  });

  it("reads the copy under the caller's RLS: another owner's copy is never named", async () => {
    db = await freshRpcDb();
    await seedCatalogCards(db, [CARD]);
    await seedCopy(OTHER_COPY, OTHER_OWNER);
    await asOwner(db);
    // The FK check does not apply RLS, so the row inserts; the trigger must still see nothing.
    await applyOps(db, { ops: [decision("d0000000-0000-4000-8000-000000000003", OTHER_COPY)] });
    expect(await decisions()).toMatchObject([{ copy_id: OTHER_COPY, catalog_card_id: null }]);
  });
});

describe("UIL-094 · the backfill, against rows written before 0025", () => {
  it("names every decision whose copy still exists, and leaves the rest unnamed", async () => {
    db = await freshRpcDb({ before: "0025" });
    await seedCatalogCards(db, [CARD]);
    await seedCopy();
    await asSuperuser(db);
    await db.query(
      `insert into placement_decision (id, owner_id, copy_id, decision, reason, resolved_by) values
         ('d0000000-0000-4000-8000-00000000000a', $1, $2, 'placed', 'placed', 'user'),
         ('d0000000-0000-4000-8000-00000000000b', $1, $2, 'moved', 'moved', 'user'),
         ('d0000000-0000-4000-8000-00000000000c', $1, null, 'retired', 'Removed — sv03-026 normal', 'user')`,
      [OWNER, COPY],
    );
    const b1 = 3;
    const b2 = 2; // copy_id NOT NULL
    const b3 = 1; // copy_id NULL

    await applyMigration(db, FILE);

    const rows = await decisions();
    // The AFTER identities QA checks on Testing, exactly as the plan states them.
    expect(rows).toHaveLength(b1);
    expect(rows.filter((r) => r.catalog_card_id !== null)).toHaveLength(b2);
    expect(rows.filter((r) => r.copy_id !== null && r.catalog_card_id === null)).toHaveLength(0);
    expect(rows.filter((r) => r.copy_id === null && r.catalog_card_id === null)).toHaveLength(b3);
    // Reasons are not parsed: the retired row's text names a card, and it still stays unnamed.
    expect(rows.find((r) => r.id.endsWith("0c"))?.catalog_card_id).toBeNull();
  });
});
