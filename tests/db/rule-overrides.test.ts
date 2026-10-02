/**
 * Migration 0037 — her rules are recommendations, and she can override every one of them.
 *
 * Karvi, 2026-10-01/02: "The rules should exist only for the recommendation engine. Users should always be able to
 * override all rules." The app recommends, warns in her words, and lets her do it anyway. A write names the rule it
 * overrides (`overrides`, a closed set of five keys) and records it on a decision in the same write; integrity has no
 * key, so it cannot be named, so it cannot be overridden.
 *
 *   1. The closed set: an unknown or non-string key is refused with nothing written; the five are accepted and
 *      recorded on `placement_decision.overrides`; a decision with none stores '{}'.
 *   2. line_min_stages: a one-card line passes only with the key AND a decision recording it.
 *   3. bulk_box_full: a card into a full box, and a deleted box's cards into a box without room.
 *   4. Each key relaxes only its own rule.
 *   5. Integrity refuses with ALL FIVE keys declared and recorded.
 *   6. The setting the copy trigger reads does not outlive the write.
 *
 * Real Postgres (PGlite, every migration), the real `apply_write_ops`, as the authenticated owner.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  OVERRIDE_RULES,
  type OverrideRule,
  type WriteOp,
  withCopyBinderCheck,
  withLineSlotCheck,
} from "@/lib/repo/write-ops";
import {
  applyMigration,
  applyOps,
  asOwner,
  asSuperuser,
  freshRpcDb,
  OWNER,
  seedBinders,
} from "../support/pglite-rpc";

const GEN = "b0000000-0000-4000-8000-000000000037";
const OTHER = "00000000-0000-4000-8000-0000000000b7";
const id = (n: number, prefix: string) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const COPY = (n: number) => id(n, "c0000000");
const BOX = (n: number) => id(n, "d0000000");
const DEC = (n: number) => id(n, "e0000000");
const LINE = id(37, "10000000");
const SLOT = (n: number) => id(n, "20000000");
const ALL: OverrideRule[] = [...OVERRIDE_RULES];

let db: PGlite;
afterEach(async () => {
  if (db && !db.closed) await db.close();
});

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  await asSuperuser(db);
  return (await db.query<T>(sql, params)).rows;
}

interface Refusal {
  message: string;
  code?: string;
  detail?: string;
}
/** The write as her, with both checks appended as `applyWriteOps` appends them, and the overrides she declared. */
async function write(ops: WriteOp[], overrides: OverrideRule[] = []) {
  await asOwner(db);
  await applyOps(db, { ops: withCopyBinderCheck(withLineSlotCheck(ops)), overrides });
}
/** The raw RPC body, for shapes the types forbid (a non-string key). */
async function raw(body: unknown) {
  await asOwner(db);
  await db.query(`select apply_write_ops($1::jsonb)`, [JSON.stringify(body)]);
}
/** The refusal a write raised: its words, its errcode and its detail. */
async function refusal(p: Promise<unknown>): Promise<Refusal> {
  try {
    await p;
  } catch (e) {
    const err = e as Refusal;
    return { message: err.message, code: err.code, detail: err.detail };
  }
  throw new Error("expected the write to be refused");
}
/** Her decision, recording the rules she overrode. */
const decision = (
  n: number,
  overrides?: OverrideRule[],
  copyId: string | null = null,
): WriteOp => ({
  op: "insert_decision",
  id: DEC(n),
  haul_id: null,
  copy_id: copyId,
  decision: "her override",
  reason: "she chose it",
  resolved_by: "user",
  ...(overrides ? { overrides } : {}),
});
const decisionOverrides = async (n: number) =>
  (
    await q<{ overrides: string[] }>(`select overrides from placement_decision where id = $1`, [
      DEC(n),
    ])
  )[0]?.overrides;
const decisions = async () =>
  (await q<{ n: number }>(`select count(*)::int n from placement_decision`))[0].n;

const addBox = (n: number, name: string, capacity: number | null = null): WriteOp => ({
  op: "insert_bulk_unit",
  id: BOX(n),
  name,
  capacity,
});
async function bulkCopy(n: number, box: number) {
  await q(
    `insert into copy (id, owner_id, catalog_card_id, role, bulk_unit_id) values ($1, $2, 'emberling', 'bulk', $3)`,
    [COPY(n), OWNER, BOX(box)],
  );
}
async function shelved(n: number, card = "emberling") {
  await q(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
       values ($1, $2, $3, 'shelved', $4, 'front', 'red')`,
    [COPY(n), OWNER, card, GEN],
  );
}
const boxOf = async (n: number) =>
  (
    await q<{ role: string; unit: string | null }>(
      `select role, bulk_unit_id as unit from copy where id = $1`,
      [COPY(n)],
    )
  )[0];
const held = async (box: number) =>
  (
    await q<{ n: number }>(
      `select count(*)::int n from copy where bulk_unit_id = $1 and role = 'bulk'`,
      [BOX(box)],
    )
  )[0].n;
const toBox = (n: number, box: number): WriteOp => ({
  op: "update_copy",
  id: COPY(n),
  patch: {
    role: "bulk",
    binder_id: null,
    binder_half: null,
    color_band: null,
    bulk_unit_id: BOX(box),
  },
});

/** Her Basic, shelved into a NEW one-card line: the shape the line_min_stages rule refuses. */
const oneCardLine = (n: number): WriteOp[] => [
  {
    op: "insert_line",
    id: LINE,
    root_dex_id: 9301,
    color_band: "red",
    binder_id: GEN,
    half: "back",
    status: "closed",
  },
  {
    op: "insert_slot",
    id: SLOT(0),
    line_id: LINE,
    stage_index: 0,
    stage: "Basic",
    state: "filled",
    copy_id: COPY(n),
    target_catalog_card_id: null,
    note: null,
  },
  { op: "update_copy", id: COPY(n), patch: { binder_half: "back", line_slot_id: SLOT(0) } },
];
const lines = async () =>
  (await q<{ n: number }>(`select count(*)::int n from evolution_line where id = $1`, [LINE]))[0].n;

beforeEach(async () => {
  db = await freshRpcDb();
  await db.query(
    `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from) values
       ('emberling', 'Emberling', '{9301}', '{Fire}', 'Basic', null),
       ('emberdrake', 'Emberdrake', '{9302}', '{Fire}', 'Stage1', 'Emberling'),
       ('dexcard', 'Dexcard', '{9401}', '{Water}', 'Basic', null)`,
  );
  await seedBinders(db, [{ id: GEN, type: "general", name: "KB-001" }]);
  // Her default box (untracked) and Box B, which holds one card and is full.
  await write([addBox(1, "Bulk box"), addBox(2, "Box B", 1)]);
  await bulkCopy(1, 2);
});

/* ------------------------------------------ 1. the closed set ------------------------------------------ */

describe("0037 · overrides are a closed set of five keys", () => {
  it.each([
    "bulk_unit_last",
    "bulk_unit_move_to",
    "bulk_unit_owner",
    "binder_block_one_per_copy",
    "slot_pointer",
    "presence_count",
    "file_total",
    "override_recorded",
    "LINE_FIT",
    " line_fit",
    "everything",
  ])("an unknown key (%j) is refused with P0001, and nothing is written", async (key) => {
    const r = await refusal(
      raw({ ops: [addBox(5, "Box E"), { ...decision(1), overrides: [key] }], overrides: [key] }),
    );
    expect(r.message).toBe(`apply_write_ops: unknown override "${key}"`);
    expect(r.code).toBe("P0001");
    expect(await q(`select id from bulk_unit where id = $1`, [BOX(5)])).toEqual([]);
    expect(await decisions()).toBe(0);
  });

  it.each<[string, unknown]>([
    ["a number", [1]],
    ["a null", [null]],
    ["a nested list", [["line_fit"]]],
    ["an object", [{ rule: "line_fit" }]],
    ["a bare string, not a list", "line_fit"],
    ["an object, not a list", { line_fit: true }],
  ])(
    "a non-string key (%s) is refused with P0001, and nothing is written",
    async (_, overrides) => {
      const r = await refusal(raw({ ops: [addBox(5, "Box E")], overrides }));
      expect(r.message).toMatch(/^apply_write_ops: unknown override /);
      expect(r.code).toBe("P0001");
      expect(await q(`select id from bulk_unit where id = $1`, [BOX(5)])).toEqual([]);
    },
  );

  it("a decision can record only the five (the column's check), even with nothing declared", async () => {
    const r = await refusal(raw({ ops: [{ ...decision(1), overrides: ["bulk_unit_last"] }] }));
    expect(r.message).toMatch(/placement_decision_overrides_known/);
    expect(await decisions()).toBe(0);
  });

  it("the five keys the database accepts are exactly OVERRIDE_RULES", async () => {
    const def = (
      await q<{ def: string }>(
        `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'placement_decision_overrides_known'`,
      )
    )[0].def;
    expect([...def.matchAll(/'(\w+)'::text/g)].map((m) => m[1]).sort()).toEqual([...ALL].sort());
  });

  it("line_fit, line_completion and collection_pick are accepted and recorded (no database rule to relax)", async () => {
    const keys: OverrideRule[] = ["line_fit", "line_completion", "collection_pick"];
    await write([decision(1, keys)], keys);
    expect(await decisionOverrides(1)).toEqual(keys);
  });

  it("every key is accepted when recorded", async () => {
    await write([decision(1, ALL)], ALL);
    expect(await decisionOverrides(1)).toEqual(ALL);
  });

  it("a decision with no overrides stores '{}' (a plain stamp), and so does a writer that never names the column", async () => {
    await write([decision(1)]);
    expect(await decisionOverrides(1)).toEqual([]);
    await q(
      `insert into placement_decision (id, owner_id, decision, reason, resolved_by) values ($1, $2, 'shelved', 'r', 'auto')`,
      [DEC(2), OWNER],
    );
    expect(await decisionOverrides(2)).toEqual([]);
  });

  it("no conversion: a decision made before 0037 reads '{}' after it, and nothing else about it changes", async () => {
    await db.close();
    db = await freshRpcDb({ before: "0037" });
    await q(
      `insert into placement_decision (id, owner_id, decision, reason, resolved_by) values ($1, $2, 'shelved', 'r', 'auto')`,
      [DEC(3), OWNER],
    );
    const before = await q(`select * from placement_decision where id = $1`, [DEC(3)]);
    await applyMigration(db, "0037_rule_overrides.sql");
    expect(await q(`select * from placement_decision where id = $1`, [DEC(3)])).toEqual([
      { ...before[0], overrides: [] },
    ]);
  });
});

/* ------------------------------------------ 2. line_min_stages ------------------------------------------ */

describe("0037 · line_min_stages: a one-card line, when she says so", () => {
  beforeEach(async () => {
    await shelved(10);
  });

  it("without the key: refused, as 0032 refuses it", async () => {
    const r = await refusal(write(oneCardLine(10)));
    expect(`${r.message} ${r.detail}`).toMatch(/a line needs at least two stages/);
    expect(await lines()).toBe(0);
  });

  it("with the key and a decision recording it: her one-card line is written, and the decision says why", async () => {
    await write(
      [...oneCardLine(10), decision(1, ["line_min_stages"], COPY(10))],
      ["line_min_stages"],
    );
    expect(await lines()).toBe(1);
    expect(await q(`select copy_id, state from line_slot where line_id = $1`, [LINE])).toEqual([
      { copy_id: COPY(10), state: "filled" },
    ]);
    expect(await decisionOverrides(1)).toEqual(["line_min_stages"]);
  });

  it("with the key but NO decision recording it: refused, nothing silent, and nothing is written", async () => {
    const r = await refusal(write(oneCardLine(10), ["line_min_stages"]));
    expect(r.message).toBe("An override has to be recorded with the move.");
    expect(r.code).toBe("P0001");
    expect(JSON.parse(r.detail ?? "null")).toEqual({
      check: "override_recorded",
      rule: "line_min_stages",
    });
    expect(await lines()).toBe(0);
    expect(await boxOf(10)).toEqual({ role: "shelved", unit: null });
  });

  it("a decision recording a different key does not count: each declared key is recorded", async () => {
    const r = await refusal(
      write(
        [...oneCardLine(10), decision(1, ["bulk_box_full"], COPY(10))],
        ["line_min_stages", "bulk_box_full"],
      ),
    );
    expect(r.message).toBe("An override has to be recorded with the move.");
    expect(JSON.parse(r.detail ?? "null")).toMatchObject({ rule: "line_min_stages" });
    expect(await lines()).toBe(0);
    expect(await decisions()).toBe(0);
  });
});

/* ------------------------------------------ 3. bulk_box_full ------------------------------------------ */

describe("0037 · bulk_box_full: a card into a full box, when she says so", () => {
  beforeEach(async () => {
    await shelved(2);
  });

  it("without the key: refused in her words, and the card stays where it was", async () => {
    const r = await refusal(write([toBox(2, 2)]));
    expect(r.message).toBe("Your Box B is full. Pick another box.");
    expect(await boxOf(2)).toEqual({ role: "shelved", unit: null });
  });

  it("with the key and a decision recording it (after the move): the card goes in, and Box B is over its limit", async () => {
    await write([toBox(2, 2), decision(1, ["bulk_box_full"], COPY(2))], ["bulk_box_full"]);
    expect(await boxOf(2)).toEqual({ role: "bulk", unit: BOX(2) });
    expect(await held(2)).toBe(2);
    expect(await decisionOverrides(1)).toEqual(["bulk_box_full"]);
  });

  it("with the key but no decision: refused, and the card stays where it was", async () => {
    const r = await refusal(write([toBox(2, 2)], ["bulk_box_full"]));
    expect(r.message).toBe("An override has to be recorded with the move.");
    expect(JSON.parse(r.detail ?? "null")).toEqual({
      check: "override_recorded",
      rule: "bulk_box_full",
    });
    expect(await boxOf(2)).toEqual({ role: "shelved", unit: null });
  });

  describe("a deleted box's cards, into a box without room", () => {
    beforeEach(async () => {
      await bulkCopy(3, 1);
      await bulkCopy(4, 1); // Bulk box holds 2; Box B holds 1 of 1
    });

    it("without the key: refused in her words before anything moves", async () => {
      const r = await refusal(write([{ op: "delete_bulk_unit", id: BOX(1), move_to: BOX(2) }]));
      expect(r.message).toBe(
        "Your Box B can't take these 2 cards: it has room for 0. Pick another box.",
      );
      for (const n of [3, 4]) expect(await boxOf(n)).toEqual({ role: "bulk", unit: BOX(1) });
    });

    it("with the key and a decision (no copy) recording it: the cards move, and Box B takes her default", async () => {
      await write(
        [{ op: "delete_bulk_unit", id: BOX(1), move_to: BOX(2) }, decision(1, ["bulk_box_full"])],
        ["bulk_box_full"],
      );
      for (const n of [3, 4]) expect(await boxOf(n)).toEqual({ role: "bulk", unit: BOX(2) });
      expect(await held(2)).toBe(3);
      expect(await q(`select id, is_default from bulk_unit where owner_id = $1`, [OWNER])).toEqual([
        { id: BOX(2), is_default: true },
      ]);
      expect(await decisionOverrides(1)).toEqual(["bulk_box_full"]);
    });
  });
});

/* ------------------------------------------ 4. each key, its own rule ------------------------------------------ */

describe("0037 · each key relaxes only its own rule", () => {
  beforeEach(async () => {
    await shelved(2);
    await shelved(10);
  });

  it("bulk_box_full does not let a one-card line through", async () => {
    const r = await refusal(
      write([...oneCardLine(10), decision(1, ["bulk_box_full"], COPY(10))], ["bulk_box_full"]),
    );
    expect(`${r.message} ${r.detail}`).toMatch(/a line needs at least two stages/);
    expect(await lines()).toBe(0);
  });

  it("line_min_stages does not let a full box take a card", async () => {
    const r = await refusal(
      write([toBox(2, 2), decision(1, ["line_min_stages"], COPY(2))], ["line_min_stages"]),
    );
    expect(r.message).toBe("Your Box B is full. Pick another box.");
    expect(await boxOf(2)).toEqual({ role: "shelved", unit: null });
  });

  it("line_min_stages does not let a deleted box's cards into a box without room", async () => {
    await bulkCopy(3, 1);
    const r = await refusal(
      write(
        [{ op: "delete_bulk_unit", id: BOX(1), move_to: BOX(2) }, decision(1, ["line_min_stages"])],
        ["line_min_stages"],
      ),
    );
    expect(r.message).toMatch(/^Your Box B can't take these 1 cards/);
    expect(await boxOf(3)).toEqual({ role: "bulk", unit: BOX(1) });
  });

  it("the three recorded-only keys relax neither", async () => {
    const keys: OverrideRule[] = ["line_fit", "line_completion", "collection_pick"];
    const line = await refusal(write([...oneCardLine(10), decision(1, keys, COPY(10))], keys));
    expect(line.detail).toMatch(/a line needs at least two stages/);
    expect((await refusal(write([toBox(2, 2), decision(1, keys, COPY(2))], keys))).message).toBe(
      "Your Box B is full. Pick another box.",
    );
  });
});

/* ------------------------------------------ 5. integrity, with all five ------------------------------------------ */

describe("0037 · integrity refuses with ALL FIVE keys declared and recorded", () => {
  const withAll = (ops: WriteOp[]) => write([...ops, decision(9, ALL)], ALL);

  it("one card fills one pocket: a second block on the same copy (0034's index)", async () => {
    await q(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half) values ($1, $2, 'emberling', 'block', $3, 'back')`,
      [COPY(20), OWNER, GEN],
    );
    await q(
      `insert into binder_block (id, owner_id, binder_id, half, pocket_count, purpose, material, copy_id)
         values ($1, $2, $3, 'back', 1, 'line-terminated', 'repurposedDuplicate', $4)`,
      [id(1, "b1000000"), OWNER, GEN, COPY(20)],
    );
    const r = await refusal(
      withAll([
        {
          op: "insert_binder_block",
          id: id(2, "b1000000"),
          binder_id: GEN,
          half: "back",
          pocket_count: 1,
          purpose: "line-terminated",
          material: "repurposedDuplicate",
          copy_id: COPY(20),
          line_id: null,
        },
      ]),
    );
    expect(r.message).toMatch(/binder_block_one_per_copy/);
    expect(await q(`select count(*)::int n from binder_block`)).toEqual([{ n: 1 }]);
    expect(await decisions()).toBe(0);
  });

  it("one card fills one pocket: a filler fills exactly one (0034's check)", async () => {
    const r = await refusal(
      withAll([
        {
          op: "insert_binder_block",
          id: id(2, "b1000000"),
          binder_id: GEN,
          half: "back",
          pocket_count: 2,
          purpose: "line-filler",
          material: "basicEnergy",
          copy_id: null,
          line_id: null,
        },
      ]),
    );
    expect(r.message).toMatch(/binder_block_filler_one_pocket/);
    expect(await decisions()).toBe(0);
  });

  it("a slot and its copy agree: a filled slot whose copy does not point back (assert_line_slots)", async () => {
    await shelved(10);
    const [line, slot] = oneCardLine(10); // the copy's own pointer is never written
    const r = await refusal(withAll([line, slot]));
    expect(r.message).toMatch(/line slot check failed/);
    const why = (JSON.parse(r.detail ?? "[]") as { why: string }[]).map((b) => b.why);
    expect(why).toEqual(["its copy does not point back"]);
    expect(await lines()).toBe(0);
  });

  it("a box is hers: another owner's box takes no card and is never deleted", async () => {
    await shelved(2);
    await q(
      `insert into bulk_unit (id, owner_id, name, is_default) values ($1, $2, 'Theirs', true)`,
      [BOX(9), OTHER],
    );
    expect((await refusal(withAll([toBox(2, 9)]))).message).toMatch(/isn't one of yours/);
    expect(
      (await refusal(withAll([{ op: "delete_bulk_unit", id: BOX(9), move_to: BOX(1) }]))).message,
    ).toMatch(/isn't one of yours/);
    expect(await boxOf(2)).toEqual({ role: "shelved", unit: null });
    expect(await q(`select name from bulk_unit where id = $1`, [BOX(9)])).toEqual([
      { name: "Theirs" },
    ]);
  });

  it("never her last box", async () => {
    await write([{ op: "delete_bulk_unit", id: BOX(2), move_to: BOX(1) }]);
    const r = await refusal(withAll([{ op: "delete_bulk_unit", id: BOX(1), move_to: BOX(1) }]));
    expect(r.message).toBe(
      "This is your only bulk box. Add another box before you delete this one.",
    );
    expect(await q(`select id from bulk_unit where owner_id = $1`, [OWNER])).toEqual([
      { id: BOX(1) },
    ]);
  });

  it.each<[string, Record<string, unknown>]>([
    ["missing", {}],
    ["not a box", { move_to: BOX(7) }],
    ["the box itself", { move_to: BOX(1) }],
  ])("never without a box for its cards (move_to %s)", async (_, moveTo) => {
    const r = await refusal(
      withAll([{ op: "delete_bulk_unit", id: BOX(1), ...moveTo } as unknown as WriteOp]),
    );
    expect(r.message).toBe("Pick the box this one's cards go to.");
    expect(await q(`select count(*)::int n from bulk_unit where owner_id = $1`, [OWNER])).toEqual([
      { n: 2 },
    ]);
  });

  it("her collection agrees with Dex: the count check", async () => {
    await shelved(30, "dexcard");
    await q(`insert into dex_import (owner_id, file_total, row_count) values ($1, 2, 1)`, [OWNER]);
    await q(
      `insert into dex_presence (owner_id, catalog_card_id, dex_variant_raw, quantity) values ($1, 'dexcard', 'Normal', 2)`,
      [OWNER],
    );
    const r = await refusal(withAll([{ op: "assert_presence_counts", all: true }]));
    expect(r.message).toMatch(/presence count check failed/);
    expect(await decisions()).toBe(0);
  });
});

/* ------------------------------------------ 6. the setting does not leak ------------------------------------------ */

describe("0037 · the override lasts only for the write that declared it", () => {
  beforeEach(async () => {
    await shelved(2);
    await shelved(3);
  });
  const directToBoxB = (n: number) =>
    db.query(
      `update copy set role = 'bulk', binder_id = null, binder_half = null, color_band = null, bulk_unit_id = $1
        where id = $2`,
      [BOX(2), COPY(n)],
    );

  it("inside one transaction, after a write that declared bulk_box_full, a direct write into a full box refuses", async () => {
    await asOwner(db);
    await db.exec(`begin;`);
    try {
      await applyOps(db, {
        ops: [toBox(2, 2), decision(1, ["bulk_box_full"], COPY(2))],
        overrides: ["bulk_box_full"],
      });
      expect(
        (await db.query<{ v: string }>(`select current_setting('app.overrides', true) as v`))
          .rows[0].v,
      ).toBe("[]");
      await expect(directToBoxB(3)).rejects.toThrow("Your Box B is full. Pick another box.");
    } finally {
      await db.exec(`rollback;`);
    }
    expect(await boxOf(3)).toEqual({ role: "shelved", unit: null });
  });

  it("a direct table write with no RPC into a full box refuses", async () => {
    await asOwner(db);
    await expect(directToBoxB(3)).rejects.toThrow("Your Box B is full. Pick another box.");
    expect(await boxOf(3)).toEqual({ role: "shelved", unit: null });
  });
});
