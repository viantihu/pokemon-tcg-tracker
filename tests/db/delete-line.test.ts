/**
 * UIL-118 — deleting a line that holds no card: migration 0029's `delete_line` op and lib/line/delete.ts, on a
 * fresh Postgres (PGlite), as the owner. Karvi moved misplaced cards out of her lines and was left with lines of
 * placeholders she could not remove; on Testing all 3 lines are exactly that (run 36280042139).
 *
 * Pinned:
 *   - one write removes the line, its slots and its wishes (open and resolved), and nothing else;
 *   - decision history keeps its label and loses its link;
 *   - refused, in her words and again in SQL, while it holds a card or a block, and when it is gone;
 *   - EVERY foreign key onto a line or a slot is accounted for (read from the catalog, so a future one fails here);
 *   - 0028's slot check runs on the delete and passes;
 *   - 0029 is 0028's function verbatim plus the one marked branch.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { checkLineDeletion, DELETE_LINE, deleteLine } from "@/lib/line/delete";
import { withLineSlotCheck, type WriteOp } from "@/lib/repo/write-ops";
import { applyOps, asOwner, asSuperuser, freshRpcDb, OWNER } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const BINDER = "b0000000-0000-4000-8000-000000000001";
const LINE = "10000000-0000-4000-8000-000000000001";
const OTHER = "10000000-0000-4000-8000-000000000002";
const [S0, S1, T0] = [
  "20000000-0000-4000-8000-000000000000",
  "20000000-0000-4000-8000-000000000001",
  "20000000-0000-4000-8000-0000000000f0",
];
const C0 = "30000000-0000-4000-8000-000000000000";
const [W_OPEN, W_DONE, W_OTHER] = [
  "40000000-0000-4000-8000-000000000001",
  "40000000-0000-4000-8000-000000000002",
  "40000000-0000-4000-8000-000000000003",
];
const DECISION = "50000000-0000-4000-8000-000000000001";

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  // Her case: a Charmander line of two placeholders, waiting on one card (an open wish) and once on another
  // (a resolved wish), with a decision row that names the line. And a second line that must be untouched.
  await db.exec(`
    insert into catalog_card (tcgdex_id, name) values ('sv03-004', 'Charmander'), ('sv03-005', 'Charmeleon');
    insert into binder (id, owner_id, name, type) values ('${BINDER}', '${OWNER}', 'KB-001', 'general');
    insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status) values
      ('${LINE}', '${OWNER}', 4, 'red', '${BINDER}', 'back', 'open'),
      ('${OTHER}', '${OWNER}', 7, 'light_blue', '${BINDER}', 'back', 'open');
    insert into line_slot (id, owner_id, line_id, stage_index, stage, state, target_catalog_card_id) values
      ('${S0}', '${OWNER}', '${LINE}', 0, 'Basic', 'placeholder', 'sv03-004'),
      ('${S1}', '${OWNER}', '${LINE}', 1, 'Stage1', 'placeholder', 'sv03-005'),
      ('${T0}', '${OWNER}', '${OTHER}', 0, 'Basic', 'placeholder', null);
    insert into wishlist_item (id, owner_id, line_slot_id, required_dex_id, resolved_at) values
      ('${W_OPEN}', '${OWNER}', '${S0}', 4, null),
      ('${W_DONE}', '${OWNER}', '${S1}', 5, now()),
      ('${W_OTHER}', '${OWNER}', '${T0}', 7, null);
    insert into placement_decision (id, owner_id, decision, reason, resolved_by, line_id, line_slot_id)
      values ('${DECISION}', '${OWNER}', 'line-new', 'Started the Charmander line.', 'auto', '${LINE}', '${S0}');
    insert into copy (id, owner_id, catalog_card_id, role, color_band) values
      ('${C0}', '${OWNER}', 'sv03-004', 'bulk', 'red');
  `);
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

async function q<T>(sql: string): Promise<T[]> {
  await asSuperuser(db);
  const r = await db.query<T>(sql);
  await asOwner(db);
  return r.rows;
}
const n = async (sql: string) => (await q<{ n: number }>(sql))[0].n;
async function seed(sql: string): Promise<void> {
  await asSuperuser(db);
  await db.exec(sql);
  await asOwner(db);
}
const client = () => pgliteClient(db);

describe("UIL-118 · a line that holds no card is deleted in one write", () => {
  it("says what goes: its empty slots and the cards on her wishlist it was waiting for", async () => {
    expect(await checkLineDeletion(client(), LINE)).toEqual({
      ok: true,
      deletion: { lineId: LINE, emptySlots: 2, openWishes: 1 },
    });
  });

  it("removes the line, its slots and its wishes, and nothing else", async () => {
    // PRE-FIX: nothing in the app could delete a line; there was no op to do it.
    await deleteLine(client(), LINE);
    expect(await n(`select count(*)::int n from evolution_line where id = '${LINE}'`)).toBe(0);
    expect(await n(`select count(*)::int n from line_slot where line_id = '${LINE}'`)).toBe(0);
    // Open AND resolved: the line was a mistake (the Senior BA's ruling A).
    expect(
      await n(`select count(*)::int n from wishlist_item where id in ('${W_OPEN}', '${W_DONE}')`),
    ).toBe(0);
    // The other line, its slot and its wish are untouched.
    expect(await n(`select count(*)::int n from evolution_line where id = '${OTHER}'`)).toBe(1);
    expect(await n(`select count(*)::int n from line_slot where id = '${T0}'`)).toBe(1);
    expect(await n(`select count(*)::int n from wishlist_item where id = '${W_OTHER}'`)).toBe(1);
    // Her card stays exactly where it was.
    expect(await q(`select role, line_slot_id from copy where id = '${C0}'`)).toEqual([
      { role: "bulk", line_slot_id: null },
    ]);
  });

  it("keeps the decision history's label, and only loses the link", async () => {
    await deleteLine(client(), LINE);
    expect(
      await q(
        `select decision, reason, line_id, line_slot_id from placement_decision where id = '${DECISION}'`,
      ),
    ).toEqual([
      {
        decision: "line-new",
        reason: "Started the Charmander line.",
        line_id: null,
        line_slot_id: null,
      },
    ]);
  });
});

describe("UIL-118 · refused, in her words, with nothing written", () => {
  it("a line that still holds a card", async () => {
    await seed(`
      update copy set role = 'shelved', binder_id = '${BINDER}', binder_half = 'back', line_slot_id = '${S0}'
       where id = '${C0}';
      update line_slot set state = 'filled', copy_id = '${C0}' where id = '${S0}';
    `);
    expect(await deleteLine(client(), LINE)).toEqual({
      ok: false,
      error: DELETE_LINE.holdsCards(1),
    });
    expect(DELETE_LINE.holdsCards(1)).toBe(
      "This line holds 1 card. Move it out first, then delete the line.",
    );
    expect(await n(`select count(*)::int n from line_slot where line_id = '${LINE}'`)).toBe(2);
  });

  it("a card that points at one of its slots, even with the slot not marked filled", async () => {
    await seed(`update copy set line_slot_id = '${S1}' where id = '${C0}';`);
    expect(await deleteLine(client(), LINE)).toEqual({
      ok: false,
      error: DELETE_LINE.holdsCards(1),
    });
  });

  it("a line with a block in her binder", async () => {
    await seed(`
      insert into binder_block (owner_id, binder_id, half, purpose, material, line_id)
        values ('${OWNER}', '${BINDER}', 'back', 'line-terminated', 'basicEnergy', '${LINE}');
    `);
    expect(await deleteLine(client(), LINE)).toEqual({ ok: false, error: DELETE_LINE.hasBlock });
    expect(await n(`select count(*)::int n from evolution_line where id = '${LINE}'`)).toBe(1);
  });

  it("a line that is already gone", async () => {
    await deleteLine(client(), LINE);
    expect(await deleteLine(client(), LINE)).toEqual({ ok: false, error: DELETE_LINE.gone });
  });
});

describe("0029 · the database refuses the same things, so a stale tab cannot delete a line that holds a card", () => {
  const del: WriteOp[] = [{ op: "delete_line", line_id: LINE }];
  const refusedInSql = () =>
    expect(applyOps(db, { ops: del })).rejects.toThrow(/delete_line refused/);

  it("a filled slot", async () => {
    await seed(`update line_slot set state = 'filled', copy_id = '${C0}' where id = '${S0}';`);
    await refusedInSql();
    expect(await n(`select count(*)::int n from wishlist_item where line_slot_id = '${S0}'`)).toBe(
      1,
    );
  });

  it("a copy pointing at a slot (the FK would silently null it and strand the card)", async () => {
    await seed(`update copy set line_slot_id = '${S1}' where id = '${C0}';`);
    await refusedInSql();
  });

  it("a binder block on the line", async () => {
    await seed(`
      insert into binder_block (owner_id, binder_id, half, purpose, material, line_id)
        values ('${OWNER}', '${BINDER}', 'back', 'line-terminated', 'basicEnergy', '${LINE}');
    `);
    await refusedInSql();
  });

  it("a line that does not exist", async () => {
    await expect(
      applyOps(db, {
        ops: [{ op: "delete_line", line_id: "10000000-0000-4000-8000-0000000000ff" }],
      }),
    ).rejects.toThrow(/delete_line found no such line/);
  });

  it("runs only as the signed-in owner", async () => {
    await asSuperuser(db);
    await expect(applyOps(db, { ops: del })).rejects.toThrow(/runs only as the signed-in owner/);
    await asOwner(db);
  });
});

describe("0029 · every foreign key onto a line or a slot is accounted for", () => {
  // Read from the catalog, not a hand-kept list (the Tech Lead's condition): a future FK fails here until the
  // delete either refuses on it, deletes it, or it is shown to be history that survives with its link nulled.
  const DELETED = ["line_slot.line_id", "wishlist_item.line_slot_id"];
  const REFUSED = ["copy.line_slot_id", "binder_block.line_id"];
  const HISTORY = ["placement_decision.line_id", "placement_decision.line_slot_id"];

  it("each is deleted by the op, refused by it, or is history that keeps its label", async () => {
    const fks = await q<{ ref: string; col: string; del: string }>(`
      select c.conrelid::regclass::text || '.' || a.attname as col,
             c.confrelid::regclass::text as ref,
             c.confdeltype as del
        from pg_constraint c
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
       where c.contype = 'f' and c.confrelid in ('evolution_line'::regclass, 'line_slot'::regclass)
       order by 1`);
    expect(fks.map((f) => f.col).sort()).toEqual([...DELETED, ...REFUSED, ...HISTORY].sort());
    // History survives the delete only because its FK nulls rather than cascades.
    for (const f of fks.filter((x) => HISTORY.includes(x.col))) expect(f.del).toBe("n");
  });
});

describe("0028's slot check runs on the delete, and passes", () => {
  it("withLineSlotCheck names the deleted line, and the check passes for a line that no longer exists", async () => {
    const ops = withLineSlotCheck([{ op: "delete_line", line_id: LINE }]);
    expect(ops.at(-1)).toEqual({
      op: "assert_line_slots",
      slot_ids: [],
      copy_ids: [],
      line_ids: [LINE],
    });
    await applyOps(db, { ops }); // the check runs after the delete, over a line that is gone
    expect(await n(`select count(*)::int n from evolution_line where id = '${LINE}'`)).toBe(0);
  });
});

/** Just the RPC definition from a migration file. */
function migrationFn(file: string): string {
  const sql = readFileSync(path.join(process.cwd(), "supabase", "migrations", file), "utf8");
  const at = sql.indexOf("\ncreate or replace function apply_write_ops(payload jsonb)");
  expect(at).toBeGreaterThan(0);
  return sql.slice(at);
}

describe("0029 · composes on 0028", () => {
  it("is 0028's function VERBATIM plus the one branch marked NEW in 0029", () => {
    const base = migrationFn("0028_assert_line_slots.sql");
    const mine = migrationFn("0029_delete_line.sql");
    const from = mine.indexOf("      -- NEW in 0029");
    const to = mine.indexOf(
      "      else\n        raise exception 'apply_write_ops: unknown op %'",
      from,
    );
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    expect(mine.slice(from, to)).toContain("when 'delete_line' then");
    expect(mine.slice(0, from) + mine.slice(to)).toBe(base);
  });
});
