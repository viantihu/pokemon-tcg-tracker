/**
 * UIL-117 PR 2 — `buildLineChoiceOps`, the one way a line gets written, driven through the real `applyMove` on real
 * Postgres (PGlite, every migration, 0028's slot check included), as the authenticated owner.
 *
 *   START: only the pulls she ticked move (UIL-061); an unticked stage stays a placeholder "left in place (not
 *          confirmed)"; a ticked pull releases the slot it leaves and gets its own audit row; the line's status comes
 *          from the slots actually written, so it is `complete` only when every one is filled.
 *   JOIN:  a line in another language takes her second confirm, and even then only where a card of the LINE's
 *          language already fills a lower stage, so the line's derived language never flips (the Senior BA's
 *          ruling on Q1).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyMove, type MoveNameLookups } from "@/lib/line";
import type { LineChoice } from "@/lib/line/popup";
import { loadFamilyLines, loadLinePopupModel } from "@/lib/line/popup-load";
import { lineLocaleOf } from "@/lib/engine";
import { asOwner, asSuperuser, freshRpcDb, OWNER, seedBinders } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const GEN = "b0000000-0000-4000-8000-0000000117b1";
const MOVING = "c0000000-0000-4000-8000-0000000117a1";
const OWNED = "c0000000-0000-4000-8000-0000000117a2";
const LINE = "10000000-0000-4000-8000-0000000117a1";
const [SLOT0, SLOT1] = [
  "20000000-0000-4000-8000-0000000117a0",
  "20000000-0000-4000-8000-0000000117a1",
];
const [EMBERLING, EMBERDRAKE] = [9301, 9302];

const names: MoveNameLookups = {
  binderName: () => "KB-001",
  collectionName: () => null,
  bandDisplay: (k) => k.toUpperCase(),
};

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedBinders(db, [{ id: GEN, type: "general", name: "KB-001" }]);
  for (const [locale, prefix] of [
    ["en", ""],
    ["ja", "ja:"],
  ] as const) {
    await db.query(
      `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from, card_class, locale) values
         ($1, 'Emberling', $3, '{Fire}', 'Basic', null, 'standard', $5),
         ($2, 'Emberdrake', $4, '{Fire}', 'Stage1', 'Emberling', 'standard', $5)`,
      [`${prefix}emberling`, `${prefix}emberdrake`, [EMBERLING], [EMBERDRAKE], locale],
    );
  }
});
afterEach(async () => {
  await db.close();
});

async function q<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  await asSuperuser(db);
  const r = (await db.query<T>(sql, params)).rows;
  await asOwner(db);
  return r;
}
async function shelvedFront(id: string, card: string) {
  await asSuperuser(db);
  await db.query(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
       values ($1, $2, $3, 'shelved', $4, 'front', 'red')`,
    [id, OWNER, card, GEN],
  );
}
const move = (choice: LineChoice, copyId = MOVING) =>
  applyMove(
    pgliteClient(db),
    {
      copyId,
      destination: { kind: "shelf", binderId: GEN, half: "back", band: "red" },
      lineChoice: choice,
    },
    names,
  );
const start = (pulls: string[] = []): LineChoice => ({
  mode: "start",
  binderId: GEN,
  band: "red",
  pulls,
});

describe("START · only what she ticked moves, and the status is the slots'", () => {
  beforeEach(async () => {
    await shelvedFront(OWNED, "emberling"); // she owns the Basic, in a front half
    await shelvedFront(MOVING, "emberdrake"); // and moves the Stage 1 into a back half
    await asOwner(db);
  });

  it("unticked: her Emberling stays put, its stage is a placeholder, and the line is open, not complete", async () => {
    await move(start());
    const slots = await q<{ stage_index: number; state: string; note: string | null }>(
      `select stage_index, state, note from line_slot order by stage_index`,
    );
    expect(slots).toEqual([
      { stage_index: 0, state: "placeholder", note: "left in place (not confirmed)" },
      { stage_index: 1, state: "filled", note: expect.anything() },
    ]);
    expect((await q<{ status: string }>(`select status from evolution_line`))[0].status).toBe(
      "open",
    );
    expect(
      (await q<{ binder_half: string }>(`select binder_half from copy where id = $1`, [OWNED]))[0],
    ).toEqual({
      binder_half: "front",
    });
  });

  it("ticked: her Emberling moves in, shelved in the line's binder and band, audited, and the line is complete", async () => {
    await move(start([OWNED]));
    expect(
      (
        await q(`select role, binder_id, binder_half, color_band from copy where id = $1`, [OWNED])
      )[0],
    ).toEqual({ role: "shelved", binder_id: GEN, binder_half: "back", color_band: "red" });
    expect((await q<{ status: string }>(`select status from evolution_line`))[0].status).toBe(
      "complete",
    );
    const audit = await q<{ decision: string; resolved_by: string }>(
      `select decision, resolved_by from placement_decision where copy_id = $1`,
      [OWNED],
    );
    expect(audit).toEqual([{ decision: "line-pull-confirmed", resolved_by: "user" }]);
  });

  it("a ticked pull leaves its old line's slot released, and that line no longer reads complete", async () => {
    await asSuperuser(db);
    const OLD_LINE = "10000000-0000-4000-8000-0000000117ff";
    const OLD_SLOT = "20000000-0000-4000-8000-0000000117ff";
    await db.query(
      `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
         values ($1, $2, $3, 'red', $4, 'back', 'complete')`,
      [OLD_LINE, OWNER, EMBERLING, GEN],
    );
    await db.query(
      `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
         values ($1, $2, $3, 0, 'Basic', 'filled', $4)`,
      [OLD_SLOT, OWNER, OLD_LINE, OWNED],
    );
    await db.query(`update copy set binder_half = 'back', line_slot_id = $1 where id = $2`, [
      OLD_SLOT,
      OWNED,
    ]);
    await asOwner(db);
    await move(start([OWNED]));
    expect((await q(`select state, copy_id from line_slot where id = $1`, [OLD_SLOT]))[0]).toEqual({
      state: "placeholder",
      copy_id: null,
    });
    expect(
      (
        await q<{ status: string }>(`select status from evolution_line where id = $1`, [OLD_LINE])
      )[0].status,
    ).toBe("open");
  });

  it.each([
    [
      "colour band",
      { mode: "start", binderId: GEN, band: "dark_blue", pulls: [] } as LineChoice,
      /another colour band than the one this card is moving to/,
    ],
    [
      "binder",
      {
        mode: "start",
        binderId: "b0000000-0000-4000-8000-0000000117b2",
        band: "red",
        pulls: [],
      } as LineChoice,
      /another binder than the one this card is moving to/,
    ],
  ])(
    "a start for another %s than the destination is refused, and nothing is written (QA on #385)",
    async (_, choice, message) => {
      await seedBinders(db, [
        { id: "b0000000-0000-4000-8000-0000000117b2", type: "general", name: "KB-002" },
      ]);
      await asOwner(db);
      // The destination is GEN · back · red; the choice names somewhere else.
      await expect(move(choice)).rejects.toThrow(message);
      expect(await q(`select id from evolution_line`)).toEqual([]);
      expect(
        await q(`select binder_id, binder_half, color_band, line_slot_id from copy where id = $1`, [
          MOVING,
        ]),
      ).toEqual([{ binder_id: GEN, binder_half: "front", color_band: "red", line_slot_id: null }]);
    },
  );

  it("a tick for a card this line did not propose is refused, and nothing is written", async () => {
    await expect(move(start(["c0000000-0000-4000-8000-00000000dead"]))).rejects.toThrow(
      /no longer one this line can take/,
    );
    expect(await q(`select id from evolution_line`)).toEqual([]);
  });
});

describe("JOIN · a line in another language (the Senior BA's Q1 ruling)", () => {
  /** A Japanese line in KB-001: `filledStage` holds a Japanese card, the other stage is open for its Japanese target. */
  async function japaneseLine(filledStage: 0 | 1) {
    const filledCopy = "c0000000-0000-4000-8000-0000000117b9";
    await shelvedFront(filledCopy, filledStage === 0 ? "ja:emberling" : "ja:emberdrake");
    await asSuperuser(db);
    await db.query(
      `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
         values ($1, $2, $3, 'red', $4, 'back', 'open')`,
      [LINE, OWNER, EMBERLING, GEN],
    );
    await db.query(
      `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id, target_catalog_card_id) values
         ($1, $3, $4, 0, 'Basic',  $5, $6, 'ja:emberling'),
         ($2, $3, $4, 1, 'Stage1', $7, $8, 'ja:emberdrake')`,
      [
        SLOT0,
        SLOT1,
        OWNER,
        LINE,
        filledStage === 0 ? "filled" : "placeholder",
        filledStage === 0 ? filledCopy : null,
        filledStage === 1 ? "filled" : "placeholder",
        filledStage === 1 ? filledCopy : null,
      ],
    );
    await db.query(`update copy set binder_half = 'back', line_slot_id = $1 where id = $2`, [
      filledStage === 0 ? SLOT0 : SLOT1,
      filledCopy,
    ]);
    await asOwner(db);
  }
  async function derivedLocale() {
    const slots = await q<{
      id: string;
      stage_index: number;
      stage: string;
      state: string;
      copy_id: string | null;
      target_catalog_card_id: string | null;
    }>(
      `select id, stage_index, stage, state, copy_id, target_catalog_card_id from line_slot where line_id = $1`,
      [LINE],
    );
    const cards = new Map(
      (
        await q<{ id: string; catalog_card_id: string }>(`select id, catalog_card_id from copy`)
      ).map((c) => [c.id, c.catalog_card_id]),
    );
    return lineLocaleOf(
      slots.map((s) => ({
        id: s.id,
        stageIndex: s.stage_index,
        stage: s.stage,
        state: s.state as never,
        copyId: s.copy_id,
        dexId: null,
        targetCatalogCardId: s.target_catalog_card_id,
      })),
      (id) => cards.get(id) ?? null,
    );
  }

  it("without the second confirm: refused, saying why", async () => {
    await japaneseLine(0);
    await shelvedFront(MOVING, "emberdrake"); // an ENGLISH Emberdrake
    await asOwner(db);
    await expect(move({ mode: "join", lineId: LINE, slotId: SLOT1 })).rejects.toThrow(
      /line is in another language \(Japanese\) than this card \(English\)/,
    );
  });

  it("with it, above a Japanese Basic: allowed, and the line still reads Japanese (pinned)", async () => {
    await japaneseLine(0);
    await shelvedFront(MOVING, "emberdrake");
    await asOwner(db);
    expect(await derivedLocale()).toBe("ja");
    await move({ mode: "join", lineId: LINE, slotId: SLOT1, foreignLocale: true });
    expect((await q(`select state, copy_id from line_slot where id = $1`, [SLOT1]))[0]).toEqual({
      state: "filled",
      copy_id: MOVING,
    });
    expect(await derivedLocale()).toBe("ja");
  });

  it("with it, but it would become the line's lowest card: refused, and she is pointed to her own language", async () => {
    await japaneseLine(1); // the Japanese card is the Stage 1; the Basic is open
    await shelvedFront(MOVING, "emberling"); // an ENGLISH Emberling would become the lowest filled stage
    await asOwner(db);
    await expect(
      move({ mode: "join", lineId: LINE, slotId: SLOT0, foreignLocale: true }),
    ).rejects.toThrow("This would make the line read as English. Start an English line instead.");
    expect(await derivedLocale()).toBe("ja");
  });
});

describe("the popup's model (loadLinePopupModel), built from fresh state", () => {
  it("START lays out the line: her owned Basic as an UNTICKED pull with where it is now, the card being placed", async () => {
    await shelvedFront(OWNED, "emberling");
    await shelvedFront(MOVING, "emberdrake");
    await asOwner(db);
    const m = await loadLinePopupModel(pgliteClient(db), MOVING, {
      kind: "start",
      binderId: GEN,
      band: "red",
    });
    expect(m.mode).toBe("start");
    expect(m.line).toMatchObject({
      lineId: null,
      binderName: "KB-001",
      locale: "en",
      filledBefore: 0,
      total: 2,
    });
    expect(m.stages.map((s) => [s.stage, s.state, s.card?.name])).toEqual([
      ["Basic", "pullable", "Emberling"],
      ["Stage1", "incoming", "Emberdrake"],
    ]);
    // In a front half, so it leaves no line short: no `leaves`.
    expect(m.stages[0].pull).toEqual({
      copyId: OWNED,
      fromLabel: expect.stringContaining("KB-001 · Front"),
    });
    expect(m.existingLines).toEqual([]);
  });

  it("ADD lays out the existing line with the card landing in its slot, and names the line's language", async () => {
    // A Japanese line with its Basic filled; an English Emberdrake proposed into its open Stage 1.
    const filled = "c0000000-0000-4000-8000-0000000117c9";
    await shelvedFront(filled, "ja:emberling");
    await shelvedFront(MOVING, "emberdrake");
    await asSuperuser(db);
    await db.query(
      `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
         values ($1, $2, $3, 'red', $4, 'back', 'open')`,
      [LINE, OWNER, EMBERLING, GEN],
    );
    await db.query(
      `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id, target_catalog_card_id) values
         ($1, $3, $4, 0, 'Basic', 'filled', $5, 'ja:emberling'),
         ($2, $3, $4, 1, 'Stage1', 'placeholder', null, 'ja:emberdrake')`,
      [SLOT0, SLOT1, OWNER, LINE, filled],
    );
    await db.query(`update copy set binder_half = 'back', line_slot_id = $1 where id = $2`, [
      SLOT0,
      filled,
    ]);
    await asOwner(db);
    const m = await loadLinePopupModel(pgliteClient(db), MOVING, {
      kind: "add",
      lineId: LINE,
      slotId: SLOT1,
    });
    expect(m.line).toMatchObject({
      lineId: LINE,
      locale: "ja",
      filledBefore: 1,
      filledAfter: 2,
      total: 2,
    });
    expect(m.card.locale).toBe("en");
    expect(m.stages.map((s) => [s.stage, s.state])).toEqual([
      ["Basic", "here"],
      ["Stage1", "incoming"],
    ]);
    // The line being added to is the popup's subject, not one of "the lines you already have".
    expect(m.existingLines.map((l) => l.lineId)).not.toContain(LINE);
  });

  it("START names the line a pull would leave one short, and only when the card really fills it (UIL-061)", async () => {
    await shelvedFront(OWNED, "emberling");
    await shelvedFront(MOVING, "emberdrake");
    await asSuperuser(db);
    const OTHER_LINE = "10000000-0000-4000-8000-0000000117e1";
    const OTHER_SLOT = "20000000-0000-4000-8000-0000000117e1";
    await db.query(
      `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
         values ($1, $2, $3, 'red', $4, 'back', 'complete')`,
      [OTHER_LINE, OWNER, EMBERLING, GEN],
    );
    await db.query(
      `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
         values ($1, $2, $3, 0, 'Basic', 'filled', $4)`,
      [OTHER_SLOT, OWNER, OTHER_LINE, OWNED],
    );
    await db.query(`update copy set binder_half = 'back', line_slot_id = $1 where id = $2`, [
      OTHER_SLOT,
      OWNED,
    ]);
    await asOwner(db);
    const m = await loadLinePopupModel(pgliteClient(db), MOVING, {
      kind: "start",
      binderId: GEN,
      band: "red",
    });
    expect(m.stages[0].pull).toEqual({
      copyId: OWNED,
      fromLabel: expect.stringContaining("KB-001 · Back"),
      leaves: { lineName: "EMBERLING LINE", stage: "Basic" },
    });
  });

  it("START names every line the family already has, with the slot this card could take there", async () => {
    await shelvedFront(MOVING, "emberdrake");
    await asSuperuser(db);
    await db.query(
      `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
         values ($1, $2, $3, 'red', $4, 'back', 'open')`,
      [LINE, OWNER, EMBERLING, GEN],
    );
    await db.query(
      `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id, target_catalog_card_id) values
         ($1, $3, $4, 0, 'Basic', 'placeholder', null, 'emberling'),
         ($2, $3, $4, 1, 'Stage1', 'placeholder', null, 'emberdrake')`,
      [SLOT0, SLOT1, OWNER, LINE],
    );
    await asOwner(db);
    const m = await loadLinePopupModel(pgliteClient(db), MOVING, {
      kind: "start",
      binderId: GEN,
      band: "red",
    });
    expect(m.existingLines).toEqual([
      expect.objectContaining({
        lineId: LINE,
        binderName: "KB-001",
        locale: "en",
        joinSlotId: SLOT1,
        sameHere: true,
        // Nothing held there yet, so the tile shows the line's top target (UX review of #385: lead with the image).
        face: expect.objectContaining({ tcgdexId: "emberdrake", name: "Emberdrake" }),
      }),
    ]);
  });

  it("loadFamilyLines (Backfill's confirm sheet) gives the same family list for a seed card, from fresh state", async () => {
    await shelvedFront(MOVING, "emberdrake");
    await asSuperuser(db);
    await db.query(
      `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
         values ($1, $2, $3, 'red', $4, 'back', 'open')`,
      [LINE, OWNER, EMBERLING, GEN],
    );
    await db.query(
      `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id, target_catalog_card_id) values
         ($1, $3, $4, 0, 'Basic', 'placeholder', null, 'emberling'),
         ($2, $3, $4, 1, 'Stage1', 'placeholder', null, 'emberdrake')`,
      [SLOT0, SLOT1, OWNER, LINE],
    );
    await asOwner(db);
    const here = { binderId: GEN, band: "red" };
    const viaPopup = await loadLinePopupModel(pgliteClient(db), MOVING, { kind: "start", ...here });
    const forSeed = await loadFamilyLines(pgliteClient(db), "emberdrake", here);
    expect(forSeed).toEqual(viaPopup.existingLines);
    expect(forSeed).toEqual([
      expect.objectContaining({ lineId: LINE, joinSlotId: SLOT1, sameHere: true }),
    ]);
    // Another band here: the same line, but not "the same here".
    expect(
      (await loadFamilyLines(pgliteClient(db), "emberdrake", { binderId: GEN, band: "green" }))[0]
        .sameHere,
    ).toBe(false);
  });
});
