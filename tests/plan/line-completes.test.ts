/**
 * UIL-120 — the Haul Plan's commit says when her confirm COMPLETED a line, so the step-through can stop there.
 * Karvi: "Once the line is complete, it should not open the popup again for the next card automatically."
 *
 * The answer is read off the write the server built from fresh state (a line inserted as `complete`, or one set to
 * `complete`), never from the browser. Real cascade, real commit, the one line builder, the REAL `apply_write_ops`
 * on PGlite, as the owner; and `completesALine` over hand-built ops.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { clearCatalogCache, commitCardPlacement, completesALine, type DraftItem } from "@/lib/plan";
import { CHARMANDER_SV03_026, CHARMELEON_SV03_027 } from "../engine/fixtures";
import {
  asOwner,
  freshRpcDb,
  haulRow,
  OWNER,
  seedBinders,
  seedCatalogCardsFull,
  seedHaulRows,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";
import { shelveCardAction } from "@/app/(ui)/plan/actions";

// The action's owner seam needs a real request; hand it the PGlite client instead (tests/settings/save-binder-guard).
vi.mock("@/lib/plan/session", () => ({
  getOwnerContext: async () => ({ db: pgliteClient(db), ownerId: OWNER }),
}));

const KB1 = "1c000000-0000-0000-0000-0000000000b1";
const LINE = "10000000-0000-0000-0000-0000000000c1";
const S_BASIC = "50000000-0000-0000-0000-0000000000c0";
const S_STAGE1 = "50000000-0000-0000-0000-0000000000c1";
const OWNED_CMD = "c0000000-0000-0000-0000-0000000000c0";
const CML: DraftItem = haulRow(
  "d0000000-0000-4000-8000-0000000000c1",
  CHARMELEON_SV03_027.tcgdexId,
);

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedCatalogCardsFull(db, [CHARMANDER_SV03_026, CHARMELEON_SV03_027]);
  await seedBinders(db, [{ id: KB1, type: "general", name: "KB-001" }]);
  clearCatalogCache();
});
afterEach(async () => {
  await db.close();
});

const commit = (input: Parameters<typeof commitCardPlacement>[1]) =>
  commitCardPlacement(pgliteClient(db), input);

describe("UIL-120 · the commit says when her confirm completed a line", () => {
  async function seedOpenLine() {
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band) values
        ('${OWNED_CMD}', '${OWNER}', '${CHARMANDER_SV03_026.tcgdexId}', 'normal', 'shelved', '${KB1}', 'back', 'red');
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
        values ('${LINE}', '${OWNER}', 4, 'red', '${KB1}', 'back', 'open');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id, target_catalog_card_id) values
        ('${S_BASIC}', '${OWNER}', '${LINE}', 0, 'Basic', 'filled', '${OWNED_CMD}', null),
        ('${S_STAGE1}', '${OWNER}', '${LINE}', 1, 'Stage1', 'placeholder', null, '${CHARMELEON_SV03_027.tcgdexId}');
      update copy set line_slot_id = '${S_BASIC}' where id = '${OWNED_CMD}';
    `);
    await seedHaulRows(db, [CML]);
    await asOwner(db);
  }

  it("joining a line's LAST open slot completes it", async () => {
    await seedOpenLine();
    const res = await commit({
      card: CML,
      lineChoice: { mode: "join", lineId: LINE, slotId: S_STAGE1 },
    });
    expect(res.completedLine).toBe(true);
  });

  it("the Haul Plan's action hands that answer to the screen", async () => {
    await seedOpenLine();
    const res = await shelveCardAction({
      card: {
        id: CML.id,
        tcgdexId: CML.tcgdexId,
        variant: CML.variant,
        existingCopyId: CML.id,
      },
      lineChoice: { mode: "join", lineId: LINE, slotId: S_STAGE1 },
    });
    expect(res).toMatchObject({ ok: true, completedLine: true });
  });

  describe("starting a line", () => {
    beforeEach(async () => {
      // Her Charmander in the front half, which the new line could pull.
      await db.exec(`
        insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band) values
          ('${OWNED_CMD}', '${OWNER}', '${CHARMANDER_SV03_026.tcgdexId}', 'normal', 'shelved', '${KB1}', 'front', 'red');
      `);
      await seedHaulRows(db, [CML]);
      await asOwner(db);
    });

    it("with an open stage left, does not complete it", async () => {
      const res = await commit({
        card: CML,
        lineChoice: { mode: "start", binderId: KB1, band: "red", pulls: [] },
      });
      expect(res.completedLine).toBe(false);
    });

    it("with every stage filled (her pull ticked), completes it", async () => {
      const res = await commit({
        card: CML,
        lineChoice: { mode: "start", binderId: KB1, band: "red", pulls: [OWNED_CMD] },
      });
      expect(res.completedLine).toBe(true);
    });

    it("a card she moved instead completes nothing", async () => {
      const res = await commit({
        card: CML,
        override: { kind: "shelf", binderId: KB1, half: "front", band: "red" },
      });
      expect(res.completedLine).toBe(false);
    });
  });
});

describe("completesALine", () => {
  it("reads a line inserted complete, or set complete; nothing else", () => {
    const line = {
      op: "insert_line" as const,
      id: "l",
      root_dex_id: 4,
      color_band: "red",
      binder_id: KB1,
      half: "back" as const,
    };
    expect(completesALine([{ ...line, status: "complete" }])).toBe(true);
    expect(completesALine([{ op: "update_line", id: "l", patch: { status: "complete" } }])).toBe(
      true,
    );
    expect(completesALine([{ ...line, status: "open" }])).toBe(false);
    // A pull that leaves another line one short demotes it; that is not a completion.
    expect(completesALine([{ op: "update_line", id: "l", patch: { status: "open" } }])).toBe(false);
    expect(completesALine([])).toBe(false);
  });
});
