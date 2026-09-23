/**
 * UIL-096 — a second line for a species in the SAME binder and band is her call, not a refusal.
 *
 * Karvi, verbatim: "the Toedscruel issue is still there. I'm not able to create a new line for it. Instead
 * of blocking the creation of an evolution line, I want a warning that there is a line existing in my
 * ENTIRE collection (not just the binder)."
 *
 * Her state, exactly: an English Toedscool line in KB-001, Orange, with its Stage 1 already filled by a
 * Toedscruel. She is holding a second English Toedscruel. There is no slot for it to join, and until now
 * both write paths REFUSED a new line in that binder and band — the Plan's override
 * (`commitCardPlacement`) and the Lines screen's Move (`applyMove`) — so the back half had nowhere to take
 * it. That broke her standing rule that a card must always be movable.
 *
 * The warning itself is the Move panel's, pinned in move-panel-line-per-binder.dom.test.ts. These pin the
 * write half: both paths now create the second line, in that binder, and leave the first one alone.
 *
 * Real Postgres (PGlite), every migration, real `apply_write_ops`, as the authenticated owner.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { clearCatalogCache, commitCardPlacement, type DraftItem } from "@/lib/plan";
import { applyMove, loadMoveOptions, moveNameLookups } from "@/lib/line";
import type { MoveDestination } from "@/lib/line/types";
import { OWNER, asOwner, asSuperuser, count, freshRpcDb, seedBinders } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const KB1 = "b0000000-0000-0000-0000-0000000000e1";
const LINE = "10000000-0000-0000-0000-0000000000e1";
const SLOT_ROOT = "50000000-0000-0000-0000-0000000000e1";
const SLOT_S1 = "50000000-0000-0000-0000-0000000000e2";
const OWNED_ROOT = "c0000000-0000-0000-0000-0000000000e1";
const OWNED_S1 = "c0000000-0000-0000-0000-0000000000e2";
/** The second Toedscruel she is holding, already in the collection (the Lines-screen case). */
const LOOSE_CRUEL = "c0000000-0000-0000-0000-0000000000e3";

const ROOT_DEX = 9491;
const S1_DEX = 9492;
/** A uuid, because a typed row's id IS its copy id (UIL-092). */
const DRAFT: DraftItem = {
  id: "d0000000-0000-4000-8000-0000000000e1",
  tcgdexId: "toedscruel",
  variant: "normal",
};

/** Back half of KB-001, Orange — the binder and band that already hold her Toedscool line. */
const NEW_LINE_HERE: MoveDestination = {
  kind: "shelf",
  binderId: KB1,
  half: "back",
  band: "orange",
  lineJoin: { mode: "new" },
};

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
  await db.query(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
       values ($1, $2, 'toedscool', 'shelved', $3, 'back', 'orange'),
              ($4, $2, 'toedscruel', 'shelved', $3, 'back', 'orange'),
              ($5, $2, 'toedscruel', 'shelved', $3, 'front', 'orange')`,
    [OWNED_ROOT, OWNER, KB1, OWNED_S1, LOOSE_CRUEL],
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

async function linesInKb1() {
  await asSuperuser(db);
  const r = await db.query<{ id: string; binder_id: string; color_band: string; status: string }>(
    `select id, binder_id, color_band, status from evolution_line
       where binder_id = $1 order by created_at, id`,
    [KB1],
  );
  await asOwner(db);
  return r.rows;
}

/** The first line, exactly as seeded — a second line must not disturb it. */
async function firstLineUntouched() {
  await asSuperuser(db);
  const slots = await db.query<{ id: string; state: string; copy_id: string | null }>(
    `select id, state, copy_id from line_slot where line_id = $1 order by stage_index`,
    [LINE],
  );
  const line = await db.query<{ status: string }>(
    `select status from evolution_line where id = $1`,
    [LINE],
  );
  await asOwner(db);
  expect(line.rows[0].status).toBe("complete");
  expect(slots.rows).toEqual([
    { id: SLOT_ROOT, state: "filled", copy_id: OWNED_ROOT },
    { id: SLOT_S1, state: "filled", copy_id: OWNED_S1 },
  ]);
}

describe("UIL-096 · the Haul Plan override starts a second line in the same binder", () => {
  it("her Toedscruel lands in a NEW Orange line in KB-001 beside the first", async () => {
    // PRE-FIX this threw "That binder already has a line for this species in this band." and wrote nothing.
    await asOwner(db);
    const res = await commitCardPlacement(pgliteClient(db), {
      source: "bulk-bin",
      card: DRAFT,
      override: NEW_LINE_HERE,
    });
    expect(res.counts.lines).toBe(1);

    const lines = await linesInKb1();
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.color_band === "orange")).toBe(true);
    await firstLineUntouched();

    // And the card sits in the new line, not orphaned in the back half (UIL-056's strand).
    await asSuperuser(db);
    const cruel = await db.query<{ line_slot_id: string | null; binder_half: string }>(
      `select line_slot_id, binder_half from copy where id = $1`,
      [DRAFT.id],
    );
    expect(cruel.rows[0].binder_half).toBe("back");
    expect(cruel.rows[0].line_slot_id).not.toBeNull();
  });
});

describe("UIL-096 · the Lines screen's Move starts a second line in the same binder", () => {
  it("moving her loose Toedscruel into KB-001's back half as a new line succeeds", async () => {
    // PRE-FIX `applyMove` read every line for the species in that binder and band and threw
    // LINE_EXISTS_IN_BINDER when one matched the card's locale.
    const client = pgliteClient(db);
    await asOwner(db);
    const names = moveNameLookups(await loadMoveOptions(client));
    await applyMove(client, { copyId: LOOSE_CRUEL, destination: NEW_LINE_HERE }, names);

    const lines = await linesInKb1();
    expect(lines).toHaveLength(2);
    await firstLineUntouched();

    await asSuperuser(db);
    const moved = await db.query<{ binder_half: string; line_slot_id: string | null }>(
      `select binder_half, line_slot_id from copy where id = $1`,
      [LOOSE_CRUEL],
    );
    expect(moved.rows[0].binder_half).toBe("back");
    expect(moved.rows[0].line_slot_id).not.toBeNull();
    expect(await count(db, "evolution_line")).toBe(2);
  });
});
