/**
 * UIL-056 — a back-half destination resolves to a line, so a Basic (or any card) moved there can no
 * longer strand with `line_slot_id: null` the way it always used to. Two paths: join an existing
 * line's open slot, or start a new one — manual creation is allowed even below the engine's own
 * viability rule (>= 2 same-colour chain members), per Karvi's own UX tip ("the user must pick which
 * card it is entering a line with," not "only when the engine would have made one itself").
 *
 * Everything here runs the REAL modules against REAL Postgres (PGlite): the real 0001→0008
 * migrations (so `color_band`/`type_color_map` are the actual seeded config, not a guess), the real
 * `apply_write_ops` function, RLS on as `authenticated` — the pattern `move-into-collection.test.ts`
 * established for exactly this reason: a hand-rolled applier proves the ops match the author's
 * expectation and nothing about the function that runs in production (UIL-012 shipped through a
 * green suite exactly that way).
 *
 * The CONTROL below reproduces the reported bug verbatim — pre-fix, a Basic moved to the back half
 * has `line_slot_id: null` afterward — then every fixed path is asserted against the same query.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyMove, placementForMove, type MoveNameLookups } from "@/lib/line";
import type { WriteOp } from "@/lib/repo";
import {
  applyOps,
  asOwner,
  asSuperuser,
  freshRpcDb,
  OWNER,
  seedBinders,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const GEN = "b0000000-0000-0000-0000-0000000000e1";
/** A SECOND general binder — she is deliberately filling one (UIL-084). */
const GEN2 = "b0000000-0000-0000-0000-0000000000e9";
const CARD = "c0000000-0000-0000-0000-0000000000e1"; // the copy being moved
const OTHER = "c0000000-0000-0000-0000-0000000000e2"; // an existing owned copy of the sibling stage
const LINE = "10000000-0000-0000-0000-0000000000e1";
const SLOT_ROOT = "50000000-0000-0000-0000-0000000000e1";
const SLOT_NEXT = "50000000-0000-0000-0000-0000000000e2";

// A fictional two-stage Fire family — real dex accuracy is not the point, chain-walking is already
// covered by the engine's own worked examples (tests/engine/cascade.test.ts). "Fire" resolves to the
// real seeded "red" band (migration 0003), so this exercises production config, not a fixture map.
const EMBERLING_DEX = 9101;
const EMBERDRAKE_DEX = 9102;
const ONLYMON_DEX = 9201; // single-stage: nothing evolves from it, nothing it evolves from

const names: MoveNameLookups = {
  binderName: (id) => (id === GEN2 ? "Binder 2" : "Binder 1"),
  collectionName: () => null,
  bandDisplay: (key) => key.toUpperCase(),
};

let db: PGlite;
let binderSeeded = false;
beforeEach(async () => {
  db = await freshRpcDb();
  binderSeeded = false;
});
afterEach(async () => {
  await db.close();
});

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

interface CardFixture {
  id: string;
  name: string;
  dexId: number;
  stage: string;
  evolveFrom: string | null;
  /** Defaults to Fire — override to give a sibling stage a DIFFERENT natural band than the root's. */
  type?: string;
}

async function seedCard(c: CardFixture): Promise<void> {
  await db.query(
    `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from, card_class)
       values ($1, $2, $3, $6, $4, $5, 'standard')`,
    [c.id, c.name, [c.dexId], c.stage, c.evolveFrom, [c.type ?? "Fire"]],
  );
}

async function copyRow(id: string): Promise<{
  role: string;
  binder_id: string | null;
  binder_half: string | null;
  color_band: string | null;
  line_slot_id: string | null;
}> {
  return (
    await q(
      `select role, binder_id, binder_half, color_band, line_slot_id from copy where id = $1`,
      [id],
    )
  )[0] as never;
}

async function ensureBinder(): Promise<void> {
  if (binderSeeded) return;
  await seedBinders(db, [
    { id: GEN, type: "general", name: "Binder 1" },
    { id: GEN2, type: "general", name: "Binder 2" },
  ]);
  binderSeeded = true;
}

async function seedShelvedFront(cardId: string, catalogId: string): Promise<void> {
  await ensureBinder();
  await db.query(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
       values ($1, $2, $3, 'shelved', $4, 'front', 'red')`,
    [cardId, OWNER, catalogId, GEN],
  );
}

/* ============================ CONTROL: the pre-fix write ============================ */

describe("CONTROL — the pre-fix back-half move (no line resolved)", () => {
  it("strands the Basic exactly as reported: line_slot_id stays null", async () => {
    await seedCard({
      id: "onlymon",
      name: "Onlymon",
      dexId: ONLYMON_DEX,
      stage: "Basic",
      evolveFrom: null,
    });
    await seedShelvedFront(CARD, "onlymon");

    // EXACTLY what a back-half shelf destination did before this fix.
    const patch = placementForMove({ kind: "shelf", binderId: GEN, half: "back", band: "red" });
    await db.query(
      `update copy set role = $1, binder_id = $2, binder_half = $3, color_band = $4, line_slot_id = $5
         where id = $6`,
      [patch.role, patch.binder_id, patch.binder_half, patch.color_band, patch.line_slot_id, CARD],
    );

    const row = await copyRow(CARD);
    expect(row.binder_half).toBe("back");
    expect(row.line_slot_id).toBeNull(); // the strand this PR closes
  });
});

/* ==================== starting a new line (manual, below viability) ==================== */

describe("applyMove: shelf → back half → start a new line (real Postgres, real RPC)", () => {
  it("a single-stage Basic starts a one-slot line — allowed below the engine's own >= 2 threshold", async () => {
    await seedCard({
      id: "onlymon",
      name: "Onlymon",
      dexId: ONLYMON_DEX,
      stage: "Basic",
      evolveFrom: null,
    });
    await seedShelvedFront(CARD, "onlymon");
    await asOwner(db);

    await applyMove(
      pgliteClient(db),
      {
        copyId: CARD,
        destination: {
          kind: "shelf",
          binderId: GEN,
          half: "back",
          band: "red",
          lineJoin: { mode: "new" },
        },
      },
      names,
    );

    await asSuperuser(db);
    const row = await copyRow(CARD);
    expect(row.line_slot_id).not.toBeNull(); // the assertion the assignment is pinned on

    const lines = await q<{ root_dex_id: number; color_band: string; status: string }>(
      `select root_dex_id, color_band, status from evolution_line`,
    );
    expect(lines).toEqual([{ root_dex_id: ONLYMON_DEX, color_band: "red", status: "complete" }]);

    const slots = await q<{ stage_index: number; state: string; copy_id: string | null }>(
      `select stage_index, state, copy_id from line_slot order by stage_index`,
    );
    expect(slots).toEqual([{ stage_index: 0, state: "filled", copy_id: CARD }]);
  });

  it("a two-stage family gets a placeholder for the sibling stage it does not own", async () => {
    await seedCard({
      id: "emberling",
      name: "Emberling",
      dexId: EMBERLING_DEX,
      stage: "Basic",
      evolveFrom: null,
    });
    await seedCard({
      id: "emberdrake",
      name: "Emberdrake",
      dexId: EMBERDRAKE_DEX,
      stage: "Stage1",
      evolveFrom: "Emberling",
    });
    await seedShelvedFront(CARD, "emberling");
    await asOwner(db);

    await applyMove(
      pgliteClient(db),
      {
        copyId: CARD,
        destination: {
          kind: "shelf",
          binderId: GEN,
          half: "back",
          band: "red",
          lineJoin: { mode: "new" },
        },
      },
      names,
    );

    await asSuperuser(db);
    const line = (
      await q<{ id: string; status: string }>(`select id, status from evolution_line`)
    )[0];
    expect(line.status).toBe("open"); // one stage still a placeholder

    const slots = await q<{
      stage_index: number;
      state: string;
      copy_id: string | null;
      target_catalog_card_id: string | null;
    }>(
      `select stage_index, state, copy_id, target_catalog_card_id from line_slot order by stage_index`,
    );
    expect(slots).toEqual([
      // A filled slot's target is the incoming card's own printing (generateSlots' record of what
      // fills it), not null — corrected here after the first assertion assumed otherwise.
      { stage_index: 0, state: "filled", copy_id: CARD, target_catalog_card_id: "emberling" },
      { stage_index: 1, state: "placeholder", copy_id: null, target_catalog_card_id: "emberdrake" },
    ]);
    expect((await copyRow(CARD)).line_slot_id).not.toBeNull();
  });

  it("STARTS a second line when one for this species + band already exists in the same binder (UIL-096)", async () => {
    // Was a refusal (UIL-084's per-binder rule). Karvi overruled the rule itself: "Instead of blocking the
    // creation of an evolution line, I want a warning". The warning is the Move panel's; this pins that the
    // write now honours her explicit choice.
    await seedCard({
      id: "onlymon",
      name: "Onlymon",
      dexId: ONLYMON_DEX,
      stage: "Basic",
      evolveFrom: null,
    });
    await seedShelvedFront(CARD, "onlymon");
    await seedShelvedFront(OTHER, "onlymon");
    await db.exec(`
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
        values ('${LINE}', '${OWNER}', ${ONLYMON_DEX}, 'red', '${GEN}', 'back', 'complete');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
        values ('${SLOT_ROOT}', '${OWNER}', '${LINE}', 0, 'Basic', 'filled', '${OTHER}');
      update copy set line_slot_id = '${SLOT_ROOT}', binder_half = 'back' where id = '${OTHER}';
    `);
    await asOwner(db);

    await applyMove(
      pgliteClient(db),
      {
        copyId: CARD,
        destination: {
          kind: "shelf",
          binderId: GEN,
          half: "back",
          band: "red",
          lineJoin: { mode: "new" },
        },
      },
      names,
    );

    await asSuperuser(db);
    expect(await q(`select 1 from evolution_line`)).toHaveLength(2); // the second line, beside the first
    expect((await copyRow(CARD)).line_slot_id).not.toBeNull(); // and the card sits in it
  });

  it("ALLOWS that same species and band in a DIFFERENT binder — one line per species per band per BINDER (UIL-084)", async () => {
    // Her report: an Orange Toedscool line lived in KB-001 with her stage already filled, and she was
    // filling KB-002 by hand. Every back-half destination in KB-002 was refused, because the key
    // ignored the binder — and the refusal's remedy ("join it instead") named a slot that did not
    // exist. Pre-fix this throws; the copy never lands anywhere.
    await seedCard({
      id: "onlymon",
      name: "Onlymon",
      dexId: ONLYMON_DEX,
      stage: "Basic",
      evolveFrom: null,
    });
    await seedShelvedFront(CARD, "onlymon");
    await seedShelvedFront(OTHER, "onlymon");
    await db.exec(`
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
        values ('${LINE}', '${OWNER}', ${ONLYMON_DEX}, 'red', '${GEN}', 'back', 'complete');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
        values ('${SLOT_ROOT}', '${OWNER}', '${LINE}', 0, 'Basic', 'filled', '${OTHER}');
      update copy set line_slot_id = '${SLOT_ROOT}', binder_half = 'back' where id = '${OTHER}';
    `);
    await asOwner(db);

    await applyMove(
      pgliteClient(db),
      {
        copyId: CARD,
        destination: {
          kind: "shelf",
          binderId: GEN2,
          half: "back",
          band: "red",
          lineJoin: { mode: "new" },
        },
      },
      names,
    );

    await asSuperuser(db);
    // Two lines now: the original in Binder 1, and hers in Binder 2, same species and band.
    const lines = await q<{ binder_id: string; root_dex_id: number; color_band: string }>(
      `select binder_id, root_dex_id, color_band from evolution_line order by created_at`,
    );
    expect(lines).toEqual([
      { binder_id: GEN, root_dex_id: ONLYMON_DEX, color_band: "red" },
      { binder_id: GEN2, root_dex_id: ONLYMON_DEX, color_band: "red" },
    ]);
    // And the card actually LANDED — in Binder 2's back half, filling its own new line's slot.
    const moved = await copyRow(CARD);
    expect(moved.binder_id).toBe(GEN2);
    expect(moved.binder_half).toBe("back");
    expect(moved.color_band).toBe("red");
    expect(moved.line_slot_id).not.toBeNull();
    // The original line is untouched: its slot still holds the copy it always held.
    const rootSlot = await q<{ copy_id: string }>(
      `select copy_id from line_slot where id = '${SLOT_ROOT}'`,
    );
    expect(rootSlot[0].copy_id).toBe(OTHER);
  });

  it("a Stage1 starting a second line roots it at the CHAIN'S root, not its own dexId (UIL-096)", async () => {
    // This used to pin that the REFUSAL keyed on the chain root: a second Emberdrake (9102) had to find
    // the existing Emberling (9101) line. The refusal is gone (UIL-096), but the chain-root question did
    // not go with it — a new line started by a Stage1 must be rooted at its Basic, or the two Emberling
    // lines would not even read as the same family, and the warning keyed on the root would miss them.
    const THIRD = "c0000000-0000-0000-0000-0000000000e3";
    await seedCard({
      id: "emberling",
      name: "Emberling",
      dexId: EMBERLING_DEX,
      stage: "Basic",
      evolveFrom: null,
    });
    await seedCard({
      id: "emberdrake",
      name: "Emberdrake",
      dexId: EMBERDRAKE_DEX,
      stage: "Stage1",
      evolveFrom: "Emberling",
    });
    await seedShelvedFront(OTHER, "emberling");
    await seedShelvedFront(THIRD, "emberdrake");
    await seedShelvedFront(CARD, "emberdrake"); // the SECOND Emberdrake being moved
    await db.exec(`
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
        values ('${LINE}', '${OWNER}', ${EMBERLING_DEX}, 'red', '${GEN}', 'back', 'complete');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
        values ('${SLOT_ROOT}', '${OWNER}', '${LINE}', 0, 'Basic', 'filled', '${OTHER}');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
        values ('${SLOT_NEXT}', '${OWNER}', '${LINE}', 1, 'Stage1', 'filled', '${THIRD}');
      update copy set line_slot_id = '${SLOT_ROOT}', binder_half = 'back' where id = '${OTHER}';
      update copy set line_slot_id = '${SLOT_NEXT}', binder_half = 'back' where id = '${THIRD}';
    `);
    await asOwner(db);

    await applyMove(
      pgliteClient(db),
      {
        copyId: CARD,
        destination: {
          kind: "shelf",
          binderId: GEN,
          half: "back",
          band: "red",
          lineJoin: { mode: "new" },
        },
      },
      names,
    );

    await asSuperuser(db);
    const roots = await q(`select root_dex_id from evolution_line order by created_at, id`);
    expect(roots).toHaveLength(2);
    // Both rooted at Emberling — one family, two lines — never at the moved Emberdrake's own dexId.
    expect(roots.every((r) => (r as { root_dex_id: number }).root_dex_id === EMBERLING_DEX)).toBe(
      true,
    );
    expect((await copyRow(CARD)).line_slot_id).not.toBeNull();
  });

  it("creates the line in HER chosen band, not the card's own natural type-band", async () => {
    // Onlymon is Fire (natural band "red"), but she picks "green" — coarse location is her call
    // (system-design §12); the line, and every slot's band-matching, must follow that choice.
    await seedCard({
      id: "onlymon",
      name: "Onlymon",
      dexId: ONLYMON_DEX,
      stage: "Basic",
      evolveFrom: null,
    });
    await seedShelvedFront(CARD, "onlymon");
    await asOwner(db);

    await applyMove(
      pgliteClient(db),
      {
        copyId: CARD,
        destination: {
          kind: "shelf",
          binderId: GEN,
          half: "back",
          band: "green",
          lineJoin: { mode: "new" },
        },
      },
      names,
    );

    await asSuperuser(db);
    expect(
      (await q<{ color_band: string }>(`select color_band from evolution_line`))[0].color_band,
    ).toBe("green");
    expect((await copyRow(CARD)).color_band).toBe("green");
  });

  it("the destinationBand override reaches slot generation too, not just insert_line's own column", async () => {
    // Emberling (root, Fire → natural band "red") evolves into Emberdrake, whose OWN catalog
    // printing is Water-typed (→ "light_blue"), not Fire. She picks "light_blue" as the destination.
    // If the override only reached insert_line's column (a mutant this test is built to catch), the
    // sibling's same-colour check would still run against Emberling's natural "red" and find no
    // Emberdrake printing there — a BLOCK. With the override honoured everywhere, it finds
    // Emberdrake's Water/light_blue printing — a PLACEHOLDER instead.
    await seedCard({
      id: "emberling",
      name: "Emberling",
      dexId: EMBERLING_DEX,
      stage: "Basic",
      evolveFrom: null,
      type: "Fire",
    });
    await seedCard({
      id: "emberdrake",
      name: "Emberdrake",
      dexId: EMBERDRAKE_DEX,
      stage: "Stage1",
      evolveFrom: "Emberling",
      type: "Water",
    });
    await seedShelvedFront(CARD, "emberling");
    await asOwner(db);

    await applyMove(
      pgliteClient(db),
      {
        copyId: CARD,
        destination: {
          kind: "shelf",
          binderId: GEN,
          half: "back",
          band: "light_blue",
          lineJoin: { mode: "new" },
        },
      },
      names,
    );

    await asSuperuser(db);
    const slots = await q<{ stage_index: number; state: string }>(
      `select stage_index, state from line_slot order by stage_index`,
    );
    expect(slots).toEqual([
      { stage_index: 0, state: "filled" },
      { stage_index: 1, state: "placeholder" }, // NOT "block" — the mutant this test kills
    ]);
  });
});

/* ==================== joining an existing line's open slot ==================== */

describe("applyMove: shelf → back half → join an existing line's open slot", () => {
  async function seedOpenLine(): Promise<void> {
    await seedCard({
      id: "emberling",
      name: "Emberling",
      dexId: EMBERLING_DEX,
      stage: "Basic",
      evolveFrom: null,
    });
    await seedCard({
      id: "emberdrake",
      name: "Emberdrake",
      dexId: EMBERDRAKE_DEX,
      stage: "Stage1",
      evolveFrom: "Emberling",
    });
    await seedShelvedFront(OTHER, "emberling");
    await seedShelvedFront(CARD, "emberdrake");
    await db.exec(`
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
        values ('${LINE}', '${OWNER}', ${EMBERLING_DEX}, 'red', '${GEN}', 'back', 'open');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
        values ('${SLOT_ROOT}', '${OWNER}', '${LINE}', 0, 'Basic', 'filled', '${OTHER}');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, target_catalog_card_id)
        values ('${SLOT_NEXT}', '${OWNER}', '${LINE}', 1, 'Stage1', 'placeholder', 'emberdrake');
      update copy set line_slot_id = '${SLOT_ROOT}', binder_half = 'back' where id = '${OTHER}';
    `);
  }

  it("fills the placeholder and completes the line when it was the last open stage", async () => {
    await seedOpenLine();
    await asOwner(db);

    await applyMove(
      pgliteClient(db),
      {
        copyId: CARD,
        destination: {
          kind: "shelf",
          binderId: GEN,
          half: "back",
          band: "red",
          lineJoin: { mode: "existing", lineId: LINE, slotId: SLOT_NEXT },
        },
      },
      names,
    );

    await asSuperuser(db);
    expect(await copyRow(CARD)).toMatchObject({ binder_half: "back", line_slot_id: SLOT_NEXT });
    expect(
      (
        await q<{ state: string; copy_id: string | null }>(
          `select state, copy_id from line_slot where id = '${SLOT_NEXT}'`,
        )
      )[0],
    ).toEqual({ state: "filled", copy_id: CARD });
    expect(
      (await q<{ status: string }>(`select status from evolution_line where id = '${LINE}'`))[0]
        .status,
    ).toBe("complete");
  });

  it("does NOT complete the line when another slot is still open", async () => {
    await seedOpenLine();
    // A third, still-open stage on the same line.
    await db.exec(`
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state)
        values ('50000000-0000-0000-0000-0000000000e3', '${OWNER}', '${LINE}', 2, 'Stage2', 'placeholder');
    `);
    await asOwner(db);

    await applyMove(
      pgliteClient(db),
      {
        copyId: CARD,
        destination: {
          kind: "shelf",
          binderId: GEN,
          half: "back",
          band: "red",
          lineJoin: { mode: "existing", lineId: LINE, slotId: SLOT_NEXT },
        },
      },
      names,
    );

    await asSuperuser(db);
    // The fill itself, not just the line status staying "open" — that alone would also be true if
    // this move had touched no line_slot row at all, which is exactly the pre-fix behaviour.
    expect(
      (
        await q<{ state: string; copy_id: string | null }>(
          `select state, copy_id from line_slot where id = '${SLOT_NEXT}'`,
        )
      )[0],
    ).toEqual({ state: "filled", copy_id: CARD });
    expect(
      (await q<{ status: string }>(`select status from evolution_line where id = '${LINE}'`))[0]
        .status,
    ).toBe("open");
  });

  it("REFUSES a slot that has already been filled by someone else", async () => {
    await seedOpenLine();
    await db.exec(
      `update line_slot set state = 'filled', copy_id = '${OTHER}' where id = '${SLOT_NEXT}'`,
    );
    await asOwner(db);

    await expect(
      applyMove(
        pgliteClient(db),
        {
          copyId: CARD,
          destination: {
            kind: "shelf",
            binderId: GEN,
            half: "back",
            band: "red",
            lineJoin: { mode: "existing", lineId: LINE, slotId: SLOT_NEXT },
          },
        },
        names,
      ),
    ).rejects.toThrow(/already been filled/i);
  });
});

/* ============================== atomicity (UIL-023's rule extended) ============================== */

describe("a line-join move cannot half-apply", () => {
  // NOTE: this checks `apply_write_ops`'s pre-existing atomicity guarantee for a NEW combination
  // (insert_line + insert_slot ahead of the copy's own update_copy) rather than `buildMoveOps`'s
  // wiring — the ops below are literal, not built via `buildMoveOps`, deliberately: an object
  // literal missing a field it did not ask for would not fail at test-runtime the way it fails
  // `tsc`, so passing through `buildMoveOps` here would not actually prove this rolls back pre-fix.
  // The six tests above, which call the real `applyMove` end to end, are what the assignment's
  // pre-fix-failing bar is pinned on.
  it("a poison op mid-batch rolls back the WHOLE thing — the new line, its slots, and the placement", async () => {
    await seedCard({
      id: "onlymon",
      name: "Onlymon",
      dexId: ONLYMON_DEX,
      stage: "Basic",
      evolveFrom: null,
    });
    await seedShelvedFront(CARD, "onlymon");
    await asOwner(db);

    const ops: WriteOp[] = [
      {
        op: "insert_line",
        id: LINE,
        root_dex_id: ONLYMON_DEX,
        color_band: "red",
        binder_id: GEN,
        half: "back",
        status: "complete",
      },
      {
        op: "insert_slot",
        id: SLOT_ROOT,
        line_id: LINE,
        stage_index: 0,
        stage: "Basic",
        state: "filled",
        copy_id: CARD,
        target_catalog_card_id: null,
        note: null,
      },
      {
        op: "update_copy",
        id: CARD,
        patch: {
          role: "shelved",
          binder_id: GEN,
          binder_half: "back",
          color_band: "red",
          line_slot_id: SLOT_ROOT,
        },
      },
      {
        op: "insert_copy",
        presence_group_id: "00000000-0000-4000-8000-00000000900d",
        id: crypto.randomUUID(),
        catalog_card_id: "ghost",
        role: "bulk",
      }, // poison
    ];
    await expect(applyOps(db, { ops })).rejects.toThrow();

    await asSuperuser(db);
    expect(await q(`select 1 from evolution_line`)).toHaveLength(0);
    expect(await q(`select 1 from line_slot`)).toHaveLength(0);
    expect((await copyRow(CARD)).line_slot_id).toBeNull();
    expect((await copyRow(CARD)).binder_half).toBe("front");
  });
});

/* ================ moving OFF a line into bulk / front-half shelf releases the slot ================
 * Prompted by live data on Testing showing filled line_slot rows whose copy has since moved
 * (18 filled slots, only 13 copies claiming one — a broken bidirectional link). `reopenSlotId` in
 * applyMove is computed from the copy's CURRENT line_slot_id independent of the destination kind, so
 * bulk/front-half-shelf SHOULD release the old slot the same way collection already does — verified
 * here rather than just re-read, since move-into-collection.test.ts only covered bulk/shelf for the
 * chase-list side, never for slot release specifically. */
describe("applyMove: moving OFF a line into bulk or a front-half shelf releases the old slot", () => {
  async function seedCardFillingASlot(): Promise<void> {
    await seedCard({
      id: "emberling",
      name: "Emberling",
      dexId: EMBERLING_DEX,
      stage: "Basic",
      evolveFrom: null,
    });
    await seedCard({
      id: "emberdrake",
      name: "Emberdrake",
      dexId: EMBERDRAKE_DEX,
      stage: "Stage1",
      evolveFrom: "Emberling",
    });
    await seedShelvedFront(OTHER, "emberling");
    await seedShelvedFront(CARD, "emberdrake");
    await db.exec(`
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
        values ('${LINE}', '${OWNER}', ${EMBERLING_DEX}, 'red', '${GEN}', 'back', 'complete');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
        values ('${SLOT_ROOT}', '${OWNER}', '${LINE}', 0, 'Basic', 'filled', '${OTHER}');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
        values ('${SLOT_NEXT}', '${OWNER}', '${LINE}', 1, 'Stage1', 'filled', '${CARD}');
      update copy set line_slot_id = '${SLOT_ROOT}', binder_half = 'back' where id = '${OTHER}';
      update copy set line_slot_id = '${SLOT_NEXT}', binder_half = 'back' where id = '${CARD}';
    `);
  }

  it("releases the old slot and demotes the line when the destination is bulk", async () => {
    await seedCardFillingASlot();
    await asOwner(db);

    await applyMove(pgliteClient(db), { copyId: CARD, destination: { kind: "bulk" } }, names);

    await asSuperuser(db);
    expect(await copyRow(CARD)).toMatchObject({ role: "bulk", line_slot_id: null });
    expect(
      (
        await q<{ state: string; copy_id: string | null }>(
          `select state, copy_id from line_slot where id = '${SLOT_NEXT}'`,
        )
      )[0],
    ).toEqual({ state: "placeholder", copy_id: null });
    expect(
      (await q<{ status: string }>(`select status from evolution_line where id = '${LINE}'`))[0]
        .status,
    ).toBe("open"); // was "complete"; losing this slot's filled member demotes it
  });

  it("releases the old slot when the destination is a front-half shelf (no line concept there)", async () => {
    await seedCardFillingASlot();
    await asOwner(db);

    await applyMove(
      pgliteClient(db),
      {
        copyId: CARD,
        destination: { kind: "shelf", binderId: GEN, half: "front", band: "red" },
      },
      names,
    );

    await asSuperuser(db);
    expect(await copyRow(CARD)).toMatchObject({ binder_half: "front", line_slot_id: null });
    expect(
      (
        await q<{ state: string; copy_id: string | null }>(
          `select state, copy_id from line_slot where id = '${SLOT_NEXT}'`,
        )
      )[0],
    ).toEqual({ state: "placeholder", copy_id: null });
  });
});

/* ============ server-side enforcement: a back-half move needs a line even off-panel ============ */

describe("applyMove REFUSES a back-half shelf with no lineJoin, server-side", () => {
  it("throws rather than silently stranding the copy with line_slot_id: null", async () => {
    await seedCard({
      id: "onlymon",
      name: "Onlymon",
      dexId: ONLYMON_DEX,
      stage: "Basic",
      evolveFrom: null,
    });
    await seedShelvedFront(CARD, "onlymon");
    await asOwner(db);

    await expect(
      applyMove(
        pgliteClient(db),
        {
          copyId: CARD,
          // No `lineJoin` — exactly what a pre-UIL-056 client, or any caller that bypasses the
          // panel's Confirm gate, would still send.
          destination: { kind: "shelf", binderId: GEN, half: "back", band: "red" },
        },
        names,
      ),
    ).rejects.toThrow(/incomplete/i);

    await asSuperuser(db);
    // Nothing moved — the same "refuse before any write" pattern assertCollectionDestinationLives
    // already uses for a stale collection destination.
    expect(await copyRow(CARD)).toMatchObject({ binder_half: "front", line_slot_id: null });
  });
});
