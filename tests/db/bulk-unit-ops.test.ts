/**
 * UIL-130 PR 2a — migration 0036: her bulk boxes, written, and a card going to bulk can name its box.
 *
 * Karvi, 2026-09-29: several boxes, added like binders; a box with a finite capacity that is full refuses ("Stop it,
 * ask for another"); an untracked box is never full; moving OUT is never refused. The Senior BA's conditions: exactly
 * one default box (QA on #448); delete-with-move-to into a box that cannot take the cards is refused in her words
 * before anything moves; a plan parked before 2a (no box named) still commits, to her default box.
 *
 *   1. The box ops: add (her first box is her default), rename / limit / order, the default swapped in one op, delete
 *      with somewhere for the cards to go (never her last box; never into a box that cannot take them).
 *   2. Exactly one default, at commit, whatever writes the boxes.
 *   3. The copy trigger's fallback (QA's rule b): with no default found, her first box, never none.
 *   4. A card going to bulk names its box: through `update_copy`, the real Move, and the Haul Plan's own route.
 *
 * Real Postgres (PGlite, every migration), the real `apply_write_ops` and writers, as the authenticated owner.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyMove, type MoveNameLookups } from "@/lib/line";
import { applyCollectionRemoval } from "@/lib/coll/remove";
import { clearCatalogCache, commitCardPlacement } from "@/lib/plan";
import type { WriteOp } from "@/lib/repo";
import { CHARMANDER_SV03_026 } from "../engine/fixtures";
import {
  applyOps,
  asOwner,
  asSuperuser,
  freshRpcDb,
  haulRow,
  OWNER,
  seedBinders,
  seedCatalogCardsFull,
  seedCollections,
  seedHaulRows,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const GEN = "b0000000-0000-4000-8000-000000000136";
const OTHER = "00000000-0000-4000-8000-0000000000b2";
const id = (n: number, prefix: string) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const COPY = (n: number) => id(n, "c0000000");
const BOX = (n: number) => id(n, "d0000000");
const names: MoveNameLookups = {
  binderName: () => "KB-001",
  collectionName: () => null,
  bandDisplay: (k) => k,
};

let db: PGlite;
afterEach(async () => {
  if (db && !db.closed) await db.close();
});
beforeEach(async () => {
  db = await freshRpcDb();
  await seedCatalogCardsFull(db, [CHARMANDER_SV03_026]);
  await seedBinders(db, [{ id: GEN, type: "general", name: "KB-001" }]);
  clearCatalogCache();
});

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  await asSuperuser(db);
  return (await db.query<T>(sql, params)).rows;
}
/** The write, as her, with a refusal's words in the message. */
async function write(ops: WriteOp[]) {
  await asOwner(db);
  await applyOps(db, { ops });
}
const boxes = () =>
  q<{ id: string; name: string; is_default: boolean; capacity: number | null; sort_order: number }>(
    `select id, name, is_default, capacity, sort_order from bulk_unit where owner_id = $1 order by sort_order, id`,
    [OWNER],
  );
const add = (n: number, name: string, capacity: number | null = null): WriteOp => ({
  op: "insert_bulk_unit",
  id: BOX(n),
  name,
  capacity,
});
async function bulkCopy(n: number, box: number) {
  await q(
    `insert into copy (id, owner_id, catalog_card_id, role, bulk_unit_id) values ($1, $2, 'sv03-026', 'bulk', $3)`,
    [COPY(n), OWNER, BOX(box)],
  );
}
async function shelved(n: number) {
  await q(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
       values ($1, $2, 'sv03-026', 'shelved', $3, 'front', 'red')`,
    [COPY(n), OWNER, GEN],
  );
}
const boxOf = async (n: number) =>
  (
    await q<{ role: string; unit: string | null }>(
      `select role, bulk_unit_id as unit from copy where id = $1`,
      [COPY(n)],
    )
  )[0];

/* ------------------------------------------ 1. the box ops ------------------------------------------ */

describe("0036 · her boxes, added like binders", () => {
  it("her first box is her default; the next is not, and goes after it", async () => {
    await write([add(1, "Bulk box"), add(2, " Box B ")]);
    expect(await boxes()).toEqual([
      { id: BOX(1), name: "Bulk box", is_default: true, capacity: null, sort_order: 0 },
      { id: BOX(2), name: "Box B", is_default: false, capacity: null, sort_order: 1 },
    ]);
  });

  it("rename, a card limit set and lifted, and her order", async () => {
    await write([add(1, "Bulk box")]);
    await write([
      { op: "update_bulk_unit", id: BOX(1), patch: { name: "Shoebox", capacity: 200 } },
    ]);
    expect((await boxes())[0]).toMatchObject({ name: "Shoebox", capacity: 200 });
    await write([{ op: "update_bulk_unit", id: BOX(1), patch: { capacity: null, sort_order: 5 } }]);
    expect((await boxes())[0]).toMatchObject({ name: "Shoebox", capacity: null, sort_order: 5 });
  });

  it("her default changes in ONE op, and she has exactly one after", async () => {
    await write([add(1, "Bulk box"), add(2, "Box B")]);
    await write([{ op: "set_default_bulk_unit", id: BOX(2) }]);
    expect((await boxes()).map((b) => [b.id, b.is_default])).toEqual([
      [BOX(1), false],
      [BOX(2), true],
    ]);
  });

  it("another owner's box can be neither changed, made her default, nor deleted", async () => {
    await write([add(1, "Bulk box")]);
    await q(
      `insert into bulk_unit (id, owner_id, name, is_default) values ($1, $2, 'Theirs', true)`,
      [BOX(9), OTHER],
    );
    for (const op of [
      { op: "update_bulk_unit", id: BOX(9), patch: { name: "Mine" } },
      { op: "set_default_bulk_unit", id: BOX(9) },
      { op: "delete_bulk_unit", id: BOX(9), move_to: BOX(1) },
    ] as WriteOp[]) {
      await expect(write([op])).rejects.toThrow(/isn't one of yours/);
    }
    expect(await q(`select name, is_default from bulk_unit where id = $1`, [BOX(9)])).toEqual([
      { name: "Theirs", is_default: true },
    ]);
  });
});

describe("0036 · a box goes only with somewhere for its cards to go", () => {
  beforeEach(async () => {
    await write([add(1, "Bulk box"), add(2, "Box B", 3)]);
    await bulkCopy(1, 1);
    await bulkCopy(2, 1);
  });

  it("its cards move, and her default passes to where they went", async () => {
    await write([{ op: "delete_bulk_unit", id: BOX(1), move_to: BOX(2) }]);
    expect(await boxes()).toEqual([expect.objectContaining({ id: BOX(2), is_default: true })]);
    expect(await boxOf(1)).toEqual({ role: "bulk", unit: BOX(2) });
    expect(await boxOf(2)).toEqual({ role: "bulk", unit: BOX(2) });
  });

  it("a spare card that calls it home moves its home too", async () => {
    await q(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, bulk_unit_id)
         values ($1, $2, 'sv03-026', 'block', $3, 'back', $4)`,
      [COPY(5), OWNER, GEN, BOX(1)],
    );
    await write([{ op: "delete_bulk_unit", id: BOX(1), move_to: BOX(2) }]);
    expect(await boxOf(5)).toEqual({ role: "block", unit: BOX(2) });
  });

  it("never her last box", async () => {
    await write([{ op: "delete_bulk_unit", id: BOX(2), move_to: BOX(1) }]);
    await expect(write([{ op: "delete_bulk_unit", id: BOX(1), move_to: BOX(1) }])).rejects.toThrow(
      "This is your only bulk box. Add another box before you delete this one.",
    );
    expect(await boxes()).toHaveLength(1);
  });

  it("never without a box for its cards", async () => {
    await expect(write([{ op: "delete_bulk_unit", id: BOX(1), move_to: BOX(7) }])).rejects.toThrow(
      "Pick the box this one's cards go to.",
    );
    await expect(write([{ op: "delete_bulk_unit", id: BOX(1), move_to: BOX(1) }])).rejects.toThrow(
      "Pick the box this one's cards go to.",
    );
    expect(await boxes()).toHaveLength(2);
  });

  it("never into a box with a limit that cannot take them all: refused in her words before anything moves", async () => {
    await bulkCopy(3, 2);
    await bulkCopy(4, 2); // Box B: 2 of 3, room for 1; Bulk box holds 2
    await expect(write([{ op: "delete_bulk_unit", id: BOX(1), move_to: BOX(2) }])).rejects.toThrow(
      "Your Box B can't take these 2 cards: it has room for 1. Pick another box.",
    );
    expect(await boxes()).toHaveLength(2);
    for (const n of [1, 2]) expect(await boxOf(n)).toEqual({ role: "bulk", unit: BOX(1) });
  });
});

/* ------------------------------------------ 2. exactly one default ------------------------------------------ */

describe("0036 · she always has exactly one default box (QA on #448)", () => {
  beforeEach(async () => {
    await write([add(1, "Bulk box"), add(2, "Box B")]);
  });

  it("a write that leaves her with no default is refused at commit, whatever wrote it", async () => {
    await asOwner(db);
    await expect(
      db.query(`update bulk_unit set is_default = false where owner_id = $1 and id = $2`, [
        OWNER,
        BOX(1),
      ]),
    ).rejects.toThrow("You need one default bulk box. Pick which box is your default.");
    await expect(
      db.query(`delete from bulk_unit where owner_id = $1 and id = $2`, [OWNER, BOX(1)]),
    ).rejects.toThrow("You need one default bulk box.");
    expect((await boxes()).map((b) => b.is_default)).toEqual([true, false]);
  });

  it("two defaults are refused too (the index from 0035)", async () => {
    await asOwner(db);
    await expect(
      db.query(`update bulk_unit set is_default = true where owner_id = $1 and id = $2`, [
        OWNER,
        BOX(2),
      ]),
    ).rejects.toThrow(/bulk_unit_one_default|duplicate key/);
  });
});

/* ------------------------------------------ 3. the trigger's fallback ------------------------------------------ */

describe("0036 · a bulk copy is never left with no box (QA's rule b)", () => {
  /** Inside one transaction, rolled back: the moment a write can be in with no default (it must end with one). */
  async function midWrite(prep: string[], copyN: number) {
    await asSuperuser(db);
    await db.exec(`begin;`);
    try {
      for (const sql of prep) await db.exec(sql);
      await db.query(
        `update copy set role = 'bulk', binder_id = null, binder_half = null, color_band = null where id = $1`,
        [COPY(copyN)],
      );
      return (
        await db.query<{ unit: string | null }>(
          `select bulk_unit_id as unit from copy where id = $1`,
          [COPY(copyN)],
        )
      ).rows[0].unit;
    } finally {
      await db.exec(`rollback;`);
    }
  }

  it("with no default: the box 0035 gave her (her first)", async () => {
    const first = (
      await q<{ id: string }>(`select md5('bulk-box:' || $1::text)::uuid::text as id`, [OWNER])
    )[0].id;
    await q(
      `insert into bulk_unit (id, owner_id, name, sort_order, is_default) values ($1, $2, 'Bulk box', 3, true), ($3, $2, 'Box B', 0, false)`,
      [first, OWNER, BOX(2)],
    );
    await shelved(1);
    expect(
      await midWrite([`update bulk_unit set is_default = false where id = '${first}'`], 1),
    ).toBe(first);
  });

  it("with no default and not that box: her lowest in order", async () => {
    await write([add(1, "Box A"), add(2, "Box B")]);
    await q(`update bulk_unit set sort_order = 9 where id = $1`, [BOX(1)]);
    await shelved(1);
    expect(
      await midWrite([`update bulk_unit set is_default = false where id = '${BOX(1)}'`], 1),
    ).toBe(BOX(2));
  });
});

/* ------------------------------------------ 4. a card names its box ------------------------------------------ */

describe("0036 · a card going to bulk names its box", () => {
  beforeEach(async () => {
    await write([add(1, "Bulk box"), add(2, "Box B", 1)]);
  });

  it("update_copy: the box she named", async () => {
    await shelved(1);
    await write([
      {
        op: "update_copy",
        id: COPY(1),
        patch: {
          role: "bulk",
          binder_id: null,
          binder_half: null,
          color_band: null,
          bulk_unit_id: BOX(2),
        },
      },
    ]);
    expect(await boxOf(1)).toEqual({ role: "bulk", unit: BOX(2) });
  });

  it("the real Move: to Box B; and a full Box B is refused in her words, with nothing written", async () => {
    await shelved(1);
    await shelved(2);
    await asOwner(db);
    await applyMove(
      pgliteClient(db),
      { copyId: COPY(1), destination: { kind: "bulk", unitId: BOX(2) } },
      names,
    );
    expect(await boxOf(1)).toEqual({ role: "bulk", unit: BOX(2) });
    await expect(
      applyMove(
        pgliteClient(db),
        { copyId: COPY(2), destination: { kind: "bulk", unitId: BOX(2) } },
        names,
      ),
    ).rejects.toThrow("Your Box B is full. Pick another box.");
    expect(await boxOf(2)).toEqual({ role: "shelved", unit: null });
  });

  it("a Move naming no box (a plan or tab from before boxes): her default box", async () => {
    await shelved(1);
    await asOwner(db);
    await applyMove(pgliteClient(db), { copyId: COPY(1), destination: { kind: "bulk" } }, names);
    expect(await boxOf(1)).toEqual({ role: "bulk", unit: BOX(1) });
  });

  describe("the Haul Plan's own route sends a duplicate to a box with room", () => {
    beforeEach(async () => {
      await shelved(1); // the copy she already has, so the next one is a plain duplicate → bulk
    });
    const dup = () => haulRow(COPY(2), CHARMANDER_SV03_026.tcgdexId);

    it("her default box, when it has room", async () => {
      await seedHaulRows(db, [dup()]);
      await asOwner(db);
      await commitCardPlacement(pgliteClient(db), { card: dup() });
      expect(await boxOf(2)).toEqual({ role: "bulk", unit: BOX(1) });
    });

    it("her default full: her next box with room", async () => {
      await write([{ op: "update_bulk_unit", id: BOX(1), patch: { capacity: 1 } }]);
      await bulkCopy(5, 1); // the default is full
      await seedHaulRows(db, [dup()]);
      await asOwner(db);
      await commitCardPlacement(pgliteClient(db), { card: dup() });
      expect(await boxOf(2)).toEqual({ role: "bulk", unit: BOX(2) });
    });

    it("every box full: refused in her words, and the card is still in her haul", async () => {
      await write([{ op: "update_bulk_unit", id: BOX(1), patch: { capacity: 1 } }]);
      await bulkCopy(5, 1);
      await bulkCopy(6, 2);
      await seedHaulRows(db, [dup()]);
      await asOwner(db);
      await expect(commitCardPlacement(pgliteClient(db), { card: dup() })).rejects.toThrow(
        "Your Bulk box is full. Pick another box.",
      );
      expect(await boxOf(2)).toEqual({ role: "haul", unit: null });
    });

    it("her Move on the Haul Plan naming Box B: Box B", async () => {
      await seedHaulRows(db, [dup()]);
      await asOwner(db);
      await commitCardPlacement(pgliteClient(db), {
        card: dup(),
        override: { kind: "bulk", unitId: BOX(2) },
      });
      expect(await boxOf(2)).toEqual({ role: "bulk", unit: BOX(2) });
    });

    it("a parked Move to bulk naming no box still commits, to her default box (the Senior BA's condition 4)", async () => {
      await seedHaulRows(db, [dup()]);
      await asOwner(db);
      await commitCardPlacement(pgliteClient(db), { card: dup(), override: { kind: "bulk" } });
      expect(await boxOf(2)).toEqual({ role: "bulk", unit: BOX(1) });
    });
  });
});

describe("0036 · every other writer that sends a card to bulk carries her box", () => {
  beforeEach(async () => {
    await write([add(1, "Bulk box"), add(2, "Box B")]);
  });

  it("a swap in a line: the card coming out goes to the box she picked", async () => {
    const LINE = id(1, "10000000");
    const SLOT = id(1, "20000000");
    await q(
      `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from, card_class) values
         ('emberling', 'Emberling', '{9301}', '{Fire}', 'Basic', null, 'standard'),
         ('emberdrake', 'Emberdrake', '{9302}', '{Fire}', 'Stage1', 'Emberling', 'standard'),
         ('emberdrake-alt', 'Emberdrake', '{9302}', '{Fire}', 'Stage1', 'Emberling', 'standard')`,
    );
    await q(
      `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
         values ($1, $2, 9301, 'red', $3, 'back', 'closed')`,
      [LINE, OWNER, GEN],
    );
    await q(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band) values
         ($1, $4, 'emberling', 'shelved', $5, 'back', 'red'), ($2, $4, 'emberdrake', 'shelved', $5, 'back', 'red'),
         ($3, $4, 'emberdrake-alt', 'shelved', $5, 'front', 'red')`,
      [COPY(10), COPY(11), COPY(12), OWNER, GEN],
    );
    await q(
      `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id) values
         ($1, $3, $4, 0, 'Basic', 'filled', $5), ($2, $3, $4, 1, 'Stage1', 'filled', $6)`,
      [id(0, "20000000"), SLOT, OWNER, LINE, COPY(10), COPY(11)],
    );
    await q(`update copy set line_slot_id = $1 where id = $2`, [id(0, "20000000"), COPY(10)]);
    await q(`update copy set line_slot_id = $1 where id = $2`, [SLOT, COPY(11)]);
    await asOwner(db);
    await applyMove(
      pgliteClient(db),
      {
        copyId: COPY(12),
        destination: { kind: "shelf", binderId: GEN, half: "back", band: "red" },
        lineChoice: {
          mode: "replace",
          lineId: LINE,
          slotId: SLOT,
          keep: false,
          outgoing: { kind: "bulk", unitId: BOX(2) },
        },
      },
      names,
    );
    expect(await boxOf(11)).toEqual({ role: "bulk", unit: BOX(2) });
  });

  it("a card removed from a collection goes to the box she picked", async () => {
    const SPEC = id(2, "b0000000");
    const COL = id(1, "a0000000");
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await seedCollections(db, [
      { id: COL, name: "Starters", targetCatalogCardIds: ["sv03-026"], currentBinderIds: [SPEC] },
    ]);
    await q(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id) values ($1, $2, 'sv03-026', 'shelved', $3)`,
      [COPY(20), OWNER, SPEC],
    );
    await asOwner(db);
    await applyCollectionRemoval(
      pgliteClient(db),
      { collectionId: COL, tcgdexId: "sv03-026", destination: { kind: "bulk", unitId: BOX(2) } },
      names,
    );
    expect(await boxOf(20)).toEqual({ role: "bulk", unit: BOX(2) });
  });
});
