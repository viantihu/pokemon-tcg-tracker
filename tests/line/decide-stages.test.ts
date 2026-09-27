/**
 * UIL-121 A2c — Lines' "Choose": her choice for an existing line's open stages and its third pocket, on real Postgres
 * (PGlite, every migration, 0030/0032's rules), through the real `applyStageDecisions`, as the owner.
 *
 * Karvi, 2026-09-27: nothing is written for her. A stage left "Not decided" (in the popup, or on a line from before her
 * choices) is decided here, and she can change her mind: what the stage had comes out (a filler's block, a spare card
 * back to bulk; a chase's wish closes), and the line's status follows her choices. Her two complete two-card lines on
 * Testing get their third pocket this way.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyStageDecisions } from "@/lib/line/write";
import { loadLineScreen } from "@/lib/line";
import { DECIDE_REFUSAL } from "@/lib/line/decide-stages";
import { asOwner, asSuperuser, freshRpcDb, OWNER, seedBinders } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const GEN = "b0000000-0000-4000-8000-00000000a2c1";
const LINE = "10000000-0000-4000-8000-00000000a2c1";
const SLOT = (n: number) => `20000000-0000-4000-8000-0000000a2c0${n}`;
const COPY = (n: number) => `c0000000-0000-4000-8000-0000000a2c0${n}`;

let db: PGlite;
afterEach(async () => {
  if (db && !db.closed) await db.close();
});
async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  await asSuperuser(db);
  return (await db.query<T>(sql, params)).rows;
}
const decide = async (choice: Parameters<typeof applyStageDecisions>[1]) => {
  await asOwner(db);
  return applyStageDecisions(pgliteClient(db), choice);
};
const slot = (n: number) =>
  q<{ state: string; stage_choice: string | null; target: string | null }>(
    `select state, stage_choice, target_catalog_card_id as target from line_slot where id = $1`,
    [SLOT(n)],
  ).then((r) => r[0]);
const status = () =>
  q<{ status: string }>(`select status from evolution_line where id = $1`, [LINE]).then(
    (r) => r[0].status,
  );

beforeEach(async () => {
  db = await freshRpcDb();
  await seedBinders(db, [{ id: GEN, type: "general", name: "KB-001" }]);
  await q(
    `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from, card_class) values
       ('emberling', 'Emberling', '{9301}', '{Fire}', 'Basic', null, 'standard'),
       ('emberdrake', 'Emberdrake', '{9302}', '{Fire}', 'Stage1', 'Emberling', 'standard'),
       ('emberlord', 'Emberlord', '{9303}', '{Fire}', 'Stage2', 'Emberdrake', 'standard')`,
  );
});

/** Her line: the Basic filled, the Stage 1 and Stage 2 open and not decided. */
async function openLine() {
  await q(
    `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
       values ($1, $2, 9301, 'red', $3, 'back', 'open')`,
    [LINE, OWNER, GEN],
  );
  await q(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
       values ($1, $2, 'emberling', 'shelved', $3, 'back', 'red')`,
    [COPY(1), OWNER, GEN],
  );
  await q(
    `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id) values
       ($1, $4, $5, 0, 'Basic', 'filled', $6), ($2, $4, $5, 1, 'Stage1', 'placeholder', null),
       ($3, $4, $5, 2, 'Stage2', 'placeholder', null)`,
    [SLOT(0), SLOT(1), SLOT(2), OWNER, LINE, COPY(1)],
  );
  await q(`update copy set line_slot_id = $1 where id = $2`, [SLOT(0), COPY(1)]);
}

describe("Choose · she decides a stage that was not decided", () => {
  beforeEach(openLine);

  it("a chase is her wishlist add; the line stays open while she chases", async () => {
    await decide({ lineId: LINE, stages: { 2: { kind: "chase", catalogCardId: "emberlord" } } });
    expect(await slot(2)).toEqual({
      state: "placeholder",
      stage_choice: "chase",
      target: "emberlord",
    });
    expect(await q(`select count(*)::int n from wishlist_item where resolved_at is null`)).toEqual([
      { n: 1 },
    ]);
    expect(await status()).toBe("open");
  });

  it("every open stage left empty or given a filler: the line reads closed", async () => {
    await decide({
      lineId: LINE,
      stages: { 1: { kind: "empty" }, 2: { kind: "filler", filler: { material: "energy" } } },
    });
    expect(await status()).toBe("closed");
    expect(await q(`select line_slot_id from binder_block`)).toEqual([{ line_slot_id: SLOT(2) }]);
  });

  it("a stage that holds a card is refused, and nothing is written", async () => {
    await expect(decide({ lineId: LINE, stages: { 0: { kind: "empty" } } })).rejects.toThrow(
      DECIDE_REFUSAL.filled,
    );
    expect(await slot(0)).toMatchObject({ state: "filled" });
  });

  it("a stage with no choice given is not touched: only what she decides is written", async () => {
    await decide({ lineId: LINE, stages: { 1: { kind: "empty" } } });
    expect(await slot(2)).toEqual({ state: "placeholder", stage_choice: null, target: null });
    expect(await status()).toBe("open");
  });
});

describe("Change · she changes her mind, and what the stage had comes out", () => {
  beforeEach(openLine);

  it("a chase changed to empty closes its wish", async () => {
    await decide({ lineId: LINE, stages: { 2: { kind: "chase", catalogCardId: "emberlord" } } });
    await decide({ lineId: LINE, stages: { 2: { kind: "empty" } } });
    expect(await slot(2)).toEqual({ state: "placeholder", stage_choice: "empty", target: null });
    expect(await q(`select count(*)::int n from wishlist_item where resolved_at is null`)).toEqual([
      { n: 0 },
    ]);
  });

  it("a spare card filler changed to 'Decide later': the block comes out, the card back to bulk, the stage not decided", async () => {
    await q(
      `insert into copy (id, owner_id, catalog_card_id, role) values ($1, $2, 'emberling', 'bulk')`,
      [COPY(2), OWNER],
    );
    await decide({
      lineId: LINE,
      stages: { 1: { kind: "filler", filler: { material: "card", copyId: COPY(2) } } },
    });
    expect(await q(`select role from copy where id = $1`, [COPY(2)])).toEqual([{ role: "block" }]);
    await decide({ lineId: LINE, stages: { 1: { kind: "later" } } });
    expect(await slot(1)).toEqual({ state: "placeholder", stage_choice: null, target: null });
    expect(await q(`select count(*)::int n from binder_block`)).toEqual([{ n: 0 }]);
    expect(await q(`select role, binder_id from copy where id = $1`, [COPY(2)])).toEqual([
      { role: "bulk", binder_id: null },
    ]);
    expect(await status()).toBe("open");
  });

  it("a chase taken back ('Decide later') closes its wish and forgets its card", async () => {
    await decide({ lineId: LINE, stages: { 2: { kind: "chase", catalogCardId: "emberlord" } } });
    await decide({ lineId: LINE, stages: { 2: { kind: "later" } } });
    expect(await slot(2)).toEqual({ state: "placeholder", stage_choice: null, target: null });
    expect(await q(`select count(*)::int n from wishlist_item where resolved_at is null`)).toEqual([
      { n: 0 },
    ]);
  });

  it("a CLOSED line she now chases a stage on reads open again", async () => {
    await decide({ lineId: LINE, stages: { 1: { kind: "empty" }, 2: { kind: "empty" } } });
    expect(await status()).toBe("closed");
    await decide({ lineId: LINE, stages: { 2: { kind: "chase", catalogCardId: "emberlord" } } });
    expect(await status()).toBe("open");
  });
});

describe("the third pocket of a complete two-card line (Testing's two lines)", () => {
  beforeEach(async () => {
    await q(`delete from catalog_card where tcgdex_id = 'emberlord'`);
    await q(
      `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
         values ($1, $2, 9301, 'red', $3, 'back', 'closed')`,
      [LINE, OWNER, GEN],
    );
    for (const [n, card] of [
      [1, "emberling"],
      [2, "emberdrake"],
    ] as const) {
      await q(
        `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
           values ($1, $2, $3, 'shelved', $4, 'back', 'red')`,
        [COPY(n), OWNER, card, GEN],
      );
      await q(
        `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
           values ($1, $2, $3, $4, $5, 'filled', $6)`,
        [SLOT(n - 1), OWNER, LINE, n - 1, n === 1 ? "Basic" : "Stage1", COPY(n)],
      );
      await q(`update copy set line_slot_id = $1 where id = $2`, [SLOT(n - 1), COPY(n)]);
    }
    await q(
      `insert into copy (id, owner_id, catalog_card_id, role) values ($1, $2, 'emberling', 'bulk')`,
      [COPY(3), OWNER],
    );
  });

  it("she chooses it; she changes it (the old filler comes out); she can decide it later again", async () => {
    await decide({ lineId: LINE, stages: {}, thirdPocket: { material: "energy" } });
    expect(await q(`select extra_pocket from evolution_line`)).toEqual([
      { extra_pocket: "energy" },
    ]);
    await decide({ lineId: LINE, stages: {}, thirdPocket: { material: "card", copyId: COPY(3) } });
    expect(await q(`select extra_pocket from evolution_line`)).toEqual([{ extra_pocket: "card" }]);
    expect(await q(`select material, copy_id from binder_block`)).toEqual([
      { material: "repurposedDuplicate", copy_id: COPY(3) },
    ]);
    await decide({ lineId: LINE, stages: {}, thirdPocket: { material: "later" } });
    expect(await q(`select extra_pocket from evolution_line`)).toEqual([{ extra_pocket: null }]);
    expect(await q(`select count(*)::int n from binder_block`)).toEqual([{ n: 0 }]);
    expect(await q(`select role from copy where id = $1`, [COPY(3)])).toEqual([{ role: "bulk" }]);
  });
});

describe("Lines shows an open stage's card only when she chases it (never an engine's pick)", () => {
  beforeEach(openLine);

  it("an undecided stage with a stored target shows no card; a chased one shows its card", async () => {
    await q(`update line_slot set target_catalog_card_id = 'emberdrake' where id = $1`, [SLOT(1)]);
    await decide({ lineId: LINE, stages: { 2: { kind: "chase", catalogCardId: "emberlord" } } });
    await asOwner(db);
    const data = await loadLineScreen(pgliteClient(db));
    const line = data.lines.find((l) => l.lineId === LINE)!;
    expect(line.slots[1]).toMatchObject({ stageChoice: null, card: null, alternates: [] });
    expect(line.slots[2]).toMatchObject({
      stageChoice: "chase",
      card: expect.objectContaining({ tcgdexId: "emberlord" }),
    });
    expect(line.speciesLabel).toBe("EMBERLING LINE");
  });
});
