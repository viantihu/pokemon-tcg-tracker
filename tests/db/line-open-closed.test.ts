/**
 * UIL-121 A1 — migration 0030: a line is OPEN or CLOSED, and every unfilled stage is HER choice (chase a card, leave it
 * empty, or a filler in its pocket), with a short complete line's third pocket hers too. Karvi, 2026-09-27: "Functionally,
 * there are only 2 stages: open or closed", and nothing is written for her.
 *
 *   1. Existing rows convert, in her terms (the migration run against a pre-0030 database).
 *   2. The database holds each choice to what it means (assert_line_slots, run by every line write).
 *   3. The new ops: update_slot.stage_choice, update_line.extra_pocket, insert_binder_block.line_slot_id,
 *      delete_binder_block (owner- and id-scoped, signed-in owner only).
 *   4. 0030's function is 0029's body plus the parts it marks.
 *
 * Real Postgres (PGlite, every migration), the real `apply_write_ops`, as the authenticated owner.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { WriteOp } from "@/lib/repo";
import { withLineSlotCheck } from "@/lib/repo/write-ops";
import {
  applyMigration,
  applyOps,
  asOwner,
  asSuperuser,
  freshRpcDb,
  OWNER,
  seedBinders,
  seedCatalogCards,
} from "../support/pglite-rpc";

const GEN = "b0000000-0000-4000-8000-000000000121";
const GEN2 = "b0000000-0000-4000-8000-000000000122";
const id = (n: number, prefix = "10000000") =>
  `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LINE = (n: number) => id(n, "10000000");
const SLOT = (n: number) => id(n, "20000000");
const COPY = (n: number) => id(n, "c0000000");
const BLOCK = (n: number) => id(n, "b1000000");

let db: PGlite;
afterEach(async () => {
  if (db && !db.closed) await db.close();
});

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  await asSuperuser(db);
  const r = (await db.query<T>(sql, params)).rows;
  return r;
}
async function seedBase() {
  await seedCatalogCards(db, ["emberling", "emberdrake", "emberlord"]);
  await seedBinders(db, [
    { id: GEN, type: "general", name: "KB-001" },
    { id: GEN2, type: "general", name: "KB-002" },
  ]);
}
async function line(n: number, status: string, binder = GEN) {
  await db.query(
    `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
       values ($1, $2, 9301, 'red', $3, 'back', $4)`,
    [LINE(n), OWNER, binder, status],
  );
}
async function slot(
  n: number,
  lineN: number,
  stageIndex: number,
  state: string,
  extra: { copy?: string; target?: string; note?: string } = {},
) {
  await db.query(
    `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id, target_catalog_card_id, note)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      SLOT(n),
      OWNER,
      LINE(lineN),
      stageIndex,
      ["Basic", "Stage1", "Stage2"][stageIndex],
      state,
      extra.copy ?? null,
      extra.target ?? null,
      extra.note ?? null,
    ],
  );
}
async function shelvedIn(n: number, slotN: number, binder = GEN) {
  await db.query(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
       values ($1, $2, 'emberling', 'shelved', $3, 'back', 'red')`,
    [COPY(n), OWNER, binder],
  );
  await db.query(`update line_slot set state = 'filled', copy_id = $1 where id = $2`, [
    COPY(n),
    SLOT(slotN),
  ]);
  await db.query(`update copy set line_slot_id = $1 where id = $2`, [SLOT(slotN), COPY(n)]);
}
async function wish(slotN: number, resolved = false) {
  await db.query(
    `insert into wishlist_item (owner_id, line_slot_id, required_dex_id, chosen_catalog_card_id, resolved_at)
       values ($1, $2, 9302, 'emberdrake', $3)`,
    [OWNER, SLOT(slotN), resolved ? new Date().toISOString() : null],
  );
}
async function block(
  n: number,
  lineN: number,
  extra: { slot?: number; copy?: string; purpose?: string } = {},
) {
  const cols = [
    "id",
    "owner_id",
    "binder_id",
    "half",
    "pocket_count",
    "purpose",
    "material",
    "copy_id",
    "line_id",
  ];
  const vals: unknown[] = [
    BLOCK(n),
    OWNER,
    GEN,
    "back",
    1,
    extra.purpose ?? "line-terminated",
    extra.copy ? "repurposedDuplicate" : "basicEnergy",
    extra.copy ?? null,
    LINE(lineN),
  ];
  if (extra.slot !== undefined) {
    cols.push("line_slot_id"); // a 0030 column: only named when the test gives one
    vals.push(SLOT(extra.slot));
  }
  await db.query(
    `insert into binder_block (${cols.join(", ")}) values (${cols.map((_, k) => `$${k + 1}`).join(", ")})`,
    vals,
  );
}

/* ------------------------------------------ 1. conversion ------------------------------------------ */

describe("0030 · existing rows convert, in her terms", () => {
  beforeEach(async () => {
    db = await freshRpcDb({ before: "0030" });
    await seedBase();
    // A complete line, a terminated one, a capped one (its specialty stage chased), and an open one with one of each
    // kind of unfilled stage; a line whose two block slots each have a block row; and one whose rows do not pair.
    await line(1, "complete");
    await slot(1, 1, 0, "placeholder");
    await shelvedIn(1, 1);
    await line(2, "terminated");
    await slot(2, 2, 0, "placeholder", { note: "root blocked" });
    await line(3, "capped");
    await slot(3, 3, 0, "placeholder", { target: "emberdrake" });
    await wish(3);
    await line(4, "open");
    await slot(41, 4, 0, "placeholder", { target: "emberdrake" }); // chased
    await wish(41);
    await slot(42, 4, 1, "placeholder", { note: "left empty (not on the wishlist)" });
    await slot(43, 4, 2, "block", { note: "blocked" }); // the engine's; no block row on the line
    await line(5, "open");
    await slot(51, 5, 0, "block");
    await slot(52, 5, 1, "block");
    await block(1, 5);
    await block(2, 5);
    await line(6, "open");
    await slot(61, 6, 0, "block");
    await slot(62, 6, 1, "block");
    await block(3, 6); // one row for two block slots: they cannot be paired
    await applyMigration(db, "0030_line_open_closed.sql");
  });

  it("complete and terminated read CLOSED; capped reads OPEN (nobody accepted a cap for her)", async () => {
    expect(await q(`select id, status from evolution_line order by id`)).toEqual([
      { id: LINE(1), status: "closed" },
      { id: LINE(2), status: "closed" },
      { id: LINE(3), status: "open" },
      { id: LINE(4), status: "open" },
      { id: LINE(5), status: "open" },
      { id: LINE(6), status: "open" },
    ]);
  });

  it("each unfilled stage becomes what it was: a chase, an empty, a filler, or undecided", async () => {
    const rows = await q<{
      id: string;
      state: string;
      stage_choice: string | null;
      target: string | null;
    }>(
      `select id, state, stage_choice, target_catalog_card_id as target from line_slot order by id`,
    );
    const by = new Map(rows.map((r) => [r.id, r]));
    expect(by.get(SLOT(1))).toMatchObject({ state: "filled", stage_choice: null });
    expect(by.get(SLOT(3))).toMatchObject({ stage_choice: "chase" }); // capped's chased stage
    expect(by.get(SLOT(41))).toMatchObject({ stage_choice: "chase" });
    expect(by.get(SLOT(42))).toMatchObject({ stage_choice: "empty" });
    // The engine's block with no row on its line was never hers: an open slot she decides.
    expect(by.get(SLOT(43))).toMatchObject({
      state: "placeholder",
      stage_choice: null,
      target: null,
    });
    // One row per block slot pairs, in order, into fillers she recorded.
    expect(by.get(SLOT(51))).toMatchObject({ state: "block", stage_choice: "filler" });
    expect(by.get(SLOT(52))).toMatchObject({ state: "block", stage_choice: "filler" });
    expect(
      await q(`select id, line_slot_id, purpose from binder_block where line_id = $1 order by id`, [
        LINE(5),
      ]),
    ).toEqual([
      { id: BLOCK(1), line_slot_id: SLOT(51), purpose: "line-filler" },
      { id: BLOCK(2), line_slot_id: SLOT(52), purpose: "line-filler" },
    ]);
    // Rows that cannot be paired are left as they were, for the tightening step.
    expect(by.get(SLOT(61))).toMatchObject({ state: "block", stage_choice: null });
    expect(await q(`select line_slot_id from binder_block where id = $1`, [BLOCK(3)])).toEqual([
      { line_slot_id: null },
    ]);
  });

  it("the converted rows pass the new rules: a write that touches every line is accepted", async () => {
    await asOwner(db);
    await applyOps(db, {
      ops: withLineSlotCheck(
        [1, 2, 3, 4, 5, 6].map((n) => ({ op: "update_line", id: LINE(n), patch: {} })),
      ),
    });
  });
});

/* ------------------------------------------ 2. the rules ------------------------------------------ */

describe("0030 · the database holds each choice to what it means", () => {
  beforeEach(async () => {
    db = await freshRpcDb();
    await seedBase();
    await line(1, "open");
    await slot(10, 1, 0, "placeholder");
    await slot(11, 1, 1, "placeholder", { target: "emberdrake" });
    await asOwner(db);
  });
  /** The write, with a refusal re-thrown as the check's own reasons (they ride in the error's detail). */
  const write = async (ops: WriteOp[]) => {
    try {
      await applyOps(db, { ops: withLineSlotCheck(ops) });
    } catch (e) {
      const detail = (e as { detail?: string }).detail ?? "";
      throw new Error(`${(e as Error).message} ${detail}`);
    }
  };
  const setChoice = (n: number, stage_choice: "chase" | "empty" | "filler" | null): WriteOp => ({
    op: "update_slot",
    id: SLOT(n),
    patch: { stage_choice },
  });
  const upsertWish = (n: number): WriteOp => ({
    op: "upsert_wishlist_for_slot",
    line_slot_id: SLOT(n),
    required_dex_id: 9302,
    required_type: null,
    required_stage: "Stage1",
    chosen_catalog_card_id: "emberdrake",
    alternate_catalog_card_ids: [],
    will_live_in_specialty: false,
    held_for_binder_id: GEN,
  });

  it("CHASE: a card and exactly one open wish; either missing is refused", async () => {
    await expect(write([setChoice(11, "chase")])).rejects.toThrow(
      /not on her wishlist exactly once/,
    );
    await expect(write([setChoice(10, "chase"), upsertWish(10)])).rejects.toThrow(/names no card/);
    await write([setChoice(11, "chase"), upsertWish(11)]); // accepted
    // A chase is an OPEN slot waiting for its card, not a pocket already holding a filler.
    await expect(
      write([
        { op: "update_slot", id: SLOT(11), patch: { state: "block" } },
        blockOp(6, { slot: 11, line: 1 }),
      ]),
    ).rejects.toThrow(/chased stage is not an open slot/);
  });

  it("EMPTY: an open slot with no wish on her list", async () => {
    await expect(write([setChoice(11, "empty"), upsertWish(11)])).rejects.toThrow(
      /left empty is on her wishlist/,
    );
    await write([setChoice(11, "empty")]);
  });

  it("FILLER: a block with exactly one block row on that slot, on this line", async () => {
    await expect(
      write([
        { op: "update_slot", id: SLOT(10), patch: { state: "block", stage_choice: "filler" } },
      ]),
    ).rejects.toThrow(/needs exactly one block row/);
    await write([
      { op: "update_slot", id: SLOT(10), patch: { state: "block", stage_choice: "filler" } },
      blockOp(1, { slot: 10, line: 1 }),
    ]);
    // A block cannot fill a slot while naming a different line (and the database will not store a slot with no line).
    await asSuperuser(db);
    await line(2, "open");
    await slot(20, 2, 0, "placeholder");
    await expect(
      db.query(
        `insert into binder_block (owner_id, binder_id, half, purpose, material, line_slot_id)
                  values ($1, $2, 'back', 'line-filler', 'basicEnergy', $3)`,
        [OWNER, GEN, SLOT(20)],
      ),
    ).rejects.toThrow(/binder_block_slot_names_line/);
    await asOwner(db);
    await expect(write([blockOp(2, { slot: 20, line: 1 })])).rejects.toThrow(
      /names a slot on another line/,
    );
  });

  it("a filled stage carries no choice; a line with every slot filled reads closed", async () => {
    await asSuperuser(db);
    await shelvedIn(1, 10);
    await shelvedIn(2, 11);
    await asOwner(db);
    await expect(write([setChoice(10, "empty")])).rejects.toThrow(
      /filled stage still carries a choice/,
    );
    await expect(write([{ op: "update_line", id: LINE(1), patch: {} }])).rejects.toThrow(
      /every slot is filled but the line reads open/,
    );
    await write([{ op: "update_line", id: LINE(1), patch: { status: "closed" } }]);
  });

  it("a CLOSED line chases nothing", async () => {
    await expect(
      write([
        setChoice(11, "chase"),
        upsertWish(11),
        { op: "update_line", id: LINE(1), patch: { status: "closed" } },
      ]),
    ).rejects.toThrow(/reads closed but a stage is being chased/);
    await write([
      setChoice(11, "empty"),
      { op: "update_line", id: LINE(1), patch: { status: "closed" } },
    ]);
  });

  it("the THIRD POCKET: only on a complete line shorter than 3, and it holds exactly what she chose", async () => {
    await asSuperuser(db);
    await shelvedIn(1, 10);
    await shelvedIn(2, 11);
    await db.query(`update evolution_line set status = 'closed' where id = $1`, [LINE(1)]);
    await asOwner(db);
    await expect(
      write([{ op: "update_line", id: LINE(1), patch: { extra_pocket: "energy" } }]),
    ).rejects.toThrow(/does not hold what she chose/);
    await write([
      { op: "update_line", id: LINE(1), patch: { extra_pocket: "energy" } },
      blockOp(3, { line: 1 }),
    ]);
    await expect(write([blockOp(4, { line: 1 })])).rejects.toThrow(
      /more than one thing fills the third pocket/,
    );
    // A three-slot line has no third pocket to choose for.
    await asSuperuser(db);
    await line(3, "closed");
    for (const [n, i] of [
      [30, 0],
      [31, 1],
      [32, 2],
    ]) {
      await slot(n, 3, i, "placeholder");
      await shelvedIn(n, n);
    }
    await asOwner(db);
    await expect(
      write([{ op: "update_line", id: LINE(3), patch: { extra_pocket: "empty" } }]),
    ).rejects.toThrow(/no third pocket/);
  });

  it("a tracked filler card is a block in the line's binder, back half, on no slot", async () => {
    await asSuperuser(db);
    await shelvedIn(1, 10);
    await shelvedIn(2, 11);
    await db.query(`update evolution_line set status = 'closed' where id = $1`, [LINE(1)]);
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, role) values ($1, $2, 'emberling', 'bulk')`,
      [COPY(9), OWNER],
    );
    await asOwner(db);
    const card = blockOp(5, { line: 1, copy: COPY(9) });
    // Still in the bulk box: refused.
    await expect(
      write([{ op: "update_line", id: LINE(1), patch: { extra_pocket: "card" } }, card]),
    ).rejects.toThrow(/filler card is not a block/);
    await write([
      { op: "update_line", id: LINE(1), patch: { extra_pocket: "card" } },
      {
        op: "update_copy",
        id: COPY(9),
        patch: {
          role: "block",
          binder_id: GEN,
          binder_half: "back",
          color_band: null,
          line_slot_id: null,
        },
      },
      card,
    ]);
  });
});

function blockOp(n: number, o: { line: number; slot?: number; copy?: string }): WriteOp {
  return {
    op: "insert_binder_block",
    id: BLOCK(n),
    binder_id: GEN,
    half: "back",
    pocket_count: 1,
    purpose: "line-filler",
    material: o.copy ? "repurposedDuplicate" : "basicEnergy",
    copy_id: o.copy ?? null,
    line_id: LINE(o.line),
    line_slot_id: o.slot !== undefined ? SLOT(o.slot) : null,
  };
}

/* ------------------------------------------ 3. the new ops ------------------------------------------ */

describe("0030 · delete_binder_block: owner- and id-scoped, the signed-in owner only", () => {
  beforeEach(async () => {
    db = await freshRpcDb();
    await seedBase();
    await line(1, "open");
    await slot(10, 1, 0, "block");
    await block(1, 1, { slot: 10, purpose: "line-filler" });
    await db.query(`update line_slot set stage_choice = 'filler' where id = $1`, [SLOT(10)]);
    await asOwner(db);
  });

  it("deletes her block, with the slot going back to an undecided open slot in the same write", async () => {
    await applyOps(db, {
      ops: withLineSlotCheck([
        { op: "delete_binder_block", id: BLOCK(1), line_id: LINE(1) },
        { op: "update_slot", id: SLOT(10), patch: { state: "placeholder", stage_choice: null } },
      ]),
    });
    expect(await q(`select count(*)::int n from binder_block`)).toEqual([{ n: 0 }]);
  });

  it("a block that is not there (or not hers) raises, and so does anyone but the signed-in owner", async () => {
    await expect(
      applyOps(db, { ops: [{ op: "delete_binder_block", id: BLOCK(99), line_id: LINE(1) }] }),
    ).rejects.toThrow(/found no such block/);
    await asSuperuser(db);
    await expect(
      applyOps(db, { ops: [{ op: "delete_binder_block", id: BLOCK(1), line_id: LINE(1) }] }),
    ).rejects.toThrow(/runs only as the signed-in owner/);
    expect(await q(`select count(*)::int n from binder_block`)).toEqual([{ n: 1 }]);
  });
});

/* ------------------------------------------ 4. composition ------------------------------------------ */

describe("0030 · composes on 0029", () => {
  const fn = (file: string) => {
    const sql = readFileSync(path.join(process.cwd(), "supabase", "migrations", file), "utf8");
    const at = sql.indexOf("\ncreate or replace function apply_write_ops(payload jsonb)");
    expect(at).toBeGreaterThan(0);
    return sql.slice(at);
  };
  /** A line as SQL reads it: whitespace collapsed, a trailing comma dropped. */
  const norm = (l: string) => l.trim().replace(/\s+/g, " ").replace(/,$/, "");

  it("keeps every line of 0029's function, in order (the ones it changes read the same once normalised)", () => {
    const base = fn("0029_delete_line.sql").split("\n").map(norm).filter(Boolean);
    const mine = fn("0030_line_open_closed.sql").split("\n").map(norm);
    // The one line 0030 rewrites rather than extends: the block insert's column list gains line_slot_id.
    const rewritten = new Map([
      [
        "id, binder_id, half, pocket_count, purpose, material, copy_id, line_id, created_at",
        "id, binder_id, half, pocket_count, purpose, material, copy_id, line_id, line_slot_id, created_at",
      ],
    ]);
    let at = 0;
    for (const l of base) {
      const want = rewritten.get(l) ?? l;
      const found = mine.indexOf(want, at);
      expect(found, `0029 line missing from 0030: ${l}`).toBeGreaterThanOrEqual(0);
      at = found + 1;
    }
  });

  it("marks what it adds", () => {
    const mine = fn("0030_line_open_closed.sql");
    expect((mine.match(/(NEW|CHANGED) in 0030/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(mine).toContain("when 'delete_binder_block' then");
  });
});
