/**
 * UIL-120 — the Haul Plan's commit says when the line her confirm concerned is DONE, so the step-through stops there.
 * Karvi: "Once the line is complete, it should not open the popup again for the next card automatically."
 *
 * DONE (the Senior BA's definition, which QA gates on): after the write, the concerned line has NO placeholder slot;
 * every slot is filled or a block. A capped line is not done while its specialty stage is a placeholder, and is
 * done once that is filled. #402 stopped only when a confirm turned the status to `complete`, and she tested past it:
 * a Keep or a Swap on a line that was already complete changes no status, and a line with a block stage never reads
 * `complete` at all.
 *
 * Real cascade, real commit, the one line builder, the REAL `apply_write_ops` on PGlite, as the owner; the real
 * `shelveCardAction`; and `lineDoneFor` itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  clearCatalogCache,
  commitCardPlacement,
  deriveSpotlightPlacement,
  type DraftItem,
} from "@/lib/plan";
import { lineDoneFor } from "@/lib/plan/line-done";
import {
  CHARIZARD_BASE1_4,
  CHARMANDER_SV03_026,
  CHARMELEON_SV03_027,
  CHARMELEON_SV035_005,
  FLYGON_XY5_110,
  TRAPINCH_XY5_82,
  VIBRAVA_XY5_109,
} from "../engine/fixtures";
import {
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
import { shelveCardAction } from "@/app/(ui)/plan/actions";

// The action's owner seam needs a real request; hand it the PGlite client instead (tests/settings/save-binder-guard).
vi.mock("@/lib/plan/session", () => ({
  getOwnerContext: async () => ({ db: pgliteClient(db), ownerId: OWNER }),
}));

const KB1 = "1c000000-0000-0000-0000-0000000000b1";
const LINE = "10000000-0000-0000-0000-0000000000c1";
const S0 = "50000000-0000-0000-0000-0000000000c0";
const S1 = "50000000-0000-0000-0000-0000000000c1";
const S2 = "50000000-0000-0000-0000-0000000000c2";
const OWNED_CMD = "c0000000-0000-0000-0000-0000000000c0";
const OWNED_CML = "c0000000-0000-0000-0000-0000000000c1";
const CML: DraftItem = haulRow(
  "d0000000-0000-4000-8000-0000000000c1",
  CHARMELEON_SV03_027.tcgdexId,
);
const CML_ALT: DraftItem = haulRow(
  "d0000000-0000-4000-8000-0000000000c2",
  CHARMELEON_SV035_005.tcgdexId,
);
const CML_HOLO: DraftItem = haulRow(
  "d0000000-0000-4000-8000-0000000000c3",
  CHARMELEON_SV03_027.tcgdexId,
  "holo",
);
const CZD: DraftItem = haulRow("d0000000-0000-4000-8000-0000000000c4", CHARIZARD_BASE1_4.tcgdexId);

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedCatalogCardsFull(db, [
    CHARMANDER_SV03_026,
    CHARMELEON_SV03_027,
    CHARMELEON_SV035_005,
    CHARIZARD_BASE1_4,
    TRAPINCH_XY5_82,
    VIBRAVA_XY5_109,
    FLYGON_XY5_110,
  ]);
  await seedBinders(db, [{ id: KB1, type: "general", name: "KB-001" }]);
  clearCatalogCache();
});
afterEach(async () => {
  await db.close();
});

const commit = (input: Parameters<typeof commitCardPlacement>[1]) =>
  commitCardPlacement(pgliteClient(db), input);
const proposalFor = async (card: DraftItem) =>
  (await deriveSpotlightPlacement(pgliteClient(db), card))?.item.lineProposal ?? null;
async function statusOf(lineId: string) {
  await asSuperuser(db);
  const r = await db.query<{ status: string }>(`select status from evolution_line where id = $1`, [
    lineId,
  ]);
  await asOwner(db);
  return r.rows[0]?.status;
}

/**
 * Her Charmander line in KB-001 · Back · Red: Basic filled; then each later stage open (null), or filled by her
 * normal Charmeleon ("cml"). `stage2` adds a Charizard stage.
 */
async function seedLine(opts: {
  stage1: "open" | "cml";
  stage2?: "open";
  status?: "open" | "complete" | "capped";
}) {
  const status = opts.status ?? (opts.stage1 === "cml" && !opts.stage2 ? "complete" : "open");
  await db.exec(`
    insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band) values
      ('${OWNED_CMD}', '${OWNER}', '${CHARMANDER_SV03_026.tcgdexId}', 'normal', 'shelved', '${KB1}', 'back', 'red');
    insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
      values ('${LINE}', '${OWNER}', 4, 'red', '${KB1}', 'back', '${status}');
    insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id, target_catalog_card_id) values
      ('${S0}', '${OWNER}', '${LINE}', 0, 'Basic', 'filled', '${OWNED_CMD}', null),
      ('${S1}', '${OWNER}', '${LINE}', 1, 'Stage1', 'placeholder', null, '${CHARMELEON_SV03_027.tcgdexId}');
    update copy set line_slot_id = '${S0}' where id = '${OWNED_CMD}';
  `);
  if (opts.stage2) {
    await db.exec(`
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id, target_catalog_card_id)
        values ('${S2}', '${OWNER}', '${LINE}', 2, 'Stage2', 'placeholder', null, '${CHARIZARD_BASE1_4.tcgdexId}');
    `);
  }
  if (opts.stage1 === "cml") {
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band, line_slot_id)
        values ('${OWNED_CML}', '${OWNER}', '${CHARMELEON_SV03_027.tcgdexId}', 'normal', 'shelved',
                '${KB1}', 'back', 'red', '${S1}');
      update line_slot set state = 'filled', copy_id = '${OWNED_CML}' where id = '${S1}';
    `);
  }
}

describe("lineDoneFor, the one rule", () => {
  it("done when no slot is a placeholder: filled and block slots both count", () => {
    expect(lineDoneFor(["filled", "filled"])).toBe(true);
    expect(lineDoneFor(["block", "filled", "filled"])).toBe(true);
    expect(lineDoneFor(["filled", "placeholder"])).toBe(false);
    expect(lineDoneFor([])).toBe(false);
  });
});

describe("UIL-120 (a) · a join or a start that leaves the line done", () => {
  it("joining a line's last open slot", async () => {
    await seedLine({ stage1: "open" });
    await seedHaulRows(db, [CML]);
    await asOwner(db);
    const res = await commit({ card: CML, lineChoice: { mode: "join", lineId: LINE, slotId: S1 } });
    expect(res.lineDone).toBe(true);
  });

  it("a start whose every stage fills, with her pull ticked", async () => {
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band) values
        ('${OWNED_CMD}', '${OWNER}', '${CHARMANDER_SV03_026.tcgdexId}', 'normal', 'shelved', '${KB1}', 'front', 'red');
    `);
    await seedHaulRows(db, [CML, CZD]);
    await asOwner(db);
    // Charmeleon starts the line; Charizard, the last open stage, then joins it.
    const start = await proposalFor(CML);
    if (start?.kind !== "start") throw new Error(`expected a start, got ${start?.kind}`);
    const first = await commit({
      card: CML,
      lineChoice: { mode: "start", binderId: KB1, band: "red", pulls: [OWNED_CMD] },
    });
    expect(first.lineDone).toBe(false); // the Charizard stage is still open: it steps on
    const add = await proposalFor(CZD);
    if (add?.kind !== "add") throw new Error(`expected an add, got ${add?.kind}`);
    const last = await commit({
      card: CZD,
      lineChoice: { mode: "join", lineId: add.lineId, slotId: add.slotId },
    });
    expect(last.lineDone).toBe(true);
  });

  it("a START that leaves the line done in that one confirm (her ticked pull fills the only other stage)", async () => {
    // A 2-stage family here: without the Charizard printing, the Charmander chain ends at Charmeleon (QA on #410).
    await asSuperuser(db);
    await db.query(`delete from catalog_card where tcgdex_id = $1`, [CHARIZARD_BASE1_4.tcgdexId]);
    clearCatalogCache();
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band) values
        ('${OWNED_CMD}', '${OWNER}', '${CHARMANDER_SV03_026.tcgdexId}', 'normal', 'shelved', '${KB1}', 'front', 'red');
    `);
    await seedHaulRows(db, [CML]);
    await asOwner(db);
    const start = await proposalFor(CML);
    if (start?.kind !== "start") throw new Error(`expected a start, got ${start?.kind}`);
    const res = await commit({
      card: CML,
      lineChoice: { mode: "start", binderId: KB1, band: "red", pulls: [OWNED_CMD] },
    });
    expect(res.lineDone).toBe(true);
  });

  it("the Haul Plan's action hands the answer to the screen", async () => {
    await seedLine({ stage1: "open" });
    await seedHaulRows(db, [CML]);
    await asOwner(db);
    const res = await shelveCardAction({
      card: { id: CML.id, tcgdexId: CML.tcgdexId, variant: CML.variant, existingCopyId: CML.id },
      lineChoice: { mode: "join", lineId: LINE, slotId: S1 },
    });
    expect(res).toMatchObject({ ok: true, lineDone: true });
  });
});

describe("UIL-120 (b)(c) · on a line that was ALREADY complete", () => {
  beforeEach(async () => {
    await seedLine({ stage1: "cml" });
    await seedHaulRows(db, [CML_ALT, CML_HOLO]);
    await asOwner(db);
  });

  it("(b) a Keep writes no line, and still stops: that line is done", async () => {
    // PRE-FIX (#402): false, so the next popup opened. An upgrade's Keep: since UIL-126 it is the only Keep there is
    // (a plain extra copy is no line card), and a kept upgrade names where it goes.
    const res = await commit({
      card: CML_HOLO,
      lineChoice: {
        mode: "replace",
        lineId: LINE,
        slotId: S1,
        keep: true,
        incoming: { kind: "bulk" },
      },
    });
    expect(res.lineDone).toBe(true);
    expect(await statusOf(LINE)).toBe("complete");
  });

  it("(c) a Swap changes no status, and still stops", async () => {
    // PRE-FIX (#402): false.
    const res = await commit({
      card: CML_HOLO,
      lineChoice: {
        mode: "replace",
        lineId: LINE,
        slotId: S1,
        keep: false,
        outgoing: { kind: "bulk" },
      },
    });
    expect(res.lineDone).toBe(true);
  });
});

describe("UIL-120 (d) · a line whose only unfilled stage is a block", () => {
  it("reads done once every other stage is in (the Flygon line: Trapinch has no Olive printing)", async () => {
    const vib = haulRow("d0000000-0000-4000-8000-0000000000d1", VIBRAVA_XY5_109.tcgdexId);
    const fly = haulRow("d0000000-0000-4000-8000-0000000000d2", FLYGON_XY5_110.tcgdexId);
    await seedHaulRows(db, [vib, fly]);
    await asOwner(db);
    const start = await proposalFor(vib);
    if (start?.kind !== "start") throw new Error(`expected a start, got ${start?.kind}`);
    const first = await commit({
      card: vib,
      lineChoice: { mode: "start", binderId: KB1, band: start.band, pulls: [] },
    });
    expect(first.lineDone).toBe(false); // [block, filled, placeholder]: the Flygon stage is open
    clearCatalogCache();
    const add = await proposalFor(fly);
    if (add?.kind !== "add") throw new Error(`expected an add, got ${add?.kind}`);
    const last = await commit({
      card: fly,
      lineChoice: { mode: "join", lineId: add.lineId, slotId: add.slotId },
    });
    // PRE-FIX (#402): false, because the status stays `open` with a block slot.
    expect(last.lineDone).toBe(true);
    expect(await statusOf(add.lineId)).toBe("open");
  });
});

describe("UIL-120 (e)(f) · it keeps stepping while a stage is still open", () => {
  it("(e) a capped line with its specialty stage still open keeps stepping", async () => {
    await seedLine({ stage1: "open", stage2: "open", status: "capped" });
    await seedHaulRows(db, [CML]);
    await asOwner(db);
    const res = await commit({ card: CML, lineChoice: { mode: "join", lineId: LINE, slotId: S1 } });
    expect(res.lineDone).toBe(false);
  });

  it("(f) an open placeholder left behind keeps stepping", async () => {
    await seedLine({ stage1: "open", stage2: "open" });
    await seedHaulRows(db, [CML]);
    await asOwner(db);
    const res = await commit({ card: CML, lineChoice: { mode: "join", lineId: LINE, slotId: S1 } });
    expect(res.lineDone).toBe(false);
  });

  it("(f) a pull that demotes ANOTHER line does not count: only the line she confirmed is asked", async () => {
    // Her complete Charmander line (Basic + Stage 1, no Charizard stage). A Charizard starts a NEW line that pulls
    // her Charmander out of it but leaves her Charmeleon where it is, so the new line's Stage 1 is still open.
    await seedLine({ stage1: "cml" });
    await seedHaulRows(db, [CZD]);
    await asOwner(db);
    const start = await proposalFor(CZD);
    if (start?.kind !== "start") throw new Error(`expected a start, got ${start?.kind}`);
    const res = await commit({
      card: CZD,
      lineChoice: { mode: "start", binderId: KB1, band: "red", pulls: [OWNED_CMD] },
    });
    expect(await statusOf(LINE)).toBe("open"); // the other line was demoted
    expect(res.lineDone).toBe(false);
  });

  it("a card she moved instead concerns no line", async () => {
    await seedLine({ stage1: "open" });
    await seedHaulRows(db, [CML]);
    await asOwner(db);
    const res = await commit({
      card: CML,
      override: { kind: "shelf", binderId: KB1, half: "front", band: "red" },
    });
    expect(res.lineDone).toBe(false);
  });
});
