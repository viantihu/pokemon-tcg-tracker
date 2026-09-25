/**
 * UIL-084, the write half — a refused override leaves NOTHING behind, so "the card never landed" is the
 * literal truth of the database and not just what the screen said.
 *
 * Her report was that Done failed every time and the card never landed while the screen kept reading
 * MOVED. The display half of that is fixed in `override-moved-until-written.dom.test.ts`; this pins the
 * other half of the same sentence: when the server refuses her manual placement, no copy is created, no
 * line or slot is touched, and no audit row is written — there is nothing half-applied for the screen to
 * be right or wrong about, and nothing for a retry to trip over.
 *
 * WHICH REFUSAL, and why it changed. This file used "a second line for the species in the SAME binder",
 * on the reasoning that it stayed refused under every uniqueness rule. UIL-096 removed that refusal
 * outright — Karvi: "Instead of blocking the creation of an evolution line, I want a warning" — so a new
 * line there now LANDS (pinned in tests/line/second-line-in-binder.test.ts). The property this file exists
 * for is not about lines at all, it is "a refused override leaves nothing behind", so it now uses a refusal
 * that still stands on the same fixture: joining the line's Stage 1 slot, which a Toedscruel already fills.
 *
 * Real Postgres (PGlite), real migrations, real `apply_write_ops`, as the authenticated owner.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { clearCatalogCache, commitCardPlacement, type DraftItem } from "@/lib/plan";
import type { MoveDestination } from "@/lib/line/types";
import {
  OWNER,
  asOwner,
  asSuperuser,
  count,
  freshRpcDb,
  haulRow,
  seedBinders,
  seedHaulRows,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const KB1 = "b0000000-0000-0000-0000-0000000000d1";
const LINE = "10000000-0000-0000-0000-0000000000d1";
const SLOT_ROOT = "50000000-0000-0000-0000-0000000000d1";
const SLOT_S1 = "50000000-0000-0000-0000-0000000000d2";
const OWNED_ROOT = "c0000000-0000-0000-0000-0000000000d1";
const OWNED_S1 = "c0000000-0000-0000-0000-0000000000d2";

const ROOT_DEX = 9481;
const S1_DEX = 9482;
/** The Toedscruel she is holding: a second copy her import made, waiting in her haul (UIL-098). */
const DRAFT: DraftItem = haulRow("d0000000-0000-4000-8000-0000000000d9", "toedscruel");

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  clearCatalogCache();
  await seedBinders(db, [{ id: KB1, type: "general", name: "KB-001" }]);
  for (const [id, name, dex, stage, from] of [
    ["toedscool", "Toedscool", ROOT_DEX, "Basic", null],
    ["toedscruel", "Toedscruel", S1_DEX, "Stage1", "Toedscool"],
  ] as const) {
    await db.query(
      `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from, card_class)
         values ($1, $2, $3, '{Fighting}', $4, $5, 'standard')`,
      [id, name, [dex], stage, from],
    );
  }
  await seedHaulRows(db, [DRAFT]);
  // Her state: an Orange line whose every stage is already filled, so a second copy of a lined stage
  // has no slot to join.
  await db.query(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
       values ($1, $2, 'toedscool', 'shelved', $3, 'back', 'orange'),
              ($4, $2, 'toedscruel', 'shelved', $3, 'back', 'orange')`,
    [OWNED_ROOT, OWNER, KB1, OWNED_S1],
  );
  await db.exec(`
    insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
      values ('${LINE}', '${OWNER}', ${ROOT_DEX}, 'orange', '${KB1}', 'back', 'complete');
    insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
      values ('${SLOT_ROOT}', '${OWNER}', '${LINE}', 0, 'Basic', 'filled', '${OWNED_ROOT}'),
             ('${SLOT_S1}',  '${OWNER}', '${LINE}', 1, 'Stage1', 'filled', '${OWNED_S1}');
    update copy set line_slot_id = '${SLOT_ROOT}' where id = '${OWNED_ROOT}';
    update copy set line_slot_id = '${SLOT_S1}'   where id = '${OWNED_S1}';
  `);
});
afterEach(async () => {
  await db.close();
});

/** Everything the commit could have touched, in one snapshot. */
async function state() {
  const rows = async (sql: string) => (await db.query<Record<string, unknown>>(sql)).rows;
  return {
    copies: await rows(
      `select id, catalog_card_id, role, binder_id, binder_half, color_band, line_slot_id
         from copy order by id`,
    ),
    lines: await rows(`select id, root_dex_id, color_band, binder_id, status from evolution_line`),
    slots: await rows(`select id, stage_index, state, copy_id from line_slot order by stage_index`),
    decisions: await count(db, "placement_decision"),
    hauls: await count(db, "haul"),
  };
}

describe("UIL-084 · a refused manual placement writes nothing at all", () => {
  it("refuses joining a slot that is already filled, and leaves every row untouched", async () => {
    const before = await state();
    expect(before.decisions).toBe(0);
    expect(before.hauls).toBe(0);

    const override: MoveDestination = {
      kind: "shelf",
      binderId: KB1,
      half: "back",
      band: "orange",
      lineJoin: { mode: "existing", lineId: LINE, slotId: SLOT_S1 },
    };
    await asOwner(db);
    await expect(commitCardPlacement(pgliteClient(db), { card: DRAFT, override })).rejects.toThrow(
      /already been filled/,
    );
    await asSuperuser(db);

    // Byte-for-byte the state we started from: the card she is holding still unplaced in her haul, no
    // second line, no slot re-pointed, and no audit row or haul opened by the attempt.
    expect(await state()).toEqual(before);
  });

  it("the card she is holding is still in her haul, placed nowhere — 'it never landed' is literally true", async () => {
    await asOwner(db);
    await expect(
      commitCardPlacement(pgliteClient(db), {
        card: DRAFT,
        override: {
          kind: "shelf",
          binderId: KB1,
          half: "back",
          band: "orange",
          lineJoin: { mode: "existing", lineId: LINE, slotId: SLOT_S1 },
        },
      }),
    ).rejects.toThrow(/already been filled/);
    await asSuperuser(db);

    // Two Toedscruels, as before the attempt: the copy filling the line's Stage1 slot, and hers-in-hand
    // still in the haul with no placement at all.
    const cruel = await db.query<{ id: string; role: string; binder_id: string | null }>(
      `select id, role, binder_id from copy where catalog_card_id = 'toedscruel' order by id`,
    );
    expect(cruel.rows).toEqual([
      { id: OWNED_S1, role: "shelved", binder_id: KB1 },
      { id: DRAFT.id, role: "haul", binder_id: null },
    ]);
  });

  it("CONTROL — the same card and binder with a line choice the server accepts DOES land, so the refusal above is the rule and not a broken path", async () => {
    await asOwner(db);
    // The front half needs no line at all: the write path itself is healthy.
    const res = await commitCardPlacement(pgliteClient(db), {
      card: DRAFT,
      override: { kind: "shelf", binderId: KB1, half: "front", band: "orange" },
    });
    await asSuperuser(db);
    expect(res.counts.routed).toBe(1);
    const cruel = await db.query<{ binder_half: string; line_slot_id: string | null }>(
      `select binder_half, line_slot_id from copy
         where catalog_card_id = 'toedscruel' and id <> $1`,
      [OWNED_S1],
    );
    expect(cruel.rows[0]).toEqual({ binder_half: "front", line_slot_id: null });
    expect(await count(db, "evolution_line")).toBe(1); // no second line created
  });
});
