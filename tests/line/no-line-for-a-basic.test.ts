/**
 * A Basic with no evolutions is never a line. Karvi (2026-09-27): "A basic with no evolution should not be allowed to
 * get put in the 'lines' area."
 *
 * The one predicate (`formsALine`: the family has at least two stages in the catalog, in the card's own language),
 * and every writer that can insert a line refusing such a card in her words (`NOT_A_LINE`), with NOTHING written:
 *
 *   - the line popup's START (`buildLineChoiceOps`), through the Move sheet (`applyMove` with a line choice);
 *   - the Haul Plan's Move to a NEW line (`buildNewLineJoinOps`, through `commitCardPlacement`'s override);
 *   - the cascade's new line (`writeNewLine`, through `buildHaulCommitPayload`);
 *   - the popup's model for a start (`loadLinePopupModel`), every screen's backstop;
 *   - Backfill's back-half line (`validateBackLine`, through `commitBackLine`).
 *
 * The Move sheet's back half is pinned in tests/line/move-panel-picker.dom.test.ts; Lines' list in
 * tests/line/unlined-cards.test.ts; the database's own refusal of a one-stage line (0032) in tests/db/third-pocket-stays.test.ts.
 * Real Postgres (PGlite), the real `apply_write_ops`, as the owner.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { formsALine, type CatalogCard } from "@/lib/engine";
import { applyMove } from "@/lib/line";
import { BackLineRefused, commitBackLine } from "@/lib/backfill";
import { loadLinePopupModel } from "@/lib/line/popup-load";
import { NOT_A_LINE } from "@/lib/line/popup";
import {
  buildHaulCommitPayload,
  clearCatalogCache,
  commitCardPlacement,
  LINE_CHOICE,
  loadPlanContext,
  planFromDraft,
  type DraftItem,
  type PlannedCard,
} from "@/lib/plan";
import { CHARMANDER_SV03_026, CHARMELEON_SV03_027 } from "../engine/fixtures";
import {
  asOwner,
  asSuperuser,
  freshRpcDb,
  haulRow,
  OWNER,
  seedBinders,
  seedCatalogCardsFull,
  seedHaulCopies,
  seedHaulRows,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const KB1 = "1c000000-0000-0000-0000-0000000000b1";
const COPY = "c0000000-0000-0000-0000-0000000000d1";
/** A Basic nothing evolves from, and that evolves from nothing: a Tauros-type card. */
const LONER: CatalogCard = {
  ...CHARMANDER_SV03_026,
  tcgdexId: "sv03-128",
  name: "Loner",
  dexId: [9128],
  localId: "128",
  stage: "Basic",
  evolveFrom: null,
  artworkGroupId: "art-loner",
};
const names = { binderName: () => "KB-001", collectionName: () => null, bandName: () => "Red" };

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedCatalogCardsFull(db, [CHARMANDER_SV03_026, CHARMELEON_SV03_027, LONER]);
  await seedBinders(db, [{ id: KB1, type: "general", name: "KB-001" }]);
  clearCatalogCache();
});
afterEach(async () => {
  await db.close();
});

async function nothingWritten() {
  await asSuperuser(db);
  const lines = (await db.query(`select id from evolution_line`)).rows;
  const slots = (await db.query(`select id from line_slot`)).rows;
  await asOwner(db);
  expect(lines).toEqual([]);
  expect(slots).toEqual([]);
}

describe("formsALine, the one predicate", () => {
  it("the Haul Plan's item carries it, off the plan context's catalog", async () => {
    const [loner, cmd] = [
      haulRow("d0000000-0000-4000-8000-0000000000d3", LONER.tcgdexId),
      haulRow("d0000000-0000-4000-8000-0000000000d4", CHARMANDER_SV03_026.tcgdexId),
    ];
    await seedHaulRows(db, [loner, cmd]);
    await asOwner(db);
    const pc = await loadPlanContext(pgliteClient(db), { excludeOwnedCopyIds: [loner.id, cmd.id] });
    const byId = new Map(planFromDraft(pc, [loner, cmd]).items.map((it) => [it.incomingId, it]));
    expect(byId.get(loner.id)?.formsALine).toBe(false);
    expect(byId.get(cmd.id)?.formsALine).toBe(true);
  });

  it("a Basic with no evolutions forms none; a Basic that evolves, and its evolution, do", () => {
    const catalog = [CHARMANDER_SV03_026, CHARMELEON_SV03_027, LONER];
    expect(formsALine(LONER, catalog)).toBe(false);
    expect(formsALine(CHARMANDER_SV03_026, catalog)).toBe(true);
    expect(formsALine(CHARMELEON_SV03_027, catalog)).toBe(true);
  });
});

describe("every writer refuses a line for it, with nothing written", () => {
  it("the line popup's START (the Move sheet on Lines, Lookup, Collections)", async () => {
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band)
        values ('${COPY}', '${OWNER}', '${LONER.tcgdexId}', 'normal', 'shelved', '${KB1}', 'front', 'red');
    `);
    await asOwner(db);
    await expect(
      applyMove(
        pgliteClient(db),
        {
          copyId: COPY,
          destination: { kind: "shelf", binderId: KB1, half: "back", band: "red" },
          lineChoice: { mode: "start", binderId: KB1, band: "red", pulls: [], stages: {} },
        },
        names as never,
      ),
    ).rejects.toThrow(NOT_A_LINE);
    await nothingWritten();
  });

  it("the Haul Plan's Move to a NEW line", async () => {
    const card: DraftItem = haulRow("d0000000-0000-4000-8000-0000000000d1", LONER.tcgdexId);
    await seedHaulRows(db, [card]);
    await asOwner(db);
    await expect(
      commitCardPlacement(pgliteClient(db), {
        card,
        override: {
          kind: "shelf",
          binderId: KB1,
          half: "back",
          band: "red",
          lineJoin: { mode: "new" },
        },
      }),
    ).rejects.toThrow(NOT_A_LINE);
    await nothingWritten();
  });

  it("the cascade's own new line, if it ever planned one for it, is never written", async () => {
    const card: DraftItem = haulRow("d0000000-0000-4000-8000-0000000000d2", LONER.tcgdexId);
    await seedHaulRows(db, [card]);
    await asOwner(db);
    const pc = await loadPlanContext(pgliteClient(db), { excludeOwnedCopyIds: [card.id] });
    const [lead] = planFromDraft(pc, [card]).planned;
    // The cascade never proposes one (a Basic only joins); a one-slot NEWLINE is forged here to reach the writer.
    const forged: PlannedCard = {
      ...lead,
      action: "NEWLINE",
      result: {
        ...lead.result,
        step: "line-new",
        target: {
          kind: "back-half-line",
          binderId: KB1,
          band: "red" as never,
          lineId: "new",
          stageIndex: 0,
        },
        newLine: {
          rootDexId: 9128,
          colorBand: "red" as never,
          binderId: KB1,
          status: "complete",
          slots: [
            {
              stageIndex: 0,
              stage: "Basic",
              state: "filled",
              copyId: card.id,
              dexId: 9128,
              targetCatalogCardId: LONER.tcgdexId,
            },
          ],
        },
      },
    } as PlannedCard;
    // The cascade's own line writer is gone: any line card needs her line choice, which the builder above refuses.
    expect(() => buildHaulCommitPayload(pc, [forged], { draft: [card] })).toThrow(
      LINE_CHOICE.missing,
    );
  });

  it("the popup's model for a start refuses too: every screen's backstop", async () => {
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band)
        values ('${COPY}', '${OWNER}', '${LONER.tcgdexId}', 'normal', 'shelved', '${KB1}', 'front', 'red');
    `);
    await asOwner(db);
    await expect(
      loadLinePopupModel(pgliteClient(db), COPY, { kind: "start", binderId: KB1, band: "red" }),
    ).rejects.toThrow(NOT_A_LINE);
  });

  it("Backfill's back-half line for it, with her copy left waiting in the haul", async () => {
    await seedHaulCopies(db, [{ id: COPY, catalogCardId: LONER.tcgdexId }]);
    await asOwner(db);
    const err = await commitBackLine(pgliteClient(db), OWNER, {
      binderId: KB1,
      bandKey: "red",
      seedTcgdexId: LONER.tcgdexId,
      rootDexId: 9128,
      stages: [
        {
          stageIndex: 0,
          stage: "Basic",
          dexId: 9128,
          choice: { kind: "have", tcgdexId: LONER.tcgdexId, dexVariantRaw: "Normal" },
        },
      ],
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BackLineRefused);
    expect((err as Error).message).toBe(NOT_A_LINE);
    await nothingWritten();
    await asSuperuser(db);
    expect((await db.query(`select role from copy where id = $1`, [COPY])).rows).toEqual([
      { role: "haul" },
    ]);
  });
});
