/**
 * UIL-130 — a spare card coming OUT of its pocket goes back to its home box, or to the box she picks when that one is
 * full (the Senior BA's condition: asked, never silently). Real Postgres (PGlite, every migration), the real writers
 * and loaders, as the owner.
 *
 *   - Choose (applyStageDecisions): she changes a stage a spare card fills; its home is full → refused in her words;
 *     with a box she picked → it goes there. The model says which spare cards a line holds and where they live.
 *   - An Add into the stage a spare card fills (the line builder, through the real Move): the same, and the popup's
 *     model names the spare card coming out with its home box.
 *
 * 0037: the refusals below still hold for a card she did not knowingly send to the full box. Her "Add anyway" into a
 * full box lands, recorded with the move: tests/db/override-full-box.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyMove, type MoveNameLookups } from "@/lib/line";
import { applyStageDecisions } from "@/lib/line/write";
import { loadLineStagesModel } from "@/lib/line/stages-load";
import { loadLinePopupModel } from "@/lib/line/popup-load";
import { asOwner, asSuperuser, freshRpcDb, OWNER, seedBinders } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const GEN = "b0000000-0000-4000-8000-0000000001b0";
const LINE = "10000000-0000-4000-8000-0000000001b0";
const S = (n: number) => `20000000-0000-4000-8000-0000000001b${n}`;
const C = (n: number) => `c0000000-0000-4000-8000-0000000001b${n}`;
const BOX = (n: number) => `d0000000-0000-4000-8000-0000000001b${n}`;
const FULL_B = "Your Box B is full. Pick another box.";
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
const boxOf = async (id: string) =>
  (
    await q<{ role: string; unit: string | null }>(
      `select role, bulk_unit_id as unit from copy where id = $1`,
      [id],
    )
  )[0];

beforeEach(async () => {
  db = await freshRpcDb();
  await seedBinders(db, [{ id: GEN, type: "general", name: "KB-001" }]);
  await q(
    `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from, card_class) values
       ('emberling', 'Emberling', '{9301}', '{Fire}', 'Basic', null, 'standard'),
       ('emberdrake', 'Emberdrake', '{9302}', '{Fire}', 'Stage1', 'Emberling', 'standard'),
       ('emberlord', 'Emberlord', '{9303}', '{Fire}', 'Stage2', 'Emberdrake', 'standard')`,
  );
  // Her boxes: her default (no limit), Box B (room for 1), Box C (no limit).
  await q(
    `insert into bulk_unit (id, owner_id, name, is_default, capacity, sort_order) values
       ($1, $4, 'Bulk box', true, null, 0), ($2, $4, 'Box B', false, 1, 1), ($3, $4, 'Box C', false, null, 2)`,
    [BOX(1), BOX(2), BOX(3), OWNER],
  );
  // Her line: the Emberling, an open Stage 1, an open Stage 2.
  await q(
    `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
       values ($1, $2, 9301, 'red', $3, 'back', 'open')`,
    [LINE, OWNER, GEN],
  );
  await q(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
       values ($1, $2, 'emberling', 'shelved', $3, 'back', 'red')`,
    [C(0), OWNER, GEN],
  );
  await q(
    `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id) values
       ($1, $4, $5, 0, 'Basic', 'filled', $6), ($2, $4, $5, 1, 'Stage1', 'placeholder', null),
       ($3, $4, $5, 2, 'Stage2', 'placeholder', null)`,
    [S(0), S(1), S(2), OWNER, LINE, C(0)],
  );
  await q(`update copy set line_slot_id = $1 where id = $2`, [S(0), C(0)]);
  // Her spare Emberling, from Box B, fills the Stage 1; then Box B fills up with another card.
  await q(
    `insert into copy (id, owner_id, catalog_card_id, role, bulk_unit_id) values ($1, $2, 'emberling', 'bulk', $3)`,
    [C(1), OWNER, BOX(2)],
  );
  await asOwner(db);
  await applyStageDecisions(pgliteClient(db), {
    lineId: LINE,
    stages: { 1: { kind: "filler", filler: { material: "card", copyId: C(1) } } },
  });
  await q(
    `insert into copy (id, owner_id, catalog_card_id, role, bulk_unit_id) values ($1, $2, 'emberling', 'bulk', $3)`,
    [C(2), OWNER, BOX(2)],
  );
});

describe("Choose: a spare card taken out of its pocket", () => {
  it("the model names the spare card the line holds and its home box", async () => {
    await asOwner(db);
    const model = await loadLineStagesModel(pgliteClient(db), LINE);
    expect(model.spares).toEqual({ [C(1)]: { name: "Emberling", homeBoxId: BOX(2) } });
    expect(model.boxes?.find((b) => b.id === BOX(2))).toMatchObject({ held: 1, capacity: 1 });
  });

  it("its home full and no box picked: refused in her words, and nothing moves", async () => {
    await asOwner(db);
    await expect(
      applyStageDecisions(pgliteClient(db), { lineId: LINE, stages: { 1: { kind: "empty" } } }),
    ).rejects.toThrow(FULL_B);
    expect(await boxOf(C(1))).toEqual({ role: "block", unit: BOX(2) });
  });

  it("with the box she picked: it goes there", async () => {
    await asOwner(db);
    await applyStageDecisions(pgliteClient(db), {
      lineId: LINE,
      stages: { 1: { kind: "empty" } },
      returnBoxes: { [C(1)]: BOX(3) },
    });
    expect(await boxOf(C(1))).toEqual({ role: "bulk", unit: BOX(3) });
  });
});

describe("an Add into the stage a spare card fills: it comes out", () => {
  beforeEach(async () => {
    await q(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
         values ($1, $2, 'emberdrake', 'shelved', $3, 'front', 'red')`,
      [C(5), OWNER, GEN],
    );
  });
  const join = (returnBoxes?: Record<string, string>) =>
    applyMove(
      pgliteClient(db),
      {
        copyId: C(5),
        destination: { kind: "shelf", binderId: GEN, half: "back", band: "red" },
        lineChoice: {
          mode: "join",
          lineId: LINE,
          slotId: S(1),
          stages: { 2: { kind: "empty" } },
          ...(returnBoxes ? { returnBoxes } : {}),
        },
      },
      names,
    );

  it("the popup's model names the spare card coming out and its home box", async () => {
    await asOwner(db);
    const model = await loadLinePopupModel(pgliteClient(db), C(5), {
      kind: "add",
      lineId: LINE,
      slotId: S(1),
    });
    expect(model.returning).toEqual([{ copyId: C(1), name: "Emberling", homeBoxId: BOX(2) }]);
  });

  it("its home full and no box picked: refused in her words", async () => {
    await asOwner(db);
    await expect(join()).rejects.toThrow(FULL_B);
    expect(await boxOf(C(1))).toEqual({ role: "block", unit: BOX(2) });
  });

  it("with the box she picked: it goes there, and the card takes the pocket", async () => {
    await asOwner(db);
    await join({ [C(1)]: BOX(3) });
    expect(await boxOf(C(1))).toEqual({ role: "bulk", unit: BOX(3) });
    expect(await q(`select state, copy_id from line_slot where id = $1`, [S(1)])).toEqual([
      { state: "filled", copy_id: C(5) },
    ]);
  });
});
