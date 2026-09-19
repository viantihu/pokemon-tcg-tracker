/**
 * UIL-070 part 1, write half — a back-half override from the Haul Plan now WRITES the line she picked.
 *
 * Before this, `writeOverriddenCard` dropped `lineJoin` on the floor (`placementForMove` nulls
 * `line_slot_id` for every kind), and `commitCardPlacement` never refused a bare back-half shelf the
 * way `applyMove` does — so a stale Plan client could write exactly UIL-056's strand: a back-half copy
 * with no line. Both are closed here, through the REAL `commitCardPlacement` against the REAL
 * `apply_write_ops` on real Postgres (PGlite), reusing `applyMove`'s builders and its exact refusal
 * wording so joining a line means one thing whichever screen she did it from.
 *
 * The pre-fix-failing case is "REFUSES a bare back-half shelf": develop writes the strand.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { clearCatalogCache, commitCardPlacement, type DraftItem } from "@/lib/plan";
import type { MoveDestination } from "@/lib/line/types";
import { OWNER, asOwner, asSuperuser, freshRpcDb, seedBinders } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const GEN = "b0000000-0000-0000-0000-0000000000b1";
const LINE = "10000000-0000-0000-0000-0000000000b1";
const SLOT_ROOT = "50000000-0000-0000-0000-0000000000b1";
const SLOT_NEXT = "50000000-0000-0000-0000-0000000000b2";
const OWNED_EMBERLING = "c0000000-0000-0000-0000-0000000000b1";
const OTHER_DRAKE = "c0000000-0000-0000-0000-0000000000b2";
const PENDING_DRAKE = "c0000000-0000-0000-0000-0000000000b3"; // a synced, unplaced copy to ROUTE

const EMBERLING_DEX = 9601;
const EMBERDRAKE_DEX = 9602;

const DRAFT: DraftItem = { id: "d-drake", tcgdexId: "emberdrake", variant: "normal" };
const BACK_RED = { kind: "shelf", binderId: GEN, half: "back", band: "red" } as const;

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  clearCatalogCache();
  await seedBinders(db, [{ id: GEN, type: "general", name: "Binder 1" }]);
  for (const [id, name, dex, stage, from] of [
    ["emberling", "Emberling", EMBERLING_DEX, "Basic", null],
    ["emberdrake", "Emberdrake", EMBERDRAKE_DEX, "Stage1", "Emberling"],
  ] as const) {
    await db.query(
      `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from, card_class)
         values ($1, $2, $3, '{Fire}', $4, $5, 'standard')`,
      [id, name, [dex], stage, from],
    );
  }
});
afterEach(async () => {
  await db.close();
});

/** A red Emberling line: root filled, Emberdrake's stage open — the line the picker would offer. */
async function seedOpenLine(): Promise<void> {
  await db.query(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
       values ($1, $2, 'emberling', 'shelved', $3, 'back', 'red')`,
    [OWNED_EMBERLING, OWNER, GEN],
  );
  await db.exec(`
    insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
      values ('${LINE}', '${OWNER}', ${EMBERLING_DEX}, 'red', '${GEN}', 'back', 'open');
    insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
      values ('${SLOT_ROOT}', '${OWNER}', '${LINE}', 0, 'Basic', 'filled', '${OWNED_EMBERLING}');
    insert into line_slot (id, owner_id, line_id, stage_index, stage, state, target_catalog_card_id)
      values ('${SLOT_NEXT}', '${OWNER}', '${LINE}', 1, 'Stage1', 'placeholder', 'emberdrake');
    update copy set line_slot_id = '${SLOT_ROOT}' where id = '${OWNED_EMBERLING}';
  `);
}

async function commit(override: MoveDestination, card: DraftItem = DRAFT) {
  await asOwner(db);
  try {
    return await commitCardPlacement(pgliteClient(db), { source: "bulk-bin", card, override });
  } finally {
    await asSuperuser(db);
  }
}

async function drakeCopies() {
  return (
    await db.query<{
      id: string;
      role: string;
      binder_id: string | null;
      binder_half: string | null;
      color_band: string | null;
      line_slot_id: string | null;
    }>(
      `select id, role, binder_id, binder_half, color_band, line_slot_id from copy
         where catalog_card_id = 'emberdrake' order by created_at`,
    )
  ).rows;
}
async function slot(id: string) {
  return (
    await db.query<{ state: string; copy_id: string | null }>(
      `select state, copy_id from line_slot where id = $1`,
      [id],
    )
  ).rows[0];
}
async function lines() {
  return (
    await db.query<{ id: string; root_dex_id: number; color_band: string; status: string }>(
      `select id, root_dex_id, color_band, status from evolution_line order by created_at`,
    )
  ).rows;
}

describe("UIL-070 part 1 · joining an EXISTING line's open slot from the Haul Plan", () => {
  it("fills the picked slot with the new copy, points the copy at it, and completes the line", async () => {
    await seedOpenLine();
    await commit({ ...BACK_RED, lineJoin: { mode: "existing", lineId: LINE, slotId: SLOT_NEXT } });

    const [copy] = await drakeCopies();
    expect(copy).toMatchObject({
      role: "shelved",
      binder_id: GEN,
      binder_half: "back",
      color_band: "red",
      line_slot_id: SLOT_NEXT, // the assertion the write half is pinned on
    });
    expect(await slot(SLOT_NEXT)).toEqual({ state: "filled", copy_id: copy.id });
    // Stage1 was the last open stage, so the line is complete — buildExistingLineJoinOps' rule.
    expect((await lines())[0].status).toBe("complete");
    // The audit row still names it as her override.
    const decision = (
      await db.query<{ decision: string }>(
        `select decision from placement_decision where copy_id = $1`,
        [copy.id],
      )
    ).rows[0];
    expect(decision.decision).toBe("placement-override");
  });

  it("routes a synced, unplaced copy into the slot the same way (update_copy, not insert_copy)", async () => {
    await seedOpenLine();
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, role) values ($1, $2, 'emberdrake', 'bulk')`,
      [PENDING_DRAKE, OWNER],
    );
    await commit(
      { ...BACK_RED, lineJoin: { mode: "existing", lineId: LINE, slotId: SLOT_NEXT } },
      { ...DRAFT, existingCopyId: PENDING_DRAKE },
    );
    const copies = await drakeCopies();
    expect(copies).toHaveLength(1); // routed, not duplicated (UIL-003)
    expect(copies[0]).toMatchObject({
      id: PENDING_DRAKE,
      binder_half: "back",
      line_slot_id: SLOT_NEXT,
    });
    expect(await slot(SLOT_NEXT)).toEqual({ state: "filled", copy_id: PENDING_DRAKE });
  });

  it("REFUSES a slot that has already been filled, in applyMove's words, and writes nothing", async () => {
    await seedOpenLine();
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band, line_slot_id)
         values ($1, $2, 'emberdrake', 'shelved', $3, 'back', 'red', $4)`,
      [OTHER_DRAKE, OWNER, GEN, SLOT_NEXT],
    );
    await db.query(`update line_slot set state = 'filled', copy_id = $1 where id = $2`, [
      OTHER_DRAKE,
      SLOT_NEXT,
    ]);
    await expect(
      commit({ ...BACK_RED, lineJoin: { mode: "existing", lineId: LINE, slotId: SLOT_NEXT } }),
    ).rejects.toThrow("That slot has already been filled — reload the screen and pick again.");
    expect(await drakeCopies()).toHaveLength(1); // only the pre-existing one
  });

  it("REFUSES a slot that is not in that line, in applyMove's words", async () => {
    await seedOpenLine();
    await expect(
      commit({
        ...BACK_RED,
        lineJoin: {
          mode: "existing",
          lineId: LINE,
          slotId: "50000000-0000-0000-0000-0000000000ff",
        },
      }),
    ).rejects.toThrow("That line slot no longer exists — reload the screen and pick again.");
    expect(await drakeCopies()).toHaveLength(0);
  });
});

describe("UIL-070 part 1 · starting a NEW line from the Haul Plan", () => {
  it("creates the line and its slots around the new copy, in the band she picked", async () => {
    await commit({ ...BACK_RED, lineJoin: { mode: "new" } });

    const [line] = await lines();
    expect(line).toMatchObject({ root_dex_id: EMBERLING_DEX, color_band: "red" });
    const slots = (
      await db.query<{ stage_index: number; stage: string; state: string; copy_id: string | null }>(
        `select stage_index, stage, state, copy_id from line_slot where line_id = $1 order by stage_index`,
        [line.id],
      )
    ).rows;
    const [copy] = await drakeCopies();
    // Emberling exists in red → its stage is a placeholder; the incoming Emberdrake fills its own.
    expect(slots).toEqual([
      { stage_index: 0, stage: "Basic", state: "placeholder", copy_id: null },
      { stage_index: 1, stage: "Stage1", state: "filled", copy_id: copy.id },
    ]);
    expect(copy).toMatchObject({ binder_half: "back", color_band: "red" });
    expect(copy.line_slot_id).not.toBeNull();
    expect(await slot(copy.line_slot_id!)).toEqual({ state: "filled", copy_id: copy.id });
  });

  it("a band that differs from the card's own is HER choice in the picker: no UIL-069 ask, line in green", async () => {
    await commit({ ...BACK_RED, band: "green", lineJoin: { mode: "new" } });
    const [line] = await lines();
    expect(line.color_band).toBe("green");
    const [copy] = await drakeCopies();
    expect(copy).toMatchObject({ binder_half: "back", color_band: "green" });
    expect(copy.line_slot_id).not.toBeNull();
  });

  it("REFUSES a new line when one for this species and band already exists, in applyMove's words", async () => {
    await seedOpenLine(); // a red Emberling line exists, with Emberdrake's own slot OPEN
    await expect(commit({ ...BACK_RED, lineJoin: { mode: "new" } })).rejects.toThrow(
      "A line for this species and band already exists — reload the screen and join it instead.",
    );
    expect(await lines()).toHaveLength(1);
    expect(await drakeCopies()).toHaveLength(0);
  });
});

describe("UIL-070 part 1 · the server refuses what the panel disables", () => {
  it("REFUSES a bare back-half shelf (no line picked) instead of writing UIL-056's strand", async () => {
    // PRE-FIX-FAILING: develop wrote a back-half copy with line_slot_id null here.
    await expect(commit(BACK_RED)).rejects.toThrow(
      "That destination is incomplete — reload the screen and pick again.",
    );
    expect(await drakeCopies()).toHaveLength(0);
    expect(await lines()).toHaveLength(0);
  });

  it("still writes a FRONT-half override exactly as before — no line, no refusal", async () => {
    await commit({ ...BACK_RED, half: "front" });
    const [copy] = await drakeCopies();
    expect(copy).toMatchObject({ binder_half: "front", color_band: "red", line_slot_id: null });
  });
});
