/**
 * UIL-117 PR 1 — migration 0028: the database holds a line slot and its card together (UIL-087).
 *
 * A filled slot is one fact stored twice: `line_slot.copy_id` names the card, and the card's `copy.line_slot_id`
 * names the slot, with the card shelved in the line's binder, back half. UIL-062, UIL-063 and UIL-087 were each
 * a writer that set one side and not the other, and until 0028 only tests held the two together. Now
 * `apply_write_ops` refuses a write that leaves them apart, and `applyWriteOps` asks it to on every write that
 * touches a copy or a slot. Real Postgres (PGlite, every migration on disk), as the authenticated owner.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  applyWriteOps,
  touchedLineState,
  withLineSlotCheck,
  type WriteOp,
} from "@/lib/repo/write-ops";
import { applyOps, asOwner, asSuperuser, freshRpcDb, OWNER } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const BINDER = "b0000000-0000-4000-8000-000000000001";
const OTHER_BINDER = "b0000000-0000-4000-8000-000000000002";
const LINE = "10000000-0000-4000-8000-000000000001";
const [S0, S1] = ["20000000-0000-4000-8000-000000000000", "20000000-0000-4000-8000-000000000001"];
const [C0, C1] = ["30000000-0000-4000-8000-000000000000", "30000000-0000-4000-8000-000000000001"];

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await db.exec(`
    insert into catalog_card (tcgdex_id, name) values ('sv03-004', 'Charmander'), ('sv03-005', 'Charmeleon');
    insert into binder (id, owner_id, name, type) values
      ('${BINDER}', '${OWNER}', 'KB-001', 'general'), ('${OTHER_BINDER}', '${OWNER}', 'KB-002', 'general');
    insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
      values ('${LINE}', '${OWNER}', 4, 'red', '${BINDER}', 'back', 'open');
    insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id, target_catalog_card_id)
      values ('${S0}', '${OWNER}', '${LINE}', 0, 'Basic', 'placeholder', null, 'sv03-004'),
             ('${S1}', '${OWNER}', '${LINE}', 1, 'Stage1', 'placeholder', null, 'sv03-005');
    insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band) values
      ('${C0}', '${OWNER}', 'sv03-004', 'bulk', null, null, 'red'),
      ('${C1}', '${OWNER}', 'sv03-005', 'bulk', null, null, 'red');
  `);
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

/** Fill S0 with C0 correctly: both pointers, shelved, the line's binder, back half. */
const fillS0: WriteOp[] = [
  { op: "update_slot", id: S0, patch: { state: "filled", copy_id: C0 } },
  {
    op: "update_copy",
    id: C0,
    patch: { role: "shelved", binder_id: BINDER, binder_half: "back", line_slot_id: S0 },
  },
];
const check = (slot_ids: string[], copy_ids: string[] = [], line_ids: string[] = []): WriteOp => ({
  op: "assert_line_slots",
  slot_ids,
  copy_ids,
  line_ids,
});
const refused = (ops: WriteOp[]) =>
  expect(applyOps(db, { ops })).rejects.toThrow(/line slot check failed/);

async function state() {
  await asSuperuser(db);
  const s = (
    await db.query<{ state: string; copy_id: string | null }>(
      `select state, copy_id from line_slot where id = $1`,
      [S0],
    )
  ).rows[0];
  const c = (
    await db.query<{ role: string; line_slot_id: string | null }>(
      `select role, line_slot_id from copy where id = $1`,
      [C0],
    )
  ).rows[0];
  await asOwner(db);
  return { s, c };
}

describe("0028 · a correct slot passes", () => {
  it("a slot filled on both sides, shelved in the line's binder, back half", async () => {
    await applyOps(db, { ops: [...fillS0, check([S0], [C0])] });
    expect((await state()).s).toEqual({ state: "filled", copy_id: C0 });
  });

  it("an empty placeholder no copy points at, and a write that names nothing", async () => {
    await applyOps(db, { ops: [check([S0, S1])] });
    await applyOps(db, { ops: [check([], [])] });
  });
});

describe("0028 · every half-written shape is refused, and the whole write rolls back", () => {
  it.each<[string, WriteOp[]]>([
    [
      "filled with no copy (the slot side only)",
      [{ op: "update_slot", id: S0, patch: { state: "filled", copy_id: null } }],
    ],
    [
      "the copy does not point back (UIL-062's override)",
      [
        { op: "update_slot", id: S0, patch: { state: "filled", copy_id: C0 } },
        {
          op: "update_copy",
          id: C0,
          patch: { role: "shelved", binder_id: BINDER, binder_half: "back" },
        },
      ],
    ],
    [
      "the copy is not shelved (UIL-087's bulk pull)",
      [
        { op: "update_slot", id: S0, patch: { state: "filled", copy_id: C0 } },
        {
          op: "update_copy",
          id: C0,
          patch: { binder_id: BINDER, binder_half: "back", line_slot_id: S0 },
        },
      ],
    ],
    [
      "the copy is in another binder",
      [
        { op: "update_slot", id: S0, patch: { state: "filled", copy_id: C0 } },
        {
          op: "update_copy",
          id: C0,
          patch: {
            role: "shelved",
            binder_id: OTHER_BINDER,
            binder_half: "back",
            line_slot_id: S0,
          },
        },
      ],
    ],
    [
      "the copy is in the front half",
      [
        { op: "update_slot", id: S0, patch: { state: "filled", copy_id: C0 } },
        {
          op: "update_copy",
          id: C0,
          patch: { role: "shelved", binder_id: BINDER, binder_half: "front", line_slot_id: S0 },
        },
      ],
    ],
    [
      "a copy points at a slot that is not filled (the copy side only)",
      [
        {
          op: "update_copy",
          id: C1,
          patch: { role: "shelved", binder_id: BINDER, binder_half: "back", line_slot_id: S1 },
        },
      ],
    ],
  ])("%s", async (_, ops) => {
    await refused([...ops, check([S0, S1], [C0, C1])]);
    expect((await state()).s).toEqual({ state: "placeholder", copy_id: null });
  });

  it("a second copy pointing at a filled slot", async () => {
    await applyOps(db, { ops: [...fillS0, check([S0], [C0])] });
    await refused([
      {
        op: "update_copy",
        id: C1,
        patch: { role: "shelved", binder_id: BINDER, binder_half: "back", line_slot_id: S0 },
      },
      check([], [C1]),
    ]);
  });

  it("the slot names one copy while ANOTHER copy is the one pointing at it (one pointer, the wrong one)", async () => {
    await refused([
      { op: "update_slot", id: S0, patch: { state: "filled", copy_id: C0 } },
      {
        op: "update_copy",
        id: C0,
        patch: { role: "shelved", binder_id: BINDER, binder_half: "back" },
      },
      {
        op: "update_copy",
        id: C1,
        patch: { role: "shelved", binder_id: BINDER, binder_half: "back", line_slot_id: S0 },
      },
      check([S0], [C0, C1]),
    ]);
  });

  it("deleting a slotted copy without releasing its slot: found even though nothing names that slot", async () => {
    await applyOps(db, { ops: [...fillS0, check([S0], [C0])] });
    // ON DELETE SET NULL empties the slot's copy_id and leaves it `filled`: the always-checked shape.
    await refused([{ op: "delete_copy", id: C0 }, check([], [C0])]);
    expect((await state()).c).toMatchObject({ line_slot_id: S0 }); // rolled back: the copy is still there
  });

  it("names what failed, and why, in the error detail", async () => {
    let detail = "";
    try {
      await applyOps(db, {
        ops: [
          { op: "update_slot", id: S0, patch: { state: "filled", copy_id: null } },
          check([S0]),
        ],
      });
    } catch (e) {
      detail = String((e as { detail?: string }).detail ?? "");
    }
    expect(JSON.parse(detail)).toEqual([{ slot: S0, why: "filled with no copy" }]);
  });
});

// 0028's "complete only when every slot is filled" rule held a word that 0034 retired: a line is OPEN or CLOSED.
describe("0034 · 'complete' is no longer a line status; a full line reads closed", () => {
  it("writing 'complete' is refused by the status check, and nothing is written", async () => {
    await applyOps(db, { ops: [...fillS0, check([S0], [C0])] });
    await expect(
      applyOps(db, {
        ops: [
          { op: "update_line", id: LINE, patch: { status: "complete" } },
          check([], [], [LINE]),
        ],
      }),
    ).rejects.toThrow(/evolution_line_status_check/);
  });

  it("closed with every slot filled passes", async () => {
    await applyOps(db, {
      ops: [
        ...fillS0,
        { op: "update_slot", id: S1, patch: { state: "filled", copy_id: C1 } },
        {
          op: "update_copy",
          id: C1,
          patch: { role: "shelved", binder_id: BINDER, binder_half: "back", line_slot_id: S1 },
        },
        { op: "update_line", id: LINE, patch: { status: "closed" } },
        check([S0, S1], [C0, C1], [LINE]),
      ],
    });
  });
});

describe("0028 · it checks what the write touched, not the whole collection", () => {
  it("a copy's own slot is checked when only the copy is named (a copy that moves binder breaks its slot)", async () => {
    await applyOps(db, { ops: [...fillS0, check([S0], [C0])] });
    await refused([
      { op: "update_copy", id: C0, patch: { binder_id: OTHER_BINDER } },
      check([], [C0]),
    ]);
  });

  it("a broken slot the write never touched does not block it (only an empty filled slot always does)", async () => {
    await asSuperuser(db);
    // Pre-existing, unnamed: C1 points at S1, which is not filled.
    await db.query(
      `update copy set line_slot_id = $1, role = 'shelved', binder_id = $2, binder_half = 'back' where id = $3`,
      [S1, BINDER, C1],
    );
    await asOwner(db);
    await applyOps(db, { ops: [...fillS0, check([S0], [C0])] });
  });
});

describe("applyWriteOps asks for the check on every write that touches a copy or a slot", () => {
  it("collects the slots and copies each op touches", () => {
    expect(
      touchedLineState([
        { op: "update_slot", id: S0, patch: { copy_id: C0 } },
        { op: "update_copy", id: C1, patch: { line_slot_id: S1 } },
        { op: "delete_copy", id: "d" },
        { op: "update_line", id: LINE, patch: { status: "open" } },
      ]),
    ).toEqual({ slotIds: [S0, S1], copyIds: [C0, C1, "d"], lineIds: [LINE] });
  });

  it("appends it LAST, once; leaves a write that touches neither alone", () => {
    const ops = withLineSlotCheck(fillS0);
    expect(ops.at(-1)).toEqual({
      op: "assert_line_slots",
      slot_ids: [S0],
      copy_ids: [C0],
      line_ids: [],
    });
    expect(withLineSlotCheck(ops).filter((o) => o.op === "assert_line_slots")).toHaveLength(1);
    const untouched: WriteOp[] = [
      { op: "union_collection_targets", collection_id: "col", catalog_card_ids: ["sv03-004"] },
    ];
    expect(withLineSlotCheck(untouched)).toEqual(untouched);
  });

  it("so an app write that half-writes a slot is refused through the real client", async () => {
    await expect(
      applyWriteOps(pgliteClient(db), {
        ops: [{ op: "update_slot", id: S0, patch: { state: "filled", copy_id: C0 } }],
      }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/line slot check failed/) });
    await applyWriteOps(pgliteClient(db), { ops: fillS0 });
    expect((await state()).s).toEqual({ state: "filled", copy_id: C0 });
  });
});

/** Just the RPC definition from a migration file. */
function migrationFn(file: string): string {
  const sql = readFileSync(path.join(process.cwd(), "supabase", "migrations", file), "utf8");
  const at = sql.indexOf("\ncreate or replace function apply_write_ops(payload jsonb)");
  expect(at).toBeGreaterThan(0);
  return sql.slice(at);
}

describe("0028 · composes on 0026, and indexes the back-pointer", () => {
  it("is 0026's function VERBATIM plus the one branch marked NEW in 0028", () => {
    const base = migrationFn("0026_safeupdate_scoped_deletes.sql");
    const mine = migrationFn("0028_assert_line_slots.sql");
    const from = mine.indexOf("      -- NEW in 0028");
    const to = mine.indexOf(
      "      else\n        raise exception 'apply_write_ops: unknown op %'",
      from,
    );
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    expect(mine.slice(from, to)).toContain("when 'assert_line_slots' then");
    expect(mine.slice(0, from) + mine.slice(to)).toBe(base);
  });

  it("adds the partial index on copy (line_slot_id)", async () => {
    await asSuperuser(db);
    const r = await db.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where indexname = 'copy_line_slot_idx'`,
    );
    expect(r.rows[0]?.indexdef).toMatch(/\(line_slot_id\) WHERE \(line_slot_id IS NOT NULL\)/);
  });
});
