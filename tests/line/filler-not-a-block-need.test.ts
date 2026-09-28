/**
 * UIL-121 × UIL-030 — a stage she FILLED (a filler: a basic energy or a spare card) is not an open binder-block need.
 *
 * A filler stage is a block slot (state 'block') whose pocket the block row naming it fills. The Haul Plan's "use as a
 * binder block" offer and the Move's block destination counted a block slot as open when its line had no
 * 'line-terminated' row, which a filler's 'line-filler' row is not. So once she filled a stage, every bulk-bound
 * duplicate was offered as its block, and taking the offer put a SECOND card in a pocket she had already filled.
 * Real Postgres (PGlite, every migration), the real writers, as the owner.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyMove, type MoveNameLookups } from "@/lib/line";
import { applyStageDecisions } from "@/lib/line/write";
import { loadPlanContext } from "@/lib/plan/context";
import { clearCatalogCache } from "@/lib/plan";
import { asOwner, asSuperuser, freshRpcDb, OWNER, seedBinders } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const GEN = "b0000000-0000-4000-8000-00000000bb01";
const LINE = "10000000-0000-4000-8000-00000000bb01";
const S = (n: number) => `20000000-0000-4000-8000-00000000bb0${n}`;
const C = (n: number) => `c0000000-0000-4000-8000-00000000bb0${n}`;
const names: MoveNameLookups = {
  binderName: () => "KB-001",
  collectionName: () => null,
  bandDisplay: (k) => k,
};
const asBlock = { kind: "block", lineId: LINE, slotId: S(1), binderId: GEN } as const;

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedBinders(db, [{ id: GEN, type: "general", name: "KB-001" }]);
  await db.query(
    `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from, card_class) values
       ('emberling', 'Emberling', '{9301}', '{Fire}', 'Basic', null, 'standard'),
       ('emberdrake', 'Emberdrake', '{9302}', '{Fire}', 'Stage1', 'Emberling', 'standard'),
       ('emberlord', 'Emberlord', '{9303}', '{Fire}', 'Stage2', 'Emberdrake', 'standard')`,
  );
  await db.query(
    `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
       values ($1, $2, 9301, 'red', $3, 'back', 'open')`,
    [LINE, OWNER, GEN],
  );
  // Her Emberling in the Basic slot, and a spare Emberling in the front half.
  await db.query(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band) values
       ($1, $2, 'emberling', 'shelved', $3, 'back', 'red'), ($4, $2, 'emberling', 'shelved', $3, 'front', 'red')`,
    [C(0), OWNER, GEN, C(9)],
  );
  await db.query(
    `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id) values
       ($1, $4, $5, 0, 'Basic', 'filled', $6), ($2, $4, $5, 1, 'Stage1', 'placeholder', null),
       ($3, $4, $5, 2, 'Stage2', 'placeholder', null)`,
    [S(0), S(1), S(2), OWNER, LINE, C(0)],
  );
  await db.query(`update copy set line_slot_id = $1 where id = $2`, [S(0), C(0)]);
  clearCatalogCache();
});
afterEach(async () => {
  await db.close();
});
const blocks = async () => {
  await asSuperuser(db);
  const rows = (await db.query(`select purpose, line_slot_id, copy_id from binder_block`)).rows;
  await asOwner(db);
  return rows;
};

describe("a stage she filled with an energy", () => {
  beforeEach(async () => {
    await asOwner(db);
    await applyStageDecisions(pgliteClient(db), {
      lineId: LINE,
      stages: { 1: { kind: "filler", filler: { material: "energy" } } },
    });
  });

  it("is not offered on the Haul Plan as a block to fill", async () => {
    const pc = await loadPlanContext(pgliteClient(db), { excludeOwnedCopyIds: [] });
    expect(pc.blockNeeds).toEqual([]);
    expect(pc.ctx.openBlockNeeds).toBe(0);
  });

  it("a Move of a card as its block is refused, and the pocket keeps only her energy", async () => {
    await expect(
      applyMove(pgliteClient(db), { copyId: C(9), destination: asBlock }, names),
    ).rejects.toThrow(/already filled/);
    expect(await blocks()).toEqual([{ purpose: "line-filler", line_slot_id: S(1), copy_id: null }]);
  });
});

describe("a pocket a block row already names is filled, whatever the stage says", () => {
  it("a block slot with a row on it and no stage choice recorded is not offered either", async () => {
    await asOwner(db);
    await applyStageDecisions(pgliteClient(db), {
      lineId: LINE,
      stages: { 1: { kind: "filler", filler: { material: "energy" } } },
    });
    await asSuperuser(db);
    await db.query(`update line_slot set stage_choice = null where id = $1`, [S(1)]);
    await asOwner(db);
    const pc = await loadPlanContext(pgliteClient(db), { excludeOwnedCopyIds: [] });
    expect(pc.blockNeeds).toEqual([]);
  });
});

describe("an older engine block slot, with nothing in its pocket, is still a need (UIL-030)", () => {
  beforeEach(async () => {
    await asSuperuser(db);
    await db.query(`update line_slot set state = 'block' where id = $1`, [S(1)]);
    await asOwner(db);
  });

  it("is offered, and a Move fills it", async () => {
    const pc = await loadPlanContext(pgliteClient(db), { excludeOwnedCopyIds: [] });
    expect((pc.blockNeeds ?? []).map((n) => n.slotId)).toEqual([S(1)]);
    await applyMove(pgliteClient(db), { copyId: C(9), destination: asBlock }, names);
    expect(await blocks()).toEqual([
      expect.objectContaining({ purpose: "line-terminated", copy_id: C(9) }),
    ]);
  });
});
