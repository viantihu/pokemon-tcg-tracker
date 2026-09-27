/**
 * UIL-117 PR 4 (4a) — on the Haul Plan, every card headed into a line waits for her OK. Karvi: "The user must
 * always authorize all moves." Real cascade, real commit, the Tech Lead's one line builder, through the REAL
 * `apply_write_ops` on PGlite, as the owner.
 *
 * Her Charmander line in KB-001 · Back · Red. Pinned, for each kind of line card:
 *   - ADD (an open slot): refused with no choice; her join fills it, both pointers, as her decision;
 *   - a PLAIN extra copy (a second Charmeleon, other art, for a filled stage): no line card since UIL-126; a Done
 *     files it in the front half, and her "Swap this one into the line…" puts it in the slot;
 *   - the HOLO UPGRADE (a holo over the normal in the slot): no longer automatic; Keep must name where the holo
 *     goes (bulk suggested); Swap is the old automatic result, now her call;
 *   - her Move (an override) still places any line card with no line choice: a card must always be movable.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { CatalogCard } from "@/lib/engine";
import {
  clearCatalogCache,
  commitCardPlacement,
  deriveSpotlightPlacement,
  LINE_CHOICE,
  type DraftItem,
} from "@/lib/plan";
import type { LineChoice } from "@/lib/line/popup";
import { CHARMANDER_SV03_026, CHARMELEON_SV03_027, CHARMELEON_SV035_005 } from "../engine/fixtures";
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

const KB1 = "1c000000-0000-0000-0000-0000000000b1";
const LINE = "10000000-0000-0000-0000-0000000000a1";
const S_BASIC = "50000000-0000-0000-0000-0000000000a0";
const S_STAGE1 = "50000000-0000-0000-0000-0000000000a1";
const OWNED_CMD = "c0000000-0000-0000-0000-0000000000a0";
const OWNED_CML = "c0000000-0000-0000-0000-0000000000a1";

const CATALOG: CatalogCard[] = [CHARMANDER_SV03_026, CHARMELEON_SV03_027, CHARMELEON_SV035_005];
/** A Charmeleon in her haul, for the open Stage 1 slot. */
const CML: DraftItem = haulRow(
  "d0000000-0000-4000-8000-0000000000a1",
  CHARMELEON_SV03_027.tcgdexId,
);
/** A second Charmeleon, other printing and other art, for a filled Stage 1. */
const CML_ALT: DraftItem = haulRow(
  "d0000000-0000-4000-8000-0000000000a2",
  CHARMELEON_SV035_005.tcgdexId,
);
/** The holo of the very Charmeleon already in the slot. */
const CML_HOLO: DraftItem = haulRow(
  "d0000000-0000-4000-8000-0000000000a3",
  CHARMELEON_SV03_027.tcgdexId,
  "holo",
);

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedCatalogCardsFull(db, CATALOG);
  await seedBinders(db, [{ id: KB1, type: "general", name: "KB-001" }]);
  clearCatalogCache();
});
afterEach(async () => {
  await db.close();
});

/** Her Charmander line: Basic filled; Stage 1 open, or filled by her normal Charmeleon. */
async function seedLine(stage1: "open" | "filled"): Promise<void> {
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
  if (stage1 === "filled") {
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band, line_slot_id)
        values ('${OWNED_CML}', '${OWNER}', '${CHARMELEON_SV03_027.tcgdexId}', 'normal', 'shelved',
                '${KB1}', 'back', 'red', '${S_STAGE1}');
      update line_slot set state = 'filled', copy_id = '${OWNED_CML}' where id = '${S_STAGE1}';
      update evolution_line set status = 'complete' where id = '${LINE}';
    `);
  }
}

async function copyRow(id: string) {
  await asSuperuser(db);
  const r = await db.query<{
    role: string;
    binder_half: string | null;
    color_band: string | null;
    line_slot_id: string | null;
  }>(`select role, binder_half, color_band, line_slot_id from copy where id = $1`, [id]);
  await asOwner(db);
  return r.rows[0];
}
async function slot1() {
  await asSuperuser(db);
  const r = await db.query<{ state: string; copy_id: string | null }>(
    `select state, copy_id from line_slot where id = $1`,
    [S_STAGE1],
  );
  await asOwner(db);
  return r.rows[0];
}
async function decisionsFor(copyId: string) {
  await asSuperuser(db);
  const r = await db.query<{
    decision: string;
    resolved_by: string;
    line_id: string | null;
    reason: string;
  }>(
    `select decision, resolved_by, line_id, reason from placement_decision where copy_id = $1 order by created_at`,
    [copyId],
  );
  await asOwner(db);
  return r.rows;
}
const UNPLACED = { role: "haul", binder_half: null, color_band: null, line_slot_id: null };
const commit = (input: Parameters<typeof commitCardPlacement>[1]) =>
  commitCardPlacement(pgliteClient(db), input);
async function proposalFor(card: DraftItem) {
  return (await deriveSpotlightPlacement(pgliteClient(db), card))?.item.lineProposal ?? null;
}

describe("UIL-117 · ADD: a card for an open slot waits for her", () => {
  beforeEach(async () => {
    await seedLine("open");
    await seedHaulRows(db, [CML]);
    await asOwner(db);
  });

  it("proposes the yellow add, naming the slot", async () => {
    expect(await proposalFor(CML)).toEqual({ kind: "add", lineId: LINE, slotId: S_STAGE1 });
  });

  it("is refused with no choice, and nothing is written", async () => {
    // PRE-FIX: the cascade filled the slot on its own.
    await expect(commit({ card: CML })).rejects.toThrow(LINE_CHOICE.missing);
    expect(await copyRow(CML.existingCopyId!)).toEqual(UNPLACED);
    expect(await slot1()).toEqual({ state: "placeholder", copy_id: null });
  });

  it("her join fills the slot, both pointers, and the decision is hers", async () => {
    await commit({ card: CML, lineChoice: { mode: "join", lineId: LINE, slotId: S_STAGE1 } });
    expect(await copyRow(CML.existingCopyId!)).toEqual({
      role: "shelved",
      binder_half: "back",
      color_band: "red",
      line_slot_id: S_STAGE1,
    });
    expect(await slot1()).toEqual({ state: "filled", copy_id: CML.existingCopyId });
    expect(await decisionsFor(CML.existingCopyId!)).toMatchObject([
      { decision: "line-join", resolved_by: "user", line_id: LINE },
    ]);
  });

  it("a Keep sent for it is refused before anything is written (the TL's review: it fell through to the cascade)", async () => {
    await expect(
      commit({
        card: CML,
        lineChoice: { mode: "replace", lineId: LINE, slotId: S_STAGE1, keep: true },
      }),
    ).rejects.toThrow(LINE_CHOICE.missing);
    expect(await copyRow(CML.existingCopyId!)).toEqual(UNPLACED);
    expect(await slot1()).toEqual({ state: "placeholder", copy_id: null });
    expect(await decisionsFor(CML.existingCopyId!)).toEqual([]);
  });

  it("her Move still places it with no line choice (a card must always be movable)", async () => {
    await commit({
      card: CML,
      override: { kind: "shelf", binderId: KB1, half: "front", band: "red" },
    });
    expect(await copyRow(CML.existingCopyId!)).toMatchObject({
      role: "shelved",
      binder_half: "front",
    });
    expect(await slot1()).toEqual({ state: "placeholder", copy_id: null });
  });
});

describe("UIL-126 · a PLAIN extra copy (a second Charmeleon, other art) is no line card", () => {
  beforeEach(async () => {
    await seedLine("filled");
    await seedHaulRows(db, [CML_ALT]);
    await asOwner(db);
  });

  it("has no proposal (no badge), and the spotlight names the line it duplicates", async () => {
    // PRE-FIX (#392): a pink replace, opening on Keep.
    const item = (await deriveSpotlightPlacement(pgliteClient(db), CML_ALT))?.item;
    expect(item?.lineProposal).toBeNull();
    expect(item?.extraCopyOf).toEqual({
      lineId: LINE,
      slotId: S_STAGE1,
      lineName: "Charmeleon",
      where: "KB-001 · Back · Red",
      held: "Charmeleon 027", // the fixture carries no set total, so the number stands alone
    });
  });

  it("a normal Done files it in the front half: no choice asked, nothing in the line moves", async () => {
    // PRE-FIX (#392): refused with no choice.
    await commit({ card: CML_ALT });
    expect(await slot1()).toEqual({ state: "filled", copy_id: OWNED_CML });
    expect(await copyRow(CML_ALT.existingCopyId!)).toMatchObject({
      role: "shelved",
      binder_half: "front",
      color_band: "red",
      line_slot_id: null,
    });
  });

  it.each([
    ["a join", { mode: "join", lineId: LINE, slotId: S_STAGE1 }],
    ["a start", { mode: "start", binderId: KB1, band: "red", pulls: [] }],
    ["a Keep", { mode: "replace", lineId: LINE, slotId: S_STAGE1, keep: true }],
    [
      "a swap into another slot",
      { mode: "replace", lineId: LINE, slotId: S_BASIC, keep: false, outgoing: { kind: "bulk" } },
    ],
  ] as const)(
    "any line choice but her swap into THAT slot is refused, not ignored: %s (TL review)",
    async (_name, lineChoice) => {
      await expect(commit({ card: CML_ALT, lineChoice: lineChoice as LineChoice })).rejects.toThrow(
        LINE_CHOICE.notALineCard,
      );
      expect(await copyRow(CML_ALT.existingCopyId!)).toEqual(UNPLACED);
      expect(await slot1()).toEqual({ state: "filled", copy_id: OWNED_CML });
      expect(await decisionsFor(CML_ALT.existingCopyId!)).toEqual([]);
    },
  );

  it("⇄ Swap this one into the line…: it takes the slot in one write, and the old one goes where she sent it", async () => {
    await commit({
      card: CML_ALT,
      lineChoice: {
        mode: "replace",
        lineId: LINE,
        slotId: S_STAGE1,
        keep: false,
        outgoing: { kind: "bulk" },
      },
    });
    expect(await slot1()).toEqual({ state: "filled", copy_id: CML_ALT.existingCopyId });
    expect(await copyRow(CML_ALT.existingCopyId!)).toMatchObject({
      role: "shelved",
      binder_half: "back",
      line_slot_id: S_STAGE1,
    });
    expect(await copyRow(OWNED_CML)).toMatchObject({ role: "bulk", line_slot_id: null });
    expect((await decisionsFor(CML_ALT.existingCopyId!)).map((d) => d.decision)).toEqual([
      "line-replace",
    ]);
  });
});

describe("UIL-117 · the HOLO UPGRADE is no longer automatic", () => {
  beforeEach(async () => {
    await seedLine("filled");
    await seedHaulRows(db, [CML_HOLO]);
    await asOwner(db);
  });

  it("proposes the pink replace, pre-set to Swap", async () => {
    expect(await proposalFor(CML_HOLO)).toEqual({
      kind: "replace",
      lineId: LINE,
      slotId: S_STAGE1,
      defaultKeep: false,
    });
  });

  it("is refused with no choice (pre-fix: swapped by itself)", async () => {
    await expect(commit({ card: CML_HOLO })).rejects.toThrow(LINE_CHOICE.missing);
    expect(await slot1()).toEqual({ state: "filled", copy_id: OWNED_CML });
  });

  it("Keep must say where the holo goes", async () => {
    await expect(
      commit({
        card: CML_HOLO,
        lineChoice: { mode: "replace", lineId: LINE, slotId: S_STAGE1, keep: true },
      }),
    ).rejects.toThrow(LINE_CHOICE.holoNeedsHome);
    expect(await copyRow(CML_HOLO.existingCopyId!)).toEqual(UNPLACED);
  });

  it("Keep with the bulk box: the holo goes to bulk, and nothing in the line moves", async () => {
    await commit({
      card: CML_HOLO,
      lineChoice: {
        mode: "replace",
        lineId: LINE,
        slotId: S_STAGE1,
        keep: true,
        incoming: { kind: "bulk" },
      },
    });
    expect(await copyRow(CML_HOLO.existingCopyId!)).toMatchObject({
      role: "bulk",
      line_slot_id: null,
    });
    expect(await slot1()).toEqual({ state: "filled", copy_id: OWNED_CML });
    expect(await copyRow(OWNED_CML)).toMatchObject({ role: "shelved", line_slot_id: S_STAGE1 });
    expect((await decisionsFor(CML_HOLO.existingCopyId!))[0]).toMatchObject({
      resolved_by: "user",
      reason:
        "Kept the card already in the line (her call, UIL-117); this copy went where she sent it.",
    });
  });

  it("Keep sent to a back half with no line is refused: the holo is never stranded outside a line (QA)", async () => {
    await expect(
      commit({
        card: CML_HOLO,
        lineChoice: {
          mode: "replace",
          lineId: LINE,
          slotId: S_STAGE1,
          keep: true,
          incoming: { kind: "shelf", binderId: KB1, half: "back", band: "red" },
        },
      }),
    ).rejects.toThrow(/incomplete/);
    expect(await copyRow(CML_HOLO.existingCopyId!)).toEqual(UNPLACED);
    expect(await decisionsFor(CML_HOLO.existingCopyId!)).toEqual([]);
    expect(await slot1()).toEqual({ state: "filled", copy_id: OWNED_CML });
  });

  it("Swap is today's result, now her call: the holo takes the slot and the normal goes to bulk", async () => {
    await commit({
      card: CML_HOLO,
      lineChoice: {
        mode: "replace",
        lineId: LINE,
        slotId: S_STAGE1,
        keep: false,
        outgoing: { kind: "bulk" },
      },
    });
    expect(await slot1()).toEqual({ state: "filled", copy_id: CML_HOLO.existingCopyId });
    expect(await copyRow(OWNED_CML)).toMatchObject({ role: "bulk", line_slot_id: null });
    expect((await decisionsFor(CML_HOLO.existingCopyId!))[0]).toMatchObject({
      decision: "line-replace",
      resolved_by: "user",
    });
  });
});

describe("UIL-117 · START: a card that starts a line", () => {
  beforeEach(async () => {
    // No line yet; her Charmander in the front half, which the new line could pull.
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band) values
        ('${OWNED_CMD}', '${OWNER}', '${CHARMANDER_SV03_026.tcgdexId}', 'normal', 'shelved', '${KB1}', 'front', 'red');
    `);
    await seedHaulRows(db, [CML]);
    await asOwner(db);
  });

  it("proposes the green start", async () => {
    expect((await proposalFor(CML))?.kind).toBe("start");
  });

  it("is refused with no choice, and a Keep sent for it is refused too, with nothing written", async () => {
    await expect(commit({ card: CML })).rejects.toThrow(LINE_CHOICE.missing);
    await expect(
      commit({
        card: CML,
        lineChoice: { mode: "replace", lineId: LINE, slotId: S_STAGE1, keep: true },
      }),
    ).rejects.toThrow(LINE_CHOICE.missing);
    expect(await copyRow(CML.existingCopyId!)).toEqual(UNPLACED);
    await asSuperuser(db);
    expect((await db.query(`select id from evolution_line`)).rows).toEqual([]);
    await asOwner(db);
  });
});
