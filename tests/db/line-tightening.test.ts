/**
 * UIL-121 D — migration 0034: a line is only OPEN or CLOSED, a stage's card is hers only when she chases it, and one
 * card fills at most one pocket. Karvi, 2026-09-27: "Functionally, there are only 2 stages: open or closed", and
 * nothing is written for her.
 *
 *   1. Existing rows convert (the migration run against a pre-0034 database), and a labelled baseline re-stamped with
 *      the marked statements reads exactly as the migrated tables do; run twice, they change nothing.
 *   2. The words are held: no writer can store 'complete', 'terminated' or 'capped'.
 *   3. One card, one pocket: a second block naming a card is refused, and a filler fills exactly one pocket.
 *   4. A card already in two pockets stops the migration, naming them, and nothing of it applies.
 *
 * Real Postgres (PGlite, every migration), as the authenticated owner where a writer is exercised.
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

const GEN = "b0000000-0000-4000-8000-000000000341";
const id = (n: number, prefix: string) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
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
  return (await db.query<T>(sql, params)).rows;
}
/** Several statements at once (a schema copy, the marked conversion), as superuser. */
async function exec(sql: string): Promise<void> {
  await asSuperuser(db);
  await db.exec(sql);
}
async function line(n: number, status: string) {
  await q(
    `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
       values ($1, $2, 9301, 'red', $3, 'back', $4)`,
    [LINE(n), OWNER, GEN, status],
  );
}
async function slot(
  n: number,
  lineN: number,
  stageIndex: number,
  state: string,
  extra: { target?: string; choice?: string } = {},
) {
  await q(
    `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, target_catalog_card_id, stage_choice)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      SLOT(n),
      OWNER,
      LINE(lineN),
      stageIndex,
      ["Basic", "Stage1", "Stage2"][stageIndex],
      state,
      extra.target ?? null,
      extra.choice ?? null,
    ],
  );
}
async function filledBy(copyN: number, slotN: number, card = "emberling") {
  await q(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
       values ($1, $2, $3, 'shelved', $4, 'back', 'red')`,
    [COPY(copyN), OWNER, card, GEN],
  );
  await q(`update line_slot set state = 'filled', copy_id = $1 where id = $2`, [
    COPY(copyN),
    SLOT(slotN),
  ]);
  await q(`update copy set line_slot_id = $1 where id = $2`, [SLOT(slotN), COPY(copyN)]);
}
async function wish(slotN: number, chosen: string | null) {
  await q(
    `insert into wishlist_item (owner_id, line_slot_id, required_dex_id, chosen_catalog_card_id)
       values ($1, $2, 9302, $3)`,
    [OWNER, SLOT(slotN), chosen],
  );
}
const slotRow = async (n: number) =>
  (
    await q<{ state: string; stage_choice: string | null; target: string | null }>(
      `select state, stage_choice, target_catalog_card_id as target from line_slot where id = $1`,
      [SLOT(n)],
    )
  )[0];

/* ------------------------------------------ 1. conversion ------------------------------------------ */

describe("0034 · existing rows convert, in her terms", () => {
  beforeEach(async () => {
    db = await freshRpcDb({ before: "0034" });
    await seedCatalogCards(db, ["emberling", "emberdrake", "emberlord"]);
    await seedBinders(db, [{ id: GEN, type: "general", name: "KB-001" }]);
    // (a) the old words, still allowed before 0034.
    await line(1, "complete");
    await slot(10, 1, 0, "placeholder");
    await filledBy(10, 10);
    await line(2, "terminated");
    await slot(20, 2, 0, "placeholder");
    // (c) a capped line (it reads open): its undecided stage has one open wish that names a card, and no target.
    await line(3, "capped");
    await slot(30, 3, 0, "placeholder");
    await wish(30, "emberdrake");
    // (b) an open line: an engine target on an undecided stage; a chase with its card; a stage she left empty that
    // still carries a target; a filled stage with its own card as target.
    await line(4, "open");
    await slot(40, 4, 0, "placeholder", { target: "emberling" });
    await slot(41, 4, 1, "placeholder", { target: "emberdrake", choice: "chase" });
    await wish(41, "emberdrake");
    await slot(42, 4, 2, "placeholder", { target: "emberlord", choice: "empty" });
    // A CLOSED line with a leftover wish on an undecided stage: a closed line chases nothing; the wish stays hers.
    await line(5, "closed");
    await slot(50, 5, 0, "placeholder", { target: "emberdrake" });
    await wish(50, "emberdrake");
    // An undecided stage whose one open wish names no card, and no target: nothing to chase, so it stays undecided.
    await line(6, "open");
    await slot(60, 6, 0, "placeholder");
    await wish(60, null);
    // A filled stage keeps the card it holds as its target; the line, every slot filled, reads closed.
    await line(7, "open");
    await slot(70, 7, 0, "placeholder", { target: "emberling" });
    await filledBy(70, 70);
    // A labelled Testing baseline is a plain copy of these tables, taken before 0034 (CREATE TABLE AS: no keys).
    await exec(`create schema backup_t;
      create table backup_t.evolution_line as table public.evolution_line;
      create table backup_t.line_slot as table public.line_slot;
      create table backup_t.binder_block as table public.binder_block;
      create table backup_t.wishlist_item as table public.wishlist_item;`);
    await applyMigration(db, "0034_line_tightening.sql");
  });

  it("(a) complete and terminated read CLOSED; capped reads OPEN", async () => {
    expect(await q(`select id, status from evolution_line order by id`)).toEqual([
      { id: LINE(1), status: "closed" },
      { id: LINE(2), status: "closed" },
      { id: LINE(3), status: "open" },
      { id: LINE(4), status: "open" },
      { id: LINE(5), status: "closed" },
      { id: LINE(6), status: "open" },
      { id: LINE(7), status: "closed" }, // every slot filled
    ]);
  });

  it("(c) an undecided stage with one open wish on an open line is her chase, of the wished card", async () => {
    expect(await slotRow(30)).toEqual({
      state: "placeholder",
      stage_choice: "chase",
      target: "emberdrake",
    });
    // A wish that names no card leaves nothing to chase.
    expect(await slotRow(60)).toEqual({ state: "placeholder", stage_choice: null, target: null });
  });

  it("(b) a card named on a stage she has not chased is gone; a chase and a filled stage keep theirs", async () => {
    expect(await slotRow(40)).toEqual({ state: "placeholder", stage_choice: null, target: null });
    expect(await slotRow(41)).toEqual({
      state: "placeholder",
      stage_choice: "chase",
      target: "emberdrake",
    });
    expect(await slotRow(42)).toEqual({
      state: "placeholder",
      stage_choice: "empty",
      target: null,
    });
    expect(await slotRow(70)).toEqual({ state: "filled", stage_choice: null, target: "emberling" });
    // The closed line chases nothing: its stage is undecided with no card, and the wish is still hers.
    expect(await slotRow(50)).toEqual({ state: "placeholder", stage_choice: null, target: null });
    expect(
      await q(
        `select count(*)::int n from wishlist_item where line_slot_id = $1 and resolved_at is null`,
        [SLOT(50)],
      ),
    ).toEqual([{ n: 1 }]);
  });

  it("the converted rows pass the line rules: a write that touches every line is accepted", async () => {
    await asOwner(db);
    try {
      await applyOps(db, {
        ops: withLineSlotCheck(
          [1, 2, 3, 4, 5, 6, 7].map((n) => ({ op: "update_line", id: LINE(n), patch: {} })),
        ),
      });
    } catch (e) {
      throw new Error(`${(e as Error).message} ${(e as { detail?: string }).detail ?? ""}`);
    }
  });

  /** The migration's marked conversion statements, as the baseline re-stamp reads them. */
  const conversion = () => {
    const sql = readFileSync(
      path.join(process.cwd(), "supabase", "migrations", "0034_line_tightening.sql"),
      "utf8",
    );
    const from = sql.indexOf("\n-- >>> 0034 CONVERSION");
    const to = sql.indexOf("\n-- <<< 0034 CONVERSION");
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    return sql.slice(from, to);
  };
  const rows = async (schema: string) => {
    const out: Record<string, unknown[]> = {};
    for (const t of ["evolution_line", "line_slot", "binder_block", "wishlist_item"])
      out[t] = (
        await q<{ r: unknown }>(`select to_jsonb(t) as r from ${schema}.${t} t order by t.id`)
      ).map((x) => x.r);
    return out;
  };

  it("a baseline copy re-stamped with the marked statements reads exactly as the migrated tables do", async () => {
    // Only the baseline's schema on the path: a statement naming anything else fails here rather than on her data.
    await exec(`set search_path = backup_t; ${conversion()}; set search_path = public;`);
    expect(await rows("backup_t")).toEqual(await rows("public"));
  });

  it("the marked statements change nothing when run a second time", async () => {
    const before = await rows("public");
    await exec(conversion());
    expect(await rows("public")).toEqual(before);
  });
});

/* ------------------------------------------ 2 + 3. the rules ------------------------------------------ */

describe("0034 · the words and the pockets are held for every writer", () => {
  beforeEach(async () => {
    db = await freshRpcDb();
    await seedCatalogCards(db, ["emberling", "emberdrake"]);
    await seedBinders(db, [{ id: GEN, type: "general", name: "KB-001" }]);
    await line(1, "open");
    await slot(10, 1, 0, "placeholder");
    await slot(11, 1, 1, "placeholder");
    await filledBy(10, 10);
    await q(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half)
         values ($1, $2, 'emberling', 'block', $3, 'back')`,
      [COPY(90), OWNER, GEN],
    );
  });

  it.each(["complete", "terminated", "capped"])("'%s' can no longer be written", async (word) => {
    await asOwner(db);
    await expect(
      applyOps(db, { ops: [{ op: "update_line", id: LINE(1), patch: { status: word } }] }),
    ).rejects.toThrow(/evolution_line_status_check/);
    expect(await q(`select status from evolution_line`)).toEqual([{ status: "open" }]);
  });

  const blockRow = (n: number, extra: { pockets?: number } = {}): WriteOp => ({
    op: "insert_binder_block",
    id: BLOCK(n),
    binder_id: GEN,
    half: "back",
    pocket_count: extra.pockets ?? 1,
    purpose: "collection-reserve",
    material: "repurposedDuplicate",
    copy_id: COPY(90),
    line_id: null,
  });

  it("a second block naming the same card is refused: one card fills one pocket", async () => {
    await asOwner(db);
    await applyOps(db, { ops: [blockRow(1)] });
    await expect(applyOps(db, { ops: [blockRow(2)] })).rejects.toThrow(
      /binder_block_one_per_copy|duplicate key/,
    );
    expect(await q(`select id from binder_block`)).toEqual([{ id: BLOCK(1) }]);
  });

  it("a filler fills exactly one pocket; a reserve may still hold several", async () => {
    await q(
      `insert into binder_block (id, owner_id, binder_id, half, pocket_count, purpose, material, line_id)
         values ($1, $2, $3, 'back', 3, 'collection-reserve', 'basicEnergy', null)`,
      [BLOCK(3), OWNER, GEN],
    );
    await expect(
      q(
        `insert into binder_block (id, owner_id, binder_id, half, pocket_count, purpose, material, line_id, line_slot_id)
           values ($1, $2, $3, 'back', 2, 'line-filler', 'basicEnergy', $4, $5)`,
        [BLOCK(4), OWNER, GEN, LINE(1), SLOT(11)],
      ),
    ).rejects.toThrow(/binder_block_filler_one_pocket/);
  });
});

/* ------------------------------------------ 4. the guard ------------------------------------------ */

describe("0034 · a card already in two pockets stops the migration, and names them", () => {
  it("refuses with the copy and both blocks, and nothing of 0034 applies", async () => {
    db = await freshRpcDb({ before: "0034" });
    await seedCatalogCards(db, ["emberling"]);
    await seedBinders(db, [{ id: GEN, type: "general", name: "KB-001" }]);
    await line(1, "complete");
    await q(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half)
         values ($1, $2, 'emberling', 'block', $3, 'back')`,
      [COPY(90), OWNER, GEN],
    );
    for (const n of [1, 2]) {
      await q(
        `insert into binder_block (id, owner_id, binder_id, half, pocket_count, purpose, material, copy_id)
           values ($1, $2, $3, 'back', 1, 'collection-reserve', 'repurposedDuplicate', $4)`,
        [BLOCK(n), OWNER, GEN, COPY(90)],
      );
    }
    await expect(applyMigration(db, "0034_line_tightening.sql")).rejects.toThrow(
      new RegExp(`copy ${COPY(90)} in blocks ${BLOCK(1)}, ${BLOCK(2)}`),
    );
    // One transaction: the conversion before the guard is rolled back with it.
    expect(await q(`select status from evolution_line`)).toEqual([{ status: "complete" }]);
    expect(
      await q(
        `select count(*)::int n from supabase_migrations.schema_migrations where version = '0034'`,
      ),
    ).toEqual([{ n: 0 }]);
  });
});
