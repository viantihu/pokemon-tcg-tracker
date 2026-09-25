/**
 * UIL-100 — migration 0022: the Dex record and the in-transaction count check, at the database.
 *
 * Karvi: "There needs to be some kind of validation in the sync that makes sure that the total number of
 * cards in the collection equal the dex import file." These tests pin the SQL half against the real
 * migration chain on PGlite, as the authenticated owner: what `assert_presence_counts` accepts, what it
 * refuses (whole transaction rolled back, keys named), that removals are subtracted exactly as the import
 * subtracts them, and that nothing is checked before her first recorded import.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { WriteOp } from "@/lib/repo/write-ops";
import { applyOps, asOwner, asSuperuser, freshRpcDb } from "../support/pglite-rpc";

const CHAR = "sv03-026"; // Charmander
const CHARM = "sv03-027"; // Charmeleon

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await db.exec(`
    insert into catalog_card (tcgdex_id, name, set_id, local_id)
      values ('${CHAR}', 'Charmander', 'sv03', '026'), ('${CHARM}', 'Charmeleon', 'sv03', '027');
  `);
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

let n = 0;
const uuid = () => {
  n += 1;
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
};

/** `count` grouped copies of one key, as an import would have created them. */
function copiesOps(
  card: string,
  variant: string,
  count: number,
): { ops: WriteOp[]; group: string } {
  const group = uuid();
  const ops: WriteOp[] = [
    {
      op: "insert_presence_group",
      id: group,
      catalog_card_id: card,
      dex_variant_raw: variant,
      desired_count: 0,
    },
  ];
  for (let i = 0; i < count; i++) {
    ops.push({
      op: "insert_copy",
      id: uuid(),
      catalog_card_id: card,
      variant: "normal",
      dex_variant_raw: variant,
      presence_group_id: group,
      role: "haul",
    });
  }
  return { ops, group };
}

async function counts() {
  await asSuperuser(db);
  const r = await db.query<{ copies: number; record: number; header: number }>(
    `select (select count(*)::int from copy) copies,
            (select coalesce(sum(quantity), 0)::int from dex_presence) record,
            (select count(*)::int from dex_import) header`,
  );
  await asOwner(db);
  return r.rows[0];
}

async function failureOf(ops: WriteOp[]): Promise<{ message: string; detail: unknown } | null> {
  try {
    await applyOps(db, { ops });
    return null;
  } catch (e) {
    const err = e as { message?: string; detail?: string };
    return {
      message: err.message ?? String(e),
      detail: err.detail ? JSON.parse(err.detail) : null,
    };
  }
}

const record = (
  rows: { card: string; variant: string; qty: number }[],
  fileTotal: number,
): WriteOp => ({
  op: "replace_dex_record",
  rows: rows.map((r) => ({ catalog_card_id: r.card, dex_variant_raw: r.variant, quantity: r.qty })),
  file_total: fileTotal,
  row_count: rows.length,
});

describe("UIL-100 · assert_presence_counts at the database", () => {
  it("passes when every key holds exactly what Dex said", async () => {
    const a = copiesOps(CHAR, "Normal", 2);
    const b = copiesOps(CHARM, "Normal", 1);
    await applyOps(db, {
      ops: [
        ...a.ops,
        ...b.ops,
        record(
          [
            { card: CHAR, variant: "Normal", qty: 2 },
            { card: CHARM, variant: "Normal", qty: 1 },
          ],
          3,
        ),
        { op: "assert_presence_counts", all: true },
      ],
    });
    expect(await counts()).toEqual({ copies: 3, record: 3, header: 1 });
  });

  it("REFUSES an extra copy, rolls the whole write back, and names the key in DETAIL", async () => {
    const a = copiesOps(CHAR, "Normal", 2); // Dex says 1
    const fail = await failureOf([
      ...a.ops,
      record([{ card: CHAR, variant: "Normal", qty: 1 }], 1),
      { op: "assert_presence_counts", all: true },
    ]);
    expect(fail?.message).toMatch(/presence count check failed on 1 key/);
    expect(fail?.detail).toEqual([
      { catalog_card_id: CHAR, dex_variant_raw: "Normal", dex: 1, removed: 0, have: 2 },
    ]);
    // Nothing survived: not the copies, not the record, not the header.
    expect(await counts()).toEqual({ copies: 0, record: 0, header: 0 });
  });

  it("REFUSES a missing copy too (Dex says 2, the write leaves 1)", async () => {
    const a = copiesOps(CHAR, "Normal", 1);
    const fail = await failureOf([
      ...a.ops,
      record([{ card: CHAR, variant: "Normal", qty: 2 }], 2),
      { op: "assert_presence_counts", all: true },
    ]);
    expect(fail?.detail).toEqual([
      { catalog_card_id: CHAR, dex_variant_raw: "Normal", dex: 2, removed: 0, have: 1 },
    ]);
  });

  it("a copy of a key Dex does not list at all is extra", async () => {
    const a = copiesOps(CHARM, "Reverse Holo", 1);
    const fail = await failureOf([
      ...a.ops,
      record([{ card: CHAR, variant: "Normal", qty: 1 }], 1),
      { op: "assert_presence_counts", all: true },
    ]);
    expect(fail?.detail).toContainEqual({
      catalog_card_id: CHARM,
      dex_variant_raw: "Reverse Holo",
      dex: 0,
      removed: 0,
      have: 1,
    });
  });

  it("subtracts removals exactly like the import: Dex 2, removed 1, one copy left is CORRECT", async () => {
    const a = copiesOps(CHAR, "Normal", 1);
    await applyOps(db, {
      ops: [
        ...a.ops,
        {
          op: "remember_removed_presence",
          catalog_card_id: CHAR,
          dex_variant_raw: "Normal",
          delta: 1,
        },
        record([{ card: CHAR, variant: "Normal", qty: 2 }], 2),
        { op: "assert_presence_counts", all: true },
      ],
    });
    expect(await counts()).toMatchObject({ copies: 1, record: 2 });
  });

  it("removals beyond Dex's quantity floor at zero, never negative", async () => {
    await applyOps(db, {
      ops: [
        {
          op: "remember_removed_presence",
          catalog_card_id: CHAR,
          dex_variant_raw: "Normal",
          delta: 3,
        },
        record([{ card: CHAR, variant: "Normal", qty: 1 }], 1),
        { op: "assert_presence_counts", all: true },
      ],
    });
    expect(await counts()).toMatchObject({ copies: 0 });
  });

  it("checks only the keys it is given when not `all`, so drift elsewhere cannot block a local write", async () => {
    const drift = copiesOps(CHARM, "Normal", 2);
    await applyOps(db, {
      ops: [...drift.ops, record([{ card: CHAR, variant: "Normal", qty: 1 }], 1)],
    });
    const a = copiesOps(CHAR, "Normal", 1);
    await applyOps(db, {
      ops: [
        ...a.ops,
        {
          op: "assert_presence_counts",
          keys: [{ catalog_card_id: CHAR, dex_variant_raw: "Normal" }],
        },
      ],
    });
    expect((await counts()).copies).toBe(3);
  });

  it("passes with NO header: before her first recorded import there is nothing to check against", async () => {
    const a = copiesOps(CHAR, "Normal", 5);
    await applyOps(db, { ops: [...a.ops, { op: "assert_presence_counts", all: true }] });
    expect(await counts()).toEqual({ copies: 5, record: 0, header: 0 });
  });

  it("add_dex_presence accumulates on the key; the file-level total does not move", async () => {
    await applyOps(db, { ops: [record([{ card: CHAR, variant: "Normal", qty: 1 }], 3)] });
    await applyOps(db, {
      ops: [
        { op: "add_dex_presence", catalog_card_id: CHAR, dex_variant_raw: "Normal", quantity: 2 },
        { op: "add_dex_presence", catalog_card_id: CHARM, dex_variant_raw: "Normal", quantity: 1 },
        { op: "add_dex_presence", catalog_card_id: CHARM, dex_variant_raw: "Holo", quantity: 0 },
      ],
    });
    await asSuperuser(db);
    const rows = await db.query(
      `select catalog_card_id, dex_variant_raw, quantity from dex_presence order by 1, 2`,
    );
    const header = await db.query<{ file_total: number }>(`select file_total from dex_import`);
    expect(rows.rows).toEqual([
      { catalog_card_id: CHAR, dex_variant_raw: "Normal", quantity: 3 },
      { catalog_card_id: CHARM, dex_variant_raw: "Normal", quantity: 1 },
    ]);
    expect(header.rows[0].file_total).toBe(3);
  });

  it("replace_dex_record replaces; clear_dex_record removes the record and the header", async () => {
    await applyOps(db, { ops: [record([{ card: CHAR, variant: "Normal", qty: 4 }], 4)] });
    await applyOps(db, { ops: [record([{ card: CHARM, variant: "Normal", qty: 1 }], 1)] });
    expect(await counts()).toMatchObject({ record: 1, header: 1 });
    await applyOps(db, { ops: [{ op: "clear_dex_record" }] });
    expect(await counts()).toMatchObject({ record: 0, header: 0 });
  });

  it("shrink_removed_presence takes part of a memory back, and deletes it at zero", async () => {
    const key = { catalog_card_id: CHAR, dex_variant_raw: "Normal" };
    await applyOps(db, { ops: [{ op: "remember_removed_presence", ...key, delta: 3 }] });
    await applyOps(db, { ops: [{ op: "shrink_removed_presence", ...key, by: 1 }] });
    await asSuperuser(db);
    expect((await db.query(`select count from removed_presence`)).rows).toEqual([{ count: 2 }]);
    await asOwner(db);
    await applyOps(db, { ops: [{ op: "shrink_removed_presence", ...key, by: 5 }] });
    await applyOps(db, { ops: [{ op: "shrink_removed_presence", ...key, by: 1 }] }); // no memory: no-op
    await asSuperuser(db);
    expect((await db.query(`select count(*)::int n from removed_presence`)).rows).toEqual([
      { n: 0 },
    ]);
    await asOwner(db);
  });

  it("the record-wide deletes refuse to run as anything but the signed-in owner", async () => {
    await asSuperuser(db); // bypasses RLS, like the service role: an unscoped delete would clear everyone
    await expect(applyOps(db, { ops: [{ op: "clear_dex_record" }] })).rejects.toThrow(
      /runs only as the signed-in owner/,
    );
    await expect(applyOps(db, { ops: [record([], 0)] })).rejects.toThrow(
      /runs only as the signed-in owner/,
    );
    await asOwner(db);
  });

  it("one owner's record is invisible to another", async () => {
    await applyOps(db, { ops: [record([{ card: CHAR, variant: "Normal", qty: 1 }], 1)] });
    await db.exec(
      `select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000ff', false);`,
    );
    const seen = await db.query(`select count(*)::int n from dex_presence`);
    expect(seen.rows[0]).toEqual({ n: 0 });
    // And her check does not run against another owner's header: no header for this owner, so it passes.
    const a = copiesOps(CHAR, "Normal", 3);
    await applyOps(db, { ops: [...a.ops, { op: "assert_presence_counts", all: true }] });
  });
});

/** Just the RPC definition from a migration file, for the composition claim below. */
function migrationFn(file: string): string {
  const sql = readFileSync(path.join(process.cwd(), "supabase", "migrations", file), "utf8");
  const at = sql.indexOf("\ncreate or replace function apply_write_ops(payload jsonb)");
  expect(at).toBeGreaterThan(0);
  return sql.slice(at);
}

describe("UIL-100 · migration 0022 composes on 0021", () => {
  it("is 0021's function VERBATIM plus the five branches marked NEW in 0022, and nothing else", () => {
    const base = migrationFn("0021_wishlist_slot_ops.sql");
    const mine = migrationFn("0022_dex_record.sql");
    const from = mine.indexOf("      -- NEW in 0022");
    const to = mine.indexOf(
      "      else\n        raise exception 'apply_write_ops: unknown op %'",
      from,
    );
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const added = mine.slice(from, to);
    for (const op of [
      "replace_dex_record",
      "clear_dex_record",
      "add_dex_presence",
      "shrink_removed_presence",
      "assert_presence_counts",
    ]) {
      expect(added).toContain(`when '${op}' then`);
    }
    expect(mine.slice(0, from) + mine.slice(to)).toBe(base);
  });
});
