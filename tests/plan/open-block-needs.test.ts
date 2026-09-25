/**
 * UIL-030 — `openBlockNeeds` finally has a writer. Definition (Senior BA, 2026-09-19): an open binder-block
 * need is a line_slot in state 'block' with no line-terminated binder_block backing it. The engine creates
 * block slots on the Haul Plan (a stage that can never be filled); only Backfill ever wrote the
 * binder_block row that physically fills that pocket run, so every Plan-created block slot was an open
 * need nobody counted — and "Offered as a repurposed binder block." never rendered once.
 *
 * Real PGlite: the count and the candidates come out of `loadPlanContext`, and the cascade's offer flag
 * follows the count. Then the writes: a block destination through the Haul Plan override path and through
 * `applyMove` both make the copy a role-'block' card in the line's binder back half and write the
 * binder_block row, which closes the need; a second block on the same line is refused.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { loadPlanContext, planFromDraft } from "@/lib/plan";
import { buildHaulCommitPayload } from "@/lib/plan/commit";
import { applyMove } from "@/lib/line/write";
import { moveNameLookups } from "@/lib/line/move";
import {
  applyOps,
  asOwner,
  asSuperuser,
  freshRpcDb,
  OWNER,
  haulRow,
  seedBinders,
  seedHaulRows,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const B1 = "1c000000-0000-0000-0000-0000000000b1";
const LINE = "11000000-0000-0000-0000-00000000000a";
const SLOT_BASIC = "51000000-0000-0000-0000-000000000001";
const SLOT_BLOCK = "51000000-0000-0000-0000-000000000002";
const OWNED = "c0000000-0000-0000-0000-0000000000c1";

let db: PGlite;
const q = async <T>(sql: string) => (await db.query<T>(sql)).rows;

/** A Charmander line in Binder 1 whose Stage2 slot is a BLOCK the engine decided on, never backfilled. */
async function seedLineWithOpenBlock() {
  await seedBinders(db, [{ id: B1, type: "general", name: "Binder 1" }]);
  await db.exec(`
    insert into catalog_card (tcgdex_id, name, dex_id, set_id, set_name, local_id, types, stage) values
      ('sv03-026', 'Charmander', '{4}', 'sv03', 'Obsidian Flames', '026', '{Fire}', 'Basic'),
      ('sv03-027', 'Charmeleon', '{5}', 'sv03', 'Obsidian Flames', '027', '{Fire}', 'Stage1');
    insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
      values ('${LINE}', '${OWNER}', 4, 'red', '${B1}', 'back', 'open');
    insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band)
      values ('${OWNED}', '${OWNER}', 'sv03-026', 'normal', 'shelved', '${B1}', 'back', 'red');
    insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id, note) values
      ('${SLOT_BASIC}', '${OWNER}', '${LINE}', 0, 'Basic', 'filled', '${OWNED}', null),
      ('${SLOT_BLOCK}', '${OWNER}', '${LINE}', 2, 'Stage2', 'block', null, null);
    update copy set line_slot_id = '${SLOT_BASIC}' where id = '${OWNED}';
  `);
}

beforeEach(async () => {
  db = await freshRpcDb();
  await seedLineWithOpenBlock();
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

describe("UIL-030 · the count and the candidates", () => {
  it("one block slot with no binder_block → openBlockNeeds 1, one candidate naming line, slot, binder, species, stage", async () => {
    const pc = await loadPlanContext(pgliteClient(db));
    expect(pc.ctx.openBlockNeeds).toBe(1);
    expect(pc.blockNeeds).toEqual([
      {
        lineId: LINE,
        slotId: SLOT_BLOCK,
        binderId: B1,
        binderName: "Binder 1",
        speciesLabel: "CHARMANDER LINE",
        stage: "Stage2",
        bandKey: "red",
      },
    ]);
  });

  it("a line-terminated binder_block on that line closes the need → 0, no candidates", async () => {
    await asSuperuser(db);
    await db.exec(`
      insert into binder_block (owner_id, binder_id, half, pocket_count, purpose, material, line_id)
        values ('${OWNER}', '${B1}', 'back', 1, 'line-terminated', 'basicEnergy', '${LINE}');
    `);
    await asOwner(db);
    const pc = await loadPlanContext(pgliteClient(db));
    expect(pc.ctx.openBlockNeeds).toBe(0);
    expect(pc.blockNeeds).toEqual([]);
  });

  it("the cascade offers a bulk-bound duplicate as a block exactly when a need is open", async () => {
    const draft = [{ id: "d1", tcgdexId: "sv03-026", variant: "normal" as const }];
    const withNeed = planFromDraft(await loadPlanContext(pgliteClient(db)), draft);
    expect(withNeed.items[0]).toMatchObject({ action: "BULK", offerBlockRepurpose: true });
    // The FLAG is PR A's contract; the offer's text and action arrive together in PR B (the plan item's
    // reason is `describeReason`'s prose, not the engine's, and stays unchanged here on purpose).

    await asSuperuser(db);
    await db.exec(`
      insert into binder_block (owner_id, binder_id, half, pocket_count, purpose, material, line_id)
        values ('${OWNER}', '${B1}', 'back', 1, 'line-terminated', 'basicEnergy', '${LINE}');
    `);
    await asOwner(db);
    const noNeed = planFromDraft(await loadPlanContext(pgliteClient(db)), draft);
    expect(noNeed.items[0]).toMatchObject({ action: "BULK", offerBlockRepurpose: false });
  });
});

describe("UIL-030 · the Haul Plan override writes the block", () => {
  /** A second Charmander, waiting in her haul (UIL-098 part 2): the duplicate she repurposes. */
  const DUP = haulRow("d0000000-0000-4000-8000-0000000000c9", "sv03-026");
  beforeEach(async () => {
    await asSuperuser(db);
    await seedHaulRows(db, [DUP]);
    await asOwner(db);
  });
  const contextPlacing = () => loadPlanContext(pgliteClient(db), { excludeOwnedCopyIds: [DUP.id] });

  it("copy role 'block' in the line's binder back half + binder_block row (line-terminated, repurposedDuplicate, copy, line) + slot note", async () => {
    const pc = await contextPlacing();
    const draft = [DUP];
    const { planned } = planFromDraft(pc, draft);
    const { payload } = buildHaulCommitPayload(pc, planned, {
      draft,
      overrides: { [DUP.id]: { kind: "block", lineId: LINE, slotId: SLOT_BLOCK, binderId: B1 } },
    });
    await applyOps(db, payload);
    await asSuperuser(db);
    const [copy] = await q<{
      role: string;
      binder_id: string;
      binder_half: string;
      color_band: string | null;
    }>(`select role, binder_id, binder_half, color_band from copy where id = '${DUP.id}'`);
    expect(copy).toEqual({ role: "block", binder_id: B1, binder_half: "back", color_band: null });
    const [block] = await q<Record<string, unknown>>(
      `select purpose, material, line_id, binder_id, half, pocket_count, (copy_id is not null) as has_copy from binder_block`,
    );
    expect(block).toEqual({
      purpose: "line-terminated",
      material: "repurposedDuplicate",
      line_id: LINE,
      binder_id: B1,
      half: "back",
      pocket_count: 1,
      has_copy: true,
    });
    expect(await q(`select note, state from line_slot where id = '${SLOT_BLOCK}'`)).toEqual([
      { note: "repurposed duplicate block", state: "block" },
    ]);
    // And the need is now closed for the next plan run.
    await asOwner(db);
    expect((await loadPlanContext(pgliteClient(db))).ctx.openBlockNeeds).toBe(0);
  });

  it("refuses a block override whose need is already filled", async () => {
    const pc = await contextPlacing();
    const draft = [DUP];
    const { planned } = planFromDraft(pc, draft);
    const stale = { ...pc, blockNeeds: [] }; // the snapshot says: nothing open any more
    expect(() =>
      buildHaulCommitPayload(stale, planned, {
        draft,
        overrides: { [DUP.id]: { kind: "block", lineId: LINE, slotId: SLOT_BLOCK, binderId: B1 } },
      }),
    ).toThrow(/already filled/);
  });
});

describe("UIL-030 · applyMove writes the same block from the Lines / Lookup surfaces", () => {
  const BULK_COPY = "c0000000-0000-0000-0000-0000000000c2";
  const names = moveNameLookups({
    binders: [{ id: B1, name: "Binder 1", type: "general" }],
    collectionsByBinder: {},
    bands: [{ key: "red", display: "Red" }],
  });

  beforeEach(async () => {
    await asSuperuser(db);
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, variant, role)
        values ('${BULK_COPY}', '${OWNER}', 'sv03-027', 'normal', 'bulk');
    `);
    await asOwner(db);
  });

  it("a bulk duplicate becomes the line's binder block, one transaction, and the need closes", async () => {
    const res = await applyMove(
      pgliteClient(db),
      {
        copyId: BULK_COPY,
        destination: { kind: "block", lineId: LINE, slotId: SLOT_BLOCK, binderId: B1 },
      },
      names,
    );
    expect(res.destinationLabel).toBe("Binder 1 · Back · Binder block");
    await asSuperuser(db);
    expect(await q(`select role, binder_half from copy where id = '${BULK_COPY}'`)).toEqual([
      { role: "block", binder_half: "back" },
    ]);
    expect(await q(`select material, copy_id from binder_block`)).toEqual([
      { material: "repurposedDuplicate", copy_id: BULK_COPY },
    ]);
    expect(await q(`select reason from placement_decision`)).toMatchObject([
      { reason: expect.stringContaining("repurposed binder block") },
    ]);
    await asOwner(db);
    expect((await loadPlanContext(pgliteClient(db))).ctx.openBlockNeeds).toBe(0);
  });

  it("refuses a second block on the same line, and a slot that is not a block slot", async () => {
    await applyMove(
      pgliteClient(db),
      {
        copyId: BULK_COPY,
        destination: { kind: "block", lineId: LINE, slotId: SLOT_BLOCK, binderId: B1 },
      },
      names,
    );
    await expect(
      applyMove(
        pgliteClient(db),
        {
          copyId: OWNED,
          destination: { kind: "block", lineId: LINE, slotId: SLOT_BLOCK, binderId: B1 },
        },
        names,
      ),
    ).rejects.toThrow(/already filled/);
    await expect(
      applyMove(
        pgliteClient(db),
        {
          copyId: OWNED,
          destination: { kind: "block", lineId: LINE, slotId: SLOT_BASIC, binderId: B1 },
        },
        names,
      ),
    ).rejects.toThrow(/block slot no longer exists/);
  });
});
