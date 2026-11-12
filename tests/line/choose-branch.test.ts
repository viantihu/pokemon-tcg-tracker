/**
 * #493 — Lines' "Choose" on a line whose chain BRANCHES before its last stage (Oddish → Gloom → Vileplume or
 * Bellossom). The chain walk stops at a branch, so a Stage 2 left "Not decided" had no species: the popup dropped it
 * and said "Every stage of this line holds a card", with nothing to choose. Now the popup offers the ways the line can
 * go, she picks one, and the write checks her pick. On real Postgres (PGlite, every migration), as the owner.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyStageDecisions } from "@/lib/line/write";
import { loadLineStagesModel } from "@/lib/line/stages-load";
import { DECIDE_REFUSAL } from "@/lib/line/decide-stages";
import { clearCatalogCache } from "@/lib/plan/catalog-cache";
import { asOwner, asSuperuser, freshRpcDb, OWNER, seedBinders } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const GEN = "b0000000-0000-4000-8000-00000000b493";
const LINE = "10000000-0000-4000-8000-00000000b493";
const SLOT = (n: number) => `20000000-0000-4000-8000-000000b4930${n}`;
const COPY = (n: number) => `c0000000-0000-4000-8000-000000b4930${n}`;

let db: PGlite;
afterEach(async () => {
  if (db && !db.closed) await db.close();
});
async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  await asSuperuser(db);
  return (await db.query<T>(sql, params)).rows;
}
const model = async () => {
  await asOwner(db);
  return loadLineStagesModel(pgliteClient(db), LINE);
};
const decide = async (choice: Parameters<typeof applyStageDecisions>[1]) => {
  await asOwner(db);
  return applyStageDecisions(pgliteClient(db), choice);
};

beforeEach(async () => {
  clearCatalogCache();
  db = await freshRpcDb();
  await seedBinders(db, [{ id: GEN, type: "general", name: "KB-001" }]);
  await q(
    `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from, card_class) values
       ('budling', 'Budling', '{9401}', '{Grass}', 'Basic', null, 'standard'),
       ('budbloom', 'Budbloom', '{9402}', '{Grass}', 'Stage1', 'Budling', 'standard'),
       ('budthorn', 'Budthorn', '{9403}', '{Grass}', 'Stage2', 'Budbloom', 'standard'),
       ('budpetal', 'Budpetal', '{9404}', '{Grass}', 'Stage2', 'Budbloom', 'standard')`,
  );
  await q(
    `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
       values ($1, $2, 9401, 'green', $3, 'back', 'open')`,
    [LINE, OWNER, GEN],
  );
  await q(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band) values
       ($1, $3, 'budling', 'shelved', $4, 'back', 'green'),
       ($2, $3, 'budbloom', 'shelved', $4, 'back', 'green')`,
    [COPY(1), COPY(2), OWNER, GEN],
  );
  await q(
    `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id) values
       ($1, $4, $5, 0, 'Basic', 'filled', $6), ($2, $4, $5, 1, 'Stage1', 'filled', $7),
       ($3, $4, $5, 2, 'Stage2', 'placeholder', null)`,
    [SLOT(0), SLOT(1), SLOT(2), OWNER, LINE, COPY(1), COPY(2)],
  );
});

describe("#493 · a Stage 2 past a branch, not decided", () => {
  it("the popup offers both ways the line can evolve, each with that stage's species", async () => {
    const m = await model();
    expect(m.branch?.stageIndex).toBe(2);
    expect(m.branch?.options.map((o) => [o.name, o.stages[2]?.dexId])).toEqual([
      ["Budpetal", 9404],
      ["Budthorn", 9403],
    ]);
    // Nothing is picked for her: the stage itself still has no species until she picks a way.
    expect(m.stages[2]).toMatchObject({ state: "wanted" });
    expect(m.stages[2].dexId).toBeUndefined();
  });

  it("she picks a way and chases its card", async () => {
    await decide({
      lineId: LINE,
      branchDexId: 9404,
      stages: { 2: { kind: "chase", catalogCardId: "budpetal" } },
    });
    const [slot] = await q<{ stage_choice: string; target: string }>(
      `select stage_choice, target_catalog_card_id as target from line_slot where id = $1`,
      [SLOT(2)],
    );
    expect(slot).toEqual({ stage_choice: "chase", target: "budpetal" });
    // Once the line chases a card, it says which way it goes: no branch is asked again.
    expect((await model()).branch).toBeUndefined();
    expect((await model()).stages[2].dexId).toBe(9404);
  });

  it("a choice past the branch without a way picked is refused, in her words", async () => {
    await expect(decide({ lineId: LINE, stages: { 2: { kind: "empty" } } })).rejects.toThrow(
      DECIDE_REFUSAL.branch,
    );
  });

  it("a way the line cannot follow is not taken", async () => {
    await expect(
      decide({ lineId: LINE, branchDexId: 9401, stages: { 2: { kind: "empty" } } }),
    ).rejects.toThrow(DECIDE_REFUSAL.branch);
  });
});
