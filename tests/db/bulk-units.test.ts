/**
 * UIL-130 PR 1 — migration 0035: bulk is a storage unit (a box) she names, and a full box with a card limit takes no
 * more. Karvi, 2026-09-29: several boxes like binders; a new box is untracked; a box with a finite capacity that is
 * full REFUSES ("Stop it, ask for another"); her first box is named "Bulk box".
 *
 *   1. Existing rows convert (the migration run against a pre-0035 database): one "Bulk box" per owner, every bulk
 *      copy in it, a spare card filling a pocket keeps it as home; a baseline re-stamped with the marked statements
 *      reads exactly as the migrated tables do, and a second run changes nothing.
 *   2. EVERY EXISTING BULK WRITER still works unchanged (the Senior BA's condition): each writer the code scan finds
 *      (the static test at the end lists them) runs through its real lib function on real Postgres, and the copy lands
 *      in her default box; a copy leaving bulk loses its box; a spare card filling a pocket keeps its home box.
 *   3. An account with no box gets "Bulk box" on its first bulk write, in the same transaction.
 *   4. A box with a capacity that is full refuses, in her words, and nothing is written; an untracked box is never
 *      full; moving OUT of a full box is never refused; a copy cannot sit in another owner's box.
 *
 * Real Postgres (PGlite, every migration), the real writers, as the authenticated owner.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyMove, type MoveNameLookups } from "@/lib/line";
import { applyStageDecisions } from "@/lib/line/write";
import { clearCatalogCache, commitCardPlacement } from "@/lib/plan";
import { CHARMANDER_SV03_026 } from "../engine/fixtures";
import {
  applyMigration,
  asOwner,
  asSuperuser,
  freshRpcDb,
  haulRow,
  OWNER,
  seedBinders,
  seedCatalogCardsFull,
  seedHaulRows,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const GEN = "b0000000-0000-4000-8000-000000000130";
const OTHER = "00000000-0000-4000-8000-0000000000b2";
const id = (n: number, prefix: string) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const COPY = (n: number) => id(n, "c0000000");
const LINE = (n: number) => id(n, "10000000");
const SLOT = (n: number) => id(n, "20000000");
const BOX = (n: number) => id(n, "d0000000");
const FULL = "Your Bulk box is full. Pick another box.";
const names: MoveNameLookups = {
  binderName: () => "KB-001",
  collectionName: () => null,
  bandDisplay: (k) => k,
};

let db: PGlite;
afterEach(async () => {
  if (db && !db.closed) await db.close();
});

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  await asSuperuser(db);
  return (await db.query<T>(sql, params)).rows;
}
async function exec(sql: string): Promise<void> {
  await asSuperuser(db);
  await db.exec(sql);
}
async function copyOf(n: number, role: string, extra: { binder?: string; half?: string } = {}) {
  await q(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
       values ($1, $2, 'sv03-026', $3, $4, $5, $6)`,
    [COPY(n), OWNER, role, extra.binder ?? null, extra.half ?? null, extra.binder ? "red" : null],
  );
}
const unitOf = async (n: number) =>
  (
    await q<{ role: string; unit: string | null }>(
      `select role, bulk_unit_id as unit from copy where id = $1`,
      [COPY(n)],
    )
  )[0];
const defaultBox = async () =>
  (
    await q<{ id: string }>(`select id from bulk_unit where owner_id = $1 and is_default`, [OWNER])
  )[0]?.id ?? null;

/* ------------------------------------------ 1. conversion ------------------------------------------ */

describe("0035 · existing rows convert, in her terms", () => {
  beforeEach(async () => {
    db = await freshRpcDb({ before: "0035" });
    await seedCatalogCardsFull(db, [CHARMANDER_SV03_026]);
    await seedBinders(db, [{ id: GEN, type: "general", name: "KB-001" }]);
    // Her bulk box (three copies), a card still in the haul, a shelved card, and a spare card filling a pocket.
    for (const n of [1, 2, 3]) await copyOf(n, "bulk");
    await copyOf(4, "haul");
    await copyOf(5, "shelved", { binder: GEN, half: "front" });
    await q(
      `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
         values ($1, $2, 4, 'red', $3, 'back', 'open')`,
      [LINE(1), OWNER, GEN],
    );
    await q(
      `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, stage_choice) values
         ($1, $3, $4, 0, 'Basic', 'block', 'filler'), ($2, $3, $4, 1, 'Stage1', 'placeholder', null)`,
      [SLOT(1), SLOT(2), OWNER, LINE(1)],
    );
    await copyOf(6, "block", { binder: GEN, half: "back" });
    await q(
      `insert into binder_block (id, owner_id, binder_id, half, pocket_count, purpose, material, copy_id, line_id, line_slot_id)
         values ($1, $2, $3, 'back', 1, 'line-filler', 'repurposedDuplicate', $4, $5, $6)`,
      [id(1, "b1000000"), OWNER, GEN, COPY(6), LINE(1), SLOT(1)],
    );
    // A baseline is a plain copy of these tables, taken before 0035; the re-stamp adds 0035's table and column.
    await exec(`create schema backup_t;
      create table backup_t.copy as table public.copy;
      create table backup_t.binder as table public.binder;
      create table backup_t.binder_block as table public.binder_block;`);
    await applyMigration(db, "0035_bulk_units.sql");
  });

  it("one 'Bulk box' for her, her default, untracked, with an id derived from her (the same on a baseline)", async () => {
    expect(
      await q(`select owner_id, name, is_default, capacity, kind, sort_order from bulk_unit`),
    ).toEqual([
      {
        owner_id: OWNER,
        name: "Bulk box",
        is_default: true,
        capacity: null,
        kind: "bulk",
        sort_order: 0,
      },
    ]);
  });

  it("every bulk copy is in it; the haul and the shelf have no box; the spare card in a pocket keeps it as home", async () => {
    const box = await defaultBox();
    for (const n of [1, 2, 3]) expect(await unitOf(n)).toEqual({ role: "bulk", unit: box });
    expect(await unitOf(4)).toEqual({ role: "haul", unit: null });
    expect(await unitOf(5)).toEqual({ role: "shelved", unit: null });
    expect(await unitOf(6)).toEqual({ role: "block", unit: box });
  });

  /** The migration's marked conversion statements, as the baseline re-stamp reads them. */
  const conversion = () => {
    const sql = readFileSync(
      path.join(process.cwd(), "supabase", "migrations", "0035_bulk_units.sql"),
      "utf8",
    );
    const from = sql.indexOf("\n-- >>> 0035 CONVERSION");
    const to = sql.indexOf("\n-- <<< 0035 CONVERSION");
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    return sql.slice(from, to);
  };
  const rows = async (schema: string) => {
    const out: Record<string, unknown[]> = {};
    for (const t of ["bulk_unit", "copy"])
      out[t] = (
        await q<{ r: Record<string, unknown> }>(
          `select to_jsonb(t) as r from ${schema}.${t} t order by t.id`,
        )
      ).map((x) => {
        // A box's created_at is when it was made, on either side: compared without it.
        const r = { ...x.r };
        delete r.created_at;
        return r;
      });
    return out;
  };

  it("a baseline copy re-stamped with the marked statements reads exactly as the migrated tables do", async () => {
    // The re-stamp's plain step: 0035's table and column, without keys (a baseline copy has none).
    await exec(`create table backup_t.bulk_unit (
        id uuid default gen_random_uuid(), owner_id uuid, name text, sort_order integer default 0,
        is_default boolean default false, capacity integer, kind text default 'bulk', created_at timestamptz default now());
      alter table backup_t.copy add column bulk_unit_id uuid;`);
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

/* ------------------------------------------ 2-4. the trigger ------------------------------------------ */

describe("0035 · every bulk writer keeps working, and the copy lands in her box", () => {
  beforeEach(async () => {
    db = await freshRpcDb();
    await seedCatalogCardsFull(db, [CHARMANDER_SV03_026]);
    await seedBinders(db, [{ id: GEN, type: "general", name: "KB-001" }]);
    clearCatalogCache();
    // Her box exists (the conversion's, or the one her first bulk write made).
    await q(
      `insert into bulk_unit (id, owner_id, name, is_default) values ($1, $2, 'Bulk box', true)`,
      [BOX(1), OWNER],
    );
  });

  it("lib/line/move.ts · a Move to the bulk box (Lines, Lookup, Collections)", async () => {
    await copyOf(1, "shelved", { binder: GEN, half: "front" });
    await asOwner(db);
    await applyMove(pgliteClient(db), { copyId: COPY(1), destination: { kind: "bulk" } }, names);
    expect(await unitOf(1)).toEqual({ role: "bulk", unit: BOX(1) });
  });

  it("lib/plan/placement.ts · the Haul Plan routes a plain duplicate to the bulk box", async () => {
    await copyOf(1, "shelved", { binder: GEN, half: "front" });
    const dup = haulRow(COPY(2), CHARMANDER_SV03_026.tcgdexId);
    await seedHaulRows(db, [dup]);
    await asOwner(db);
    await commitCardPlacement(pgliteClient(db), { card: dup });
    expect(await unitOf(2)).toEqual({ role: "bulk", unit: BOX(1) });
  });

  it("lib/plan/commit.ts · a holo over the normal in a front half: the normal goes to the bulk box", async () => {
    await copyOf(1, "shelved", { binder: GEN, half: "front" });
    const holo = haulRow(COPY(2), CHARMANDER_SV03_026.tcgdexId, "holo");
    await seedHaulRows(db, [holo]);
    await asOwner(db);
    await commitCardPlacement(pgliteClient(db), { card: holo });
    expect(await unitOf(2)).toMatchObject({ role: "shelved", unit: null });
    expect(await unitOf(1)).toEqual({ role: "bulk", unit: BOX(1) });
  });

  describe("a spare card that fills a pocket keeps its home box, and goes back there", () => {
    beforeEach(async () => {
      await q(
        `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from, card_class) values
           ('emberling', 'Emberling', '{9301}', '{Fire}', 'Basic', null, 'standard'),
           ('emberdrake', 'Emberdrake', '{9302}', '{Fire}', 'Stage1', 'Emberling', 'standard'),
           ('emberlord', 'Emberlord', '{9303}', '{Fire}', 'Stage2', 'Emberdrake', 'standard')`,
      );
      await q(
        `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
           values ($1, $2, 9301, 'red', $3, 'back', 'open')`,
        [LINE(1), OWNER, GEN],
      );
      await q(
        `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
           values ($1, $2, 'emberling', 'shelved', $3, 'back', 'red')`,
        [COPY(10), OWNER, GEN],
      );
      await q(
        `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id) values
           ($1, $4, $5, 0, 'Basic', 'filled', $6), ($2, $4, $5, 1, 'Stage1', 'placeholder', null),
           ($3, $4, $5, 2, 'Stage2', 'placeholder', null)`,
        [SLOT(0), SLOT(1), SLOT(2), OWNER, LINE(1), COPY(10)],
      );
      await q(`update copy set line_slot_id = $1 where id = $2`, [SLOT(0), COPY(10)]);
      // Her spare Emberling, in a SECOND box (not her default), so going home is observable.
      await q(`insert into bulk_unit (id, owner_id, name) values ($1, $2, 'Box B')`, [
        BOX(2),
        OWNER,
      ]);
      await q(
        `insert into copy (id, owner_id, catalog_card_id, role, bulk_unit_id) values ($1, $2, 'emberling', 'bulk', $3)`,
        [COPY(11), OWNER, BOX(2)],
      );
      await asOwner(db);
      await applyStageDecisions(pgliteClient(db), {
        lineId: LINE(1),
        stages: { 1: { kind: "filler", filler: { material: "card", copyId: COPY(11) } } },
      });
    });

    it("the filler pick: it leaves bulk and keeps Box B as its home", async () => {
      expect(await unitOf(11)).toEqual({ role: "block", unit: BOX(2) });
    });

    it("lib/line/decide-stages.ts · taken back out ('Decide later'): back to Box B, not the default box", async () => {
      await asOwner(db);
      await applyStageDecisions(pgliteClient(db), {
        lineId: LINE(1),
        stages: { 1: { kind: "later" } },
      });
      expect(await unitOf(11)).toEqual({ role: "bulk", unit: BOX(2) });
    });

    it("lib/line/line-choice.ts · a card joining the stage the filler held: the filler goes back to Box B", async () => {
      await q(
        `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
           values ($1, $2, 'emberdrake', 'shelved', $3, 'front', 'red')`,
        [COPY(12), OWNER, GEN],
      );
      await asOwner(db);
      await applyMove(
        pgliteClient(db),
        {
          copyId: COPY(12),
          destination: { kind: "shelf", binderId: GEN, half: "back", band: "red" },
          lineChoice: {
            mode: "join",
            lineId: LINE(1),
            slotId: SLOT(1),
            stages: { 2: { kind: "empty" } },
          },
        },
        names,
      );
      expect(await unitOf(11)).toEqual({ role: "bulk", unit: BOX(2) });
    });
  });

  it("a copy leaving the bulk box for a binder has no box", async () => {
    await copyOf(1, "shelved", { binder: GEN, half: "front" });
    await asOwner(db);
    await applyMove(pgliteClient(db), { copyId: COPY(1), destination: { kind: "bulk" } }, names);
    await applyMove(
      pgliteClient(db),
      {
        copyId: COPY(1),
        destination: { kind: "shelf", binderId: GEN, half: "front", band: "red" },
      },
      names,
    );
    expect(await unitOf(1)).toEqual({ role: "shelved", unit: null });
  });
});

describe("0035 · an account with no box gets 'Bulk box' on its first bulk write", () => {
  it("created in the same write, as her default, untracked", async () => {
    db = await freshRpcDb();
    await seedCatalogCardsFull(db, [CHARMANDER_SV03_026]);
    await seedBinders(db, [{ id: GEN, type: "general", name: "KB-001" }]);
    await copyOf(1, "shelved", { binder: GEN, half: "front" });
    expect(await q(`select count(*)::int n from bulk_unit`)).toEqual([{ n: 0 }]);
    await asOwner(db);
    await applyMove(pgliteClient(db), { copyId: COPY(1), destination: { kind: "bulk" } }, names);
    const boxes = await q<{
      id: string;
      name: string;
      is_default: boolean;
      capacity: number | null;
    }>(`select id, name, is_default, capacity from bulk_unit where owner_id = $1`, [OWNER]);
    expect(boxes).toEqual([
      { id: expect.any(String), name: "Bulk box", is_default: true, capacity: null },
    ]);
    expect(await unitOf(1)).toEqual({ role: "bulk", unit: boxes[0].id });
  });
});

describe("0035 · a full box with a card limit takes no more (Karvi: 'Stop it, ask for another')", () => {
  beforeEach(async () => {
    db = await freshRpcDb();
    await seedCatalogCardsFull(db, [CHARMANDER_SV03_026]);
    await seedBinders(db, [{ id: GEN, type: "general", name: "KB-001" }]);
    await q(
      `insert into bulk_unit (id, owner_id, name, is_default, capacity) values ($1, $2, 'Bulk box', true, 1)`,
      [BOX(1), OWNER],
    );
    await q(
      `insert into copy (id, owner_id, catalog_card_id, role, bulk_unit_id) values ($1, $2, 'sv03-026', 'bulk', $3)`,
      [COPY(1), OWNER, BOX(1)],
    );
    await copyOf(2, "shelved", { binder: GEN, half: "front" });
  });

  it("a writer that names no box, into a FULL default box: refused in her words, and nothing is written", async () => {
    await asOwner(db);
    await expect(
      applyMove(pgliteClient(db), { copyId: COPY(2), destination: { kind: "bulk" } }, names),
    ).rejects.toThrow(FULL);
    expect(await unitOf(2)).toEqual({ role: "shelved", unit: null });
    expect(await q(`select count(*)::int n from placement_decision`)).toEqual([{ n: 0 }]);
  });

  it("a copy already in a box over its limit, changed in another way, is not refused (it is not entering the box)", async () => {
    // She lowered the limit below what the box holds: it is over, and only a card ENTERING it is refused.
    await q(`update bulk_unit set capacity = null where id = $1`, [BOX(1)]);
    await q(
      `insert into copy (id, owner_id, catalog_card_id, role, bulk_unit_id) values ($1, $2, 'sv03-026', 'bulk', $3)`,
      [COPY(3), OWNER, BOX(1)],
    );
    await q(`update bulk_unit set capacity = 1 where id = $1`, [BOX(1)]);
    await asOwner(db);
    await db.query(`update copy set variant = 'holo' where id = $1`, [COPY(1)]);
    expect(await unitOf(1)).toEqual({ role: "bulk", unit: BOX(1) });
  });

  it("moving OUT of a full box is never refused", async () => {
    await asOwner(db);
    await applyMove(
      pgliteClient(db),
      {
        copyId: COPY(1),
        destination: { kind: "shelf", binderId: GEN, half: "front", band: "red" },
      },
      names,
    );
    expect(await unitOf(1)).toEqual({ role: "shelved", unit: null });
  });

  it("with room again, the same move goes through", async () => {
    await q(`update bulk_unit set capacity = 2 where id = $1`, [BOX(1)]);
    await asOwner(db);
    await applyMove(pgliteClient(db), { copyId: COPY(2), destination: { kind: "bulk" } }, names);
    expect(await unitOf(2)).toEqual({ role: "bulk", unit: BOX(1) });
  });

  it("an untracked box is never full", async () => {
    await q(`update bulk_unit set capacity = null where id = $1`, [BOX(1)]);
    for (const n of [3, 4, 5]) await copyOf(n, "shelved", { binder: GEN, half: "front" });
    await asOwner(db);
    for (const n of [2, 3, 4, 5])
      await applyMove(pgliteClient(db), { copyId: COPY(n), destination: { kind: "bulk" } }, names);
    expect(await q(`select count(*)::int n from copy where bulk_unit_id = $1`, [BOX(1)])).toEqual([
      { n: 5 },
    ]);
  });

  it("a copy cannot sit in another owner's box", async () => {
    await q(
      `insert into bulk_unit (id, owner_id, name, is_default) values ($1, $2, 'Theirs', true)`,
      [BOX(9), OTHER],
    );
    await asOwner(db);
    await expect(
      db.query(`update copy set role = 'bulk', bulk_unit_id = $1 where id = $2`, [BOX(9), COPY(2)]),
    ).rejects.toThrow(/isn't one of yours/);
    // …and not by a writer that sees every box either (the service role, a migration): the owners must match.
    await asSuperuser(db);
    await expect(
      db.query(`update copy set role = 'bulk', bulk_unit_id = $1 where id = $2`, [BOX(9), COPY(2)]),
    ).rejects.toThrow(/isn't one of yours/);
  });
});

/* ------------------------------------------ the writer list ------------------------------------------ */

describe("0035 · every writer of a bulk copy is on the list above (a new one must be tested here, or this fails)", () => {
  /** Where the app writes `role: "bulk"`, found by a scan of lib/ and app/ (tests excluded). */
  const WRITERS: Record<string, string> = {
    "lib/line/move.ts": "placementForMove: a Move to the bulk box",
    "lib/plan/placement.ts": "copyPlacementFromTarget: the Haul Plan's bulk route",
    "lib/plan/commit.ts": "writeCard: a holo upgrade's displaced copy",
    "lib/line/decide-stages.ts": "Choose: a spare card taken back out of its pocket",
    "lib/line/line-choice.ts":
      "the line builder: a spare card coming out of the pocket a card takes",
    "lib/backfill/context.ts": "not a write: the shared rule's view of a bulk copy",
  };
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = path.join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
    });

  it("the scan finds exactly the listed files", () => {
    const root = process.cwd();
    const found = ["lib", "app"]
      .flatMap((d) => files(path.join(root, d)))
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .filter((f) => /role:\s*"bulk"/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(root, f))
      .sort();
    expect(found).toEqual(Object.keys(WRITERS).sort());
  });
});
