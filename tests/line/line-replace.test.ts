/**
 * UIL-117 PR 3 — REPLACE: a copy swapped into a FILLED slot, driven through the real `applyMove` on real Postgres
 * (PGlite, every migration, 0028's slot check included), as the authenticated owner. Mockup v3 section 5 and her
 * answers 2 and 3: a replace opens on "keep the one that's there" (a Keep writes nothing to the line); a swap is ONE
 * write, so the line never shows a gap; the card coming out goes anywhere she picks, bulk suggested.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyMove, type MoveNameLookups } from "@/lib/line";
import type { LineChoice } from "@/lib/line/popup";
import { loadLinePopupModel } from "@/lib/line/popup-load";
import { listReplaceCandidates } from "@/lib/line/replace-candidates";
import { buildLineChoiceOps } from "@/lib/line/line-choice";
import type { MoveDestination } from "@/lib/line/types";
import {
  asOwner,
  asSuperuser,
  freshRpcDb,
  OWNER,
  seedBinders,
  seedCollections,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const GEN = "b0000000-0000-4000-8000-0000000117d1";
const GEN2 = "b0000000-0000-4000-8000-0000000117d2";
const SPEC = "b0000000-0000-4000-8000-0000000117d3";
const COL = "a0000000-0000-4000-8000-0000000117d1";
const LINE = "10000000-0000-4000-8000-0000000117d1";
const [SLOT0, SLOT1] = [
  "20000000-0000-4000-8000-0000000117d0",
  "20000000-0000-4000-8000-0000000117d1",
];
const BASIC = "c0000000-0000-4000-8000-0000000117d0"; // her Emberling, in the Basic slot
const OLD = "c0000000-0000-4000-8000-0000000117d1"; // the Emberdrake in the Stage 1 slot now
const NEW = "c0000000-0000-4000-8000-0000000117d2"; // a second Emberdrake (the alt art), front half

const names: MoveNameLookups = {
  binderName: () => "KB-001",
  collectionName: () => "Starters",
  bandDisplay: (k) => k.toUpperCase(),
};
const HERE: MoveDestination = { kind: "shelf", binderId: GEN, half: "back", band: "red" };
const swap = (outgoing: MoveDestination, extra: Partial<LineChoice> = {}): LineChoice =>
  ({
    mode: "replace",
    lineId: LINE,
    slotId: SLOT1,
    keep: false,
    outgoing,
    ...extra,
  }) as LineChoice;

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedBinders(db, [
    { id: GEN, type: "general", name: "KB-001" },
    { id: GEN2, type: "general", name: "KB-002" },
    { id: SPEC, type: "specialty", name: "Specialty A" },
  ]);
  await seedCollections(db, [
    { id: COL, name: "Starters", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
  ]);
  for (const [locale, prefix] of [
    ["en", ""],
    ["ja", "ja:"],
  ] as const) {
    await db.query(
      `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from, card_class, locale) values
         ($1, 'Emberling', '{9301}', '{Fire}', 'Basic', null, 'standard', $3),
         ($2, 'Emberdrake', '{9302}', '{Fire}', 'Stage1', 'Emberling', 'standard', $3)`,
      [`${prefix}emberling`, `${prefix}emberdrake`, locale],
    );
  }
  await db.query(
    `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from, card_class, locale)
       values ('emberdrake-alt', 'Emberdrake', '{9302}', '{Fire}', 'Stage1', 'Emberling', 'standard', 'en')`,
  );
  // A complete English line in KB-001 · back · red: Emberling, then Emberdrake.
  await db.query(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band) values
       ($1, $4, 'emberling', 'shelved', $5, 'back', 'red'),
       ($2, $4, 'emberdrake', 'shelved', $5, 'back', 'red'),
       ($3, $4, 'emberdrake-alt', 'shelved', $5, 'front', 'red')`,
    [BASIC, OLD, NEW, OWNER, GEN],
  );
  await db.query(
    `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
       values ($1, $2, 9301, 'red', $3, 'back', 'complete')`,
    [LINE, OWNER, GEN],
  );
  await db.query(
    `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id, target_catalog_card_id) values
       ($1, $3, $4, 0, 'Basic', 'filled', $5, 'emberling'),
       ($2, $3, $4, 1, 'Stage1', 'filled', $6, 'emberdrake')`,
    [SLOT0, SLOT1, OWNER, LINE, BASIC, OLD],
  );
  await db.query(`update copy set line_slot_id = $1 where id = $2`, [SLOT0, BASIC]);
  await db.query(`update copy set line_slot_id = $1 where id = $2`, [SLOT1, OLD]);
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  await asSuperuser(db);
  const rows = (await db.query<T>(sql, params)).rows;
  await asOwner(db);
  return rows;
}
const move = (choice: LineChoice, copyId = NEW, destination: MoveDestination = HERE) =>
  applyMove(pgliteClient(db), { copyId, destination, lineChoice: choice }, names);
const copyRow = async (id: string) =>
  (
    await q(
      `select role, binder_id, binder_half, color_band, line_slot_id from copy where id = $1`,
      [id],
    )
  )[0];
const unchanged = async () => {
  expect(await q(`select copy_id from line_slot where id = $1`, [SLOT1])).toEqual([
    { copy_id: OLD },
  ]);
  expect(await copyRow(NEW)).toMatchObject({ binder_half: "front", line_slot_id: null });
  expect(await copyRow(OLD)).toMatchObject({ binder_half: "back", line_slot_id: SLOT1 });
};

describe("SWAP · one write, the line never shows a gap", () => {
  it("to the bulk box (her suggestion, and the holo upgrade's rule): the new card in the slot, the old one out", async () => {
    await move(swap({ kind: "bulk" }));
    expect(await q(`select state, copy_id from line_slot where id = $1`, [SLOT1])).toEqual([
      { state: "filled", copy_id: NEW },
    ]);
    expect(await copyRow(NEW)).toEqual({
      role: "shelved",
      binder_id: GEN,
      binder_half: "back",
      color_band: "red",
      line_slot_id: SLOT1,
    });
    expect(await copyRow(OLD)).toEqual({
      role: "bulk",
      binder_id: null,
      binder_half: null,
      color_band: null,
      line_slot_id: null,
    });
    // Still complete: no moment where the line was missing its Stage 1.
    expect(await q(`select status from evolution_line where id = $1`, [LINE])).toEqual([
      { status: "complete" },
    ]);
    expect(
      await q(`select decision, resolved_by from placement_decision where copy_id = $1`, [OLD]),
    ).toEqual([{ decision: "line-replaced-out", resolved_by: "user" }]);
  });

  it("to a front half she picks", async () => {
    await move(swap({ kind: "shelf", binderId: GEN2, half: "front", band: "red" }));
    expect(await copyRow(OLD)).toEqual({
      role: "shelved",
      binder_id: GEN2,
      binder_half: "front",
      color_band: "red",
      line_slot_id: null,
    });
  });

  it("to a collection: it lands in its binder AND joins its list, so it is tracked there", async () => {
    await move(swap({ kind: "collection", binderId: SPEC, collectionId: COL }));
    expect(await copyRow(OLD)).toMatchObject({
      role: "shelved",
      binder_id: SPEC,
      line_slot_id: null,
    });
    expect(
      await q(`select target_catalog_card_ids t from collection where id = $1`, [COL]),
    ).toEqual([{ t: ["emberdrake"] }]);
  });

  it("into another line she starts: the old card fills that line's slot, in the same write", async () => {
    const other: MoveDestination = { kind: "shelf", binderId: GEN2, half: "back", band: "red" };
    await move(
      swap(other, {
        outgoingLine: { mode: "start", binderId: GEN2, band: "red", pulls: [] },
      } as Partial<LineChoice>),
    );
    const moved = await copyRow(OLD);
    expect(moved).toMatchObject({ binder_id: GEN2, binder_half: "back", color_band: "red" });
    expect(moved.line_slot_id).not.toBeNull();
    expect(
      await q(`select state, copy_id from line_slot where id = $1`, [moved.line_slot_id]),
    ).toEqual([{ state: "filled", copy_id: OLD }]);
    expect(await q(`select binder_id from evolution_line where id <> $1`, [LINE])).toEqual([
      { binder_id: GEN2 },
    ]);
  });
});

describe("the builder itself (for a caller that goes straight to it)", () => {
  it("refuses a Keep: it writes nothing to the line, so it must never look like it did", () => {
    const state = {
      copy: { id: NEW } as never,
      incoming: {
        id: NEW,
        card: { dexId: [9302], tcgdexId: "emberdrake-alt", name: "Emberdrake" },
      } as never,
      catalog: [],
      typeColorMap: {},
      owned: [],
      copiesById: new Map(),
      lines: new Map(),
      slotsByLine: new Map(),
    };
    expect(() =>
      buildLineChoiceOps(state, NEW, { mode: "replace", lineId: LINE, slotId: SLOT1, keep: true }),
    ).toThrow(/Keeping the card that's there writes nothing to the line/);
  });
});

describe("refused, with nothing written", () => {
  it("a Keep: it writes nothing to the line, so a Move cannot carry one", async () => {
    await expect(
      move({ mode: "replace", lineId: LINE, slotId: SLOT1, keep: true } as LineChoice),
    ).rejects.toThrow(/doesn't go into the line/);
    await unchanged();
  });

  it("a card of another species for the slot", async () => {
    await asSuperuser(db);
    const WRONG = "c0000000-0000-4000-8000-0000000117d9";
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
         values ($1, $2, 'emberling', 'shelved', $3, 'front', 'red')`,
      [WRONG, OWNER, GEN],
    );
    await asOwner(db);
    await expect(move(swap({ kind: "bulk" }), WRONG)).rejects.toThrow(/different card/);
    await unchanged();
  });

  it("a slot that is no longer filled", async () => {
    await asSuperuser(db);
    await db.query(
      `update copy set line_slot_id = null, role = 'bulk', binder_id = null,
                      binder_half = null, color_band = null where id = $1`,
      [OLD],
    );
    await db.query(`update line_slot set state = 'placeholder', copy_id = null where id = $1`, [
      SLOT1,
    ]);
    await db.query(`update evolution_line set status = 'open' where id = $1`, [LINE]);
    await asOwner(db);
    await expect(move(swap({ kind: "bulk" }))).rejects.toThrow(/no longer filled/);
  });

  it("the old card sent into a back half with no line picked for it", async () => {
    await expect(
      move(swap({ kind: "shelf", binderId: GEN2, half: "back", band: "red" })),
    ).rejects.toThrow(/pick the line it goes into/);
    await unchanged();
  });

  it("the card coming out sent to be a binder block (QA R4: a phantom block with no block row)", async () => {
    await expect(
      move(swap({ kind: "block", lineId: LINE, slotId: SLOT0, binderId: GEN })),
    ).rejects.toThrow(/can't become a binder block/);
    await unchanged();
    expect(await q(`select id from binder_block`)).toEqual([]);
  });

  it("the card coming out sent to a collection that no longer exists (QA R11: it would sit on no list)", async () => {
    await expect(
      move(
        swap({
          kind: "collection",
          binderId: SPEC,
          collectionId: "a0000000-0000-4000-8000-00000000dead",
        }),
      ),
    ).rejects.toThrow(/collection/i);
    await unchanged();
  });

  it("a destination that is not the line's binder and band", async () => {
    await expect(
      move(swap({ kind: "bulk" }), NEW, {
        kind: "shelf",
        binderId: GEN,
        half: "back",
        band: "green",
      }),
    ).rejects.toThrow(/another colour band/);
    await unchanged();
  });
});

describe("another language (the same rule as a join)", () => {
  async function japaneseDrake() {
    await asSuperuser(db);
    const JA = "c0000000-0000-4000-8000-0000000117da";
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
         values ($1, $2, 'ja:emberdrake', 'shelved', $3, 'front', 'red')`,
      [JA, OWNER, GEN],
    );
    await asOwner(db);
    return JA;
  }

  it("without her second confirm: refused", async () => {
    const JA = await japaneseDrake();
    await expect(move(swap({ kind: "bulk" }), JA)).rejects.toThrow(/another language/);
    await unchanged();
  });

  it("with it, above an English Basic: allowed, and the line still reads English", async () => {
    const JA = await japaneseDrake();
    await move(swap({ kind: "bulk" }, { foreignLocale: true } as Partial<LineChoice>), JA);
    expect(await q(`select copy_id from line_slot where id = $1`, [SLOT1])).toEqual([
      { copy_id: JA },
    ]);
  });

  it("replacing the line's LOWEST card with one in another language: refused, it would flip the line", async () => {
    await asSuperuser(db);
    const JA_BASIC = "c0000000-0000-4000-8000-0000000117db";
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
         values ($1, $2, 'ja:emberling', 'shelved', $3, 'front', 'red')`,
      [JA_BASIC, OWNER, GEN],
    );
    await asOwner(db);
    await expect(
      move(
        {
          mode: "replace",
          lineId: LINE,
          slotId: SLOT0,
          keep: false,
          outgoing: { kind: "bulk" },
          foreignLocale: true,
        },
        JA_BASIC,
      ),
    ).rejects.toThrow("This would make the line read as Japanese. Start a Japanese line instead.");
  });
});

describe("'Replace this card': the copies that could take the slot (listReplaceCandidates)", () => {
  it("same species, not the card there now, not in a line: front half first, then the bulk box", async () => {
    await asSuperuser(db);
    const BULK = "c0000000-0000-4000-8000-0000000117dc";
    const JA = "c0000000-0000-4000-8000-0000000117dd";
    const OTHER_SPECIES = "c0000000-0000-4000-8000-0000000117de";
    const IN_OTHER_LINE = "c0000000-0000-4000-8000-0000000117df";
    const OTHER_LINE = "10000000-0000-4000-8000-0000000117df";
    const OTHER_SLOT = "20000000-0000-4000-8000-0000000117df";
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band) values
         ($1, $4, 'emberdrake', 'bulk', null, null, null),
         ($2, $4, 'ja:emberdrake', 'shelved', $5, 'front', 'red'),
         ($3, $4, 'emberling', 'shelved', $5, 'front', 'red')`,
      [BULK, JA, OTHER_SPECIES, OWNER, GEN],
    );
    // An Emberdrake already filling ANOTHER line: moving it is that line's Move, not a swap here.
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
         values ($1, $2, 'emberdrake', 'shelved', $3, 'back', 'red')`,
      [IN_OTHER_LINE, OWNER, GEN2],
    );
    await db.query(
      `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
         values ($1, $2, 9301, 'red', $3, 'back', 'open')`,
      [OTHER_LINE, OWNER, GEN2],
    );
    await db.query(
      `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
         values ($1, $2, $3, 1, 'Stage1', 'filled', $4)`,
      [OTHER_SLOT, OWNER, OTHER_LINE, IN_OTHER_LINE],
    );
    await db.query(`update copy set line_slot_id = $1 where id = $2`, [OTHER_SLOT, IN_OTHER_LINE]);
    await asOwner(db);
    const res = await listReplaceCandidates(pgliteClient(db), SLOT1);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.slotCardName).toBe("Emberdrake");
    // Not offered: OLD (the card there now), BASIC (another species), IN_OTHER_LINE (already in a line).
    expect(res.candidates.map((c) => [c.copyId, c.where])).toEqual([
      [NEW, "KB-001 · Front · Red"],
      [JA, "KB-001 · Front · Red"],
      [BULK, "Bulk box"],
    ]);
  });

  it("a slot that is no longer filled: refused in her words", async () => {
    await asSuperuser(db);
    await db.query(`update copy set line_slot_id = null where id = $1`, [OLD]);
    await db.query(`update line_slot set state = 'placeholder', copy_id = null where id = $1`, [
      SLOT1,
    ]);
    await asOwner(db);
    expect(await listReplaceCandidates(pgliteClient(db), SLOT1)).toEqual({
      ok: false,
      error: "That slot is no longer filled — reload the Lines page.",
    });
  });
});

describe("the popup's model for a replace (loadLinePopupModel)", () => {
  it("both cards for the one slot, where each is now, opening on Keep, bulk suggested", async () => {
    const m = await loadLinePopupModel(pgliteClient(db), NEW, {
      kind: "replace",
      lineId: LINE,
      slotId: SLOT1,
      defaultKeep: true,
    });
    expect(m.mode).toBe("replace");
    expect(m.line).toMatchObject({ lineId: LINE, filledBefore: 2, filledAfter: 2, total: 2 });
    expect(m.stages.map((s) => [s.stage, s.state])).toEqual([
      ["Basic", "here"],
      ["Stage1", "incoming"],
    ]);
    expect(m.replace).toMatchObject({
      slotId: SLOT1,
      current: { copyId: OLD, card: { tcgdexId: "emberdrake" }, where: "KB-001 · Back · Red" },
      incoming: { copyId: NEW, card: { tcgdexId: "emberdrake-alt" } },
      defaultKeep: true,
      suggestedOutgoing: { kind: "bulk" },
    });
    expect(m.replace?.incoming.where).toMatch(/^KB-001 · Front/);
    // The holo upgrade's proposal opens pre-set to swap: the model carries it, not a default.
    const holo = await loadLinePopupModel(pgliteClient(db), NEW, {
      kind: "replace",
      lineId: LINE,
      slotId: SLOT1,
      defaultKeep: false,
    });
    expect(holo.replace?.defaultKeep).toBe(false);
  });

  it("refuses a slot that is no longer filled", async () => {
    await asSuperuser(db);
    await db.query(`update copy set line_slot_id = null where id = $1`, [OLD]);
    await db.query(`update line_slot set state = 'placeholder', copy_id = null where id = $1`, [
      SLOT1,
    ]);
    await asOwner(db);
    await expect(
      loadLinePopupModel(pgliteClient(db), NEW, {
        kind: "replace",
        lineId: LINE,
        slotId: SLOT1,
        defaultKeep: true,
      }),
    ).rejects.toThrow(/no longer filled/);
  });
});
