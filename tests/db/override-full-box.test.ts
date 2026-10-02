/**
 * 0037 — a FULL bulk box she picks anyway. Karvi, 2026-10-01/02: "The rules should exist only for the recommendation
 * engine. Users should always be able to override all rules." The app recommends a box with room, warns in her words,
 * and lets her put the card in a full box anyway (`{ kind: "bulk", unitId, overFull: true }`). The database lets a
 * full box take a card only when the write declares `bulk_box_full` AND one of its decisions records it.
 *
 * For every writer that sends a card to a box she picked (followed from a bulk destination to `bulk_unit_id`):
 *   - with her override the card lands, the box goes over its limit, and that writer's decision records it;
 *   - without it, the full box still refuses in her words, and nothing moves.
 *
 *   1. A Move (applyMove / buildMoveOps).
 *   2. The Haul Plan: her Move on a card waiting in her haul (writeOverriddenCard), the card a holo swaps out when
 *      every box is full (writeCard, the Tech Lead's "no dead ends"), and her Move into a line from the plan whose card
 *      coming out goes to bulk (commitLineChoice).
 *   3. A line Replace: the card coming out (replaceInLine).
 *   4. An Add into a stage a spare card fills: the spare going back (fillerOutOps).
 *   5. Lines' Choose: a spare taken out of its pocket (decide-stages' toBulk).
 *   6. A card removed from a collection to bulk (lib/coll/remove.ts).
 *   7. Settings: a box deleted into one without room for its cards ("Delete anyway").
 *
 * Real Postgres (PGlite, every migration), the real writers and `apply_write_ops`, as the authenticated owner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyMove, type MoveNameLookups } from "@/lib/line";
import { applyStageDecisions } from "@/lib/line/write";
import { applyCollectionRemoval } from "@/lib/coll/remove";
import { clearCatalogCache, commitCardPlacement, deriveSpotlightPlacement } from "@/lib/plan";
import { deleteBoxWrite } from "@/lib/plan/bulk-units";
import { applyWriteOps, bulkUnitRepo } from "@/lib/repo";
import { CHARMANDER_SV03_026 } from "../engine/fixtures";
import {
  asOwner,
  asSuperuser,
  freshRpcDb,
  haulRow,
  OWNER,
  seedBinders,
  seedCatalogCardsFull,
  seedCollections,
  seedHaulRows,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";
import { shelveCardAction } from "@/app/(ui)/plan/actions";

// The action's owner seam needs a real request; hand it the PGlite client instead (as tests/plan/line-done.test.ts).
vi.mock("@/lib/plan/session", () => ({
  getOwnerContext: async () => ({ db: pgliteClient(db), ownerId: OWNER }),
}));

const GEN = "b0000000-0000-4000-8000-000000000137";
const LINE = "10000000-0000-4000-8000-000000000137";
const S = (n: number) => `20000000-0000-4000-8000-00000000137${n}`;
const C = (n: number) => `c0000000-0000-4000-8000-0000000013${String(n).padStart(2, "0")}`;
const BOX = (n: number) => `d0000000-0000-4000-8000-00000000137${n}`;
/** Box B has room for one card, and holds one: full. */
const FULL_B = "Your Box B is full. Pick another box.";
const OVER = { kind: "bulk", unitId: BOX(2), overFull: true } as const;
const PLAIN = { kind: "bulk", unitId: BOX(2) } as const;
const names: MoveNameLookups = {
  binderName: () => "KB-001",
  collectionName: () => null,
  bandDisplay: (k) => k,
  bulkBoxName: (id) => (id === BOX(2) ? "Box B" : "Bulk box"),
};

let db: PGlite;
afterEach(async () => {
  if (db && !db.closed) await db.close();
});
async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  await asSuperuser(db);
  return (await db.query<T>(sql, params)).rows;
}
const boxOf = async (id: string) =>
  (
    await q<{ role: string; unit: string | null }>(
      `select role, bulk_unit_id as unit from copy where id = $1`,
      [id],
    )
  )[0];
/** How many cards Box B holds (its limit is 1). */
const heldInB = async () =>
  Number(
    (
      await q<{ n: number }>(
        `select count(*)::int as n from copy where bulk_unit_id = $1 and role = 'bulk'`,
        [BOX(2)],
      )
    )[0].n,
  );
/** The decisions written about a copy, and what each overrode. */
const decisionsOf = (copyId: string) =>
  q<{ decision: string; overrides: string[]; resolved_by: string; reason: string }>(
    `select decision, overrides, resolved_by, reason from placement_decision where copy_id = $1 order by created_at`,
    [copyId],
  );

beforeEach(async () => {
  db = await freshRpcDb();
  await seedCatalogCardsFull(db, [CHARMANDER_SV03_026]);
  await seedBinders(db, [{ id: GEN, type: "general", name: "KB-001" }]);
  await q(
    `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from, card_class) values
       ('emberling', 'Emberling', '{9301}', '{Fire}', 'Basic', null, 'standard'),
       ('emberdrake', 'Emberdrake', '{9302}', '{Fire}', 'Stage1', 'Emberling', 'standard'),
       ('emberdrake-alt', 'Emberdrake', '{9302}', '{Fire}', 'Stage1', 'Emberling', 'standard'),
       ('emberlord', 'Emberlord', '{9303}', '{Fire}', 'Stage2', 'Emberdrake', 'standard')`,
  );
  // Her boxes: her default (no limit), and Box B, room for 1, holding 1.
  await q(
    `insert into bulk_unit (id, owner_id, name, is_default, capacity, sort_order) values
       ($1, $3, 'Bulk box', true, null, 0), ($2, $3, 'Box B', false, 1, 1)`,
    [BOX(1), BOX(2), OWNER],
  );
  await q(
    `insert into copy (id, owner_id, catalog_card_id, role, bulk_unit_id) values ($1, $2, 'emberling', 'bulk', $3)`,
    [C(99), OWNER, BOX(2)],
  );
  clearCatalogCache();
});

async function shelved(copyId: string, card = "emberling") {
  await q(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
       values ($1, $2, $3, 'shelved', $4, 'front', 'red')`,
    [copyId, OWNER, card, GEN],
  );
}

/* ------------------------------------------------ 1. a Move ------------------------------------------------ */

describe("a Move into a full box", () => {
  it("with her override: it lands, Box B goes over its limit, and the move's decision records it", async () => {
    await shelved(C(1));
    await asOwner(db);
    await applyMove(pgliteClient(db), { copyId: C(1), destination: OVER }, names);
    expect(await boxOf(C(1))).toEqual({ role: "bulk", unit: BOX(2) });
    expect(await heldInB()).toBe(2);
    expect(await decisionsOf(C(1))).toEqual([
      expect.objectContaining({
        decision: "placement-move",
        overrides: ["bulk_box_full"],
        resolved_by: "user",
      }),
    ]);
  });

  it("without it: refused in her words, and nothing moves", async () => {
    await shelved(C(1));
    await asOwner(db);
    await expect(
      applyMove(pgliteClient(db), { copyId: C(1), destination: PLAIN }, names),
    ).rejects.toThrow(FULL_B);
    expect(await boxOf(C(1))).toEqual({ role: "shelved", unit: null });
    expect(await heldInB()).toBe(1);
  });
});

/* ------------------------------------------------ 2. the Haul Plan ------------------------------------------------ */

describe("the Haul Plan: her Move on a card waiting in her haul", () => {
  const dup = () => haulRow(C(2), CHARMANDER_SV03_026.tcgdexId);
  beforeEach(async () => {
    await shelved(C(3), CHARMANDER_SV03_026.tcgdexId); // so the waiting one is a plain duplicate
    await seedHaulRows(db, [dup()]);
  });

  it("with her override: it lands in the full box, recorded on the card's decision", async () => {
    await asOwner(db);
    await commitCardPlacement(pgliteClient(db), { card: dup(), override: OVER });
    expect(await boxOf(C(2))).toEqual({ role: "bulk", unit: BOX(2) });
    expect(await heldInB()).toBe(2);
    expect(await decisionsOf(C(2))).toEqual([
      expect.objectContaining({ overrides: ["bulk_box_full"], resolved_by: "user" }),
    ]);
  });

  it("without it: refused in her words, and the card is still in her haul", async () => {
    await asOwner(db);
    await expect(
      commitCardPlacement(pgliteClient(db), { card: dup(), override: PLAIN }),
    ).rejects.toThrow(FULL_B);
    expect(await boxOf(C(2))).toEqual({ role: "haul", unit: null });
  });
});

describe("the Haul Plan: a holo swaps in for her normal, and every box is full", () => {
  const holo = () => haulRow(C(41), CHARMANDER_SV03_026.tcgdexId, "holo");
  beforeEach(async () => {
    await shelved(C(40), CHARMANDER_SV03_026.tcgdexId); // the normal on her shelf
    // Her default fills up too: every box is full.
    await q(`update bulk_unit set capacity = 1 where id = $1`, [BOX(1)]);
    await q(
      `insert into copy (id, owner_id, catalog_card_id, role, bulk_unit_id) values ($1, $2, 'emberling', 'bulk', $3)`,
      [C(42), OWNER, BOX(1)],
    );
    await seedHaulRows(db, [holo()]);
  });

  it("the plan says so: the row is a swap, and every box is full", async () => {
    await asOwner(db);
    const spot = await deriveSpotlightPlacement(pgliteClient(db), holo());
    expect(spot?.item).toMatchObject({ action: "SWAP", boxesFull: true });
  });

  it("with her override: the holo takes the shelf, the normal goes to the box she picked, recorded on the swap's decision", async () => {
    await asOwner(db);
    await commitCardPlacement(pgliteClient(db), { card: holo(), displacedTo: OVER });
    expect(await boxOf(C(41))).toEqual({ role: "shelved", unit: null });
    expect(await boxOf(C(40))).toEqual({ role: "bulk", unit: BOX(2) });
    expect(await heldInB()).toBe(2);
    expect(await decisionsOf(C(41))).toEqual([
      expect.objectContaining({
        decision: "duplicate",
        overrides: ["bulk_box_full"],
        resolved_by: "user",
      }),
    ]);
  });

  it("through the screen's own action: her box for the swapped-out card reaches the write", async () => {
    await asOwner(db);
    const res = await shelveCardAction({
      card: {
        id: C(41),
        tcgdexId: CHARMANDER_SV03_026.tcgdexId,
        variant: "holo",
        existingCopyId: C(41),
      },
      displacedTo: OVER,
    });
    expect(res).toMatchObject({ ok: true });
    expect(await boxOf(C(40))).toEqual({ role: "bulk", unit: BOX(2) });
  });

  it("without it: refused in her words, and nothing moves", async () => {
    await asOwner(db);
    await expect(commitCardPlacement(pgliteClient(db), { card: holo() })).rejects.toThrow(
      "Your Bulk box is full. Pick another box.",
    );
    await expect(
      commitCardPlacement(pgliteClient(db), { card: holo(), displacedTo: PLAIN }),
    ).rejects.toThrow(FULL_B);
    expect(await boxOf(C(41))).toEqual({ role: "haul", unit: null });
    expect(await boxOf(C(40))).toEqual({ role: "shelved", unit: null });
  });
});

/* ------------------------------------- a line, for the Replace and its plan Move ------------------------------------- */

/** Her closed Emberling line: the Basic and the Stage 1 filled. */
async function closedLine() {
  await q(
    `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
       values ($1, $2, 9301, 'red', $3, 'back', 'closed')`,
    [LINE, OWNER, GEN],
  );
  await q(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band) values
       ($1, $3, 'emberling', 'shelved', $4, 'back', 'red'), ($2, $3, 'emberdrake', 'shelved', $4, 'back', 'red')`,
    [C(10), C(11), OWNER, GEN],
  );
  await q(
    `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id) values
       ($1, $3, $4, 0, 'Basic', 'filled', $5), ($2, $3, $4, 1, 'Stage1', 'filled', $6)`,
    [S(0), S(1), OWNER, LINE, C(10), C(11)],
  );
  await q(`update copy set line_slot_id = $1 where id = $2`, [S(0), C(10)]);
  await q(`update copy set line_slot_id = $1 where id = $2`, [S(1), C(11)]);
}
const swapOut = (outgoing: typeof OVER | typeof PLAIN) => ({
  mode: "replace" as const,
  lineId: LINE,
  slotId: S(1),
  keep: false as const,
  outgoing,
});
const lineBack = { kind: "shelf", binderId: GEN, half: "back", band: "red" } as const;

describe("a line Replace: the card coming out goes to a full box", () => {
  beforeEach(async () => {
    await closedLine();
    await shelved(C(12), "emberdrake-alt");
  });

  it("with her override: it lands there, recorded on its own decision", async () => {
    await asOwner(db);
    await applyMove(
      pgliteClient(db),
      { copyId: C(12), destination: lineBack, lineChoice: swapOut(OVER) },
      names,
    );
    expect(await boxOf(C(11))).toEqual({ role: "bulk", unit: BOX(2) });
    expect(await heldInB()).toBe(2);
    expect(await decisionsOf(C(11))).toEqual([
      expect.objectContaining({ decision: "line-replaced-out", overrides: ["bulk_box_full"] }),
    ]);
  });

  it("without it: refused in her words, and the line keeps its card", async () => {
    await asOwner(db);
    await expect(
      applyMove(
        pgliteClient(db),
        { copyId: C(12), destination: lineBack, lineChoice: swapOut(PLAIN) },
        names,
      ),
    ).rejects.toThrow(FULL_B);
    expect(await boxOf(C(11))).toEqual({ role: "shelved", unit: null });
  });
});

describe("the Haul Plan: her Move into a line, the card coming out to a full box", () => {
  const incoming = () => haulRow(C(13), "emberdrake-alt");
  beforeEach(async () => {
    await closedLine();
    await seedHaulRows(db, [incoming()]);
  });

  it("with her override: it lands there, recorded", async () => {
    await asOwner(db);
    await commitCardPlacement(pgliteClient(db), {
      card: incoming(),
      override: lineBack,
      lineChoice: swapOut(OVER),
    });
    expect(await boxOf(C(11))).toEqual({ role: "bulk", unit: BOX(2) });
    expect(await boxOf(C(13))).toEqual({ role: "shelved", unit: null });
    expect(await decisionsOf(C(11))).toEqual([
      expect.objectContaining({ decision: "line-replaced-out", overrides: ["bulk_box_full"] }),
    ]);
  });

  it("without it: refused in her words", async () => {
    await asOwner(db);
    await expect(
      commitCardPlacement(pgliteClient(db), {
        card: incoming(),
        override: lineBack,
        lineChoice: swapOut(PLAIN),
      }),
    ).rejects.toThrow(FULL_B);
    expect(await boxOf(C(13))).toEqual({ role: "haul", unit: null });
  });
});

/* ------------------------------------- a spare card in a pocket, going back ------------------------------------- */

describe("a spare card coming out of its pocket, into its full home box", () => {
  beforeEach(async () => {
    // Her open line: the Emberling, a Stage 1 her spare Emberling fills (from Box B), an open Stage 2.
    await q(
      `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
         values ($1, $2, 9301, 'red', $3, 'back', 'open')`,
      [LINE, OWNER, GEN],
    );
    await q(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
         values ($1, $2, 'emberling', 'shelved', $3, 'back', 'red')`,
      [C(20), OWNER, GEN],
    );
    await q(
      `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id) values
         ($1, $4, $5, 0, 'Basic', 'filled', $6), ($2, $4, $5, 1, 'Stage1', 'placeholder', null),
         ($3, $4, $5, 2, 'Stage2', 'placeholder', null)`,
      [S(0), S(1), S(2), OWNER, LINE, C(20)],
    );
    await q(`update copy set line_slot_id = $1 where id = $2`, [S(0), C(20)]);
    // Her spare Emberling, from Box B (emptied for it), fills the Stage 1; then Box B fills again.
    await q(`delete from copy where id = $1`, [C(99)]);
    await q(
      `insert into copy (id, owner_id, catalog_card_id, role, bulk_unit_id) values ($1, $2, 'emberling', 'bulk', $3)`,
      [C(21), OWNER, BOX(2)],
    );
    await asOwner(db);
    await applyStageDecisions(pgliteClient(db), {
      lineId: LINE,
      stages: { 1: { kind: "filler", filler: { material: "card", copyId: C(21) } } },
    });
    await q(
      `insert into copy (id, owner_id, catalog_card_id, role, bulk_unit_id) values ($1, $2, 'emberling', 'bulk', $3)`,
      [C(22), OWNER, BOX(2)],
    );
    expect(await boxOf(C(21))).toEqual({ role: "block", unit: BOX(2) });
    expect(await heldInB()).toBe(1);
  });

  describe("an Add into its stage (the line builder)", () => {
    beforeEach(async () => {
      await q(
        `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
           values ($1, $2, 'emberdrake', 'shelved', $3, 'front', 'red')`,
        [C(23), OWNER, GEN],
      );
    });
    const join = (over: boolean) =>
      applyMove(
        pgliteClient(db),
        {
          copyId: C(23),
          destination: lineBack,
          lineChoice: {
            mode: "join",
            lineId: LINE,
            slotId: S(1),
            stages: { 2: { kind: "empty" } },
            returnBoxes: { [C(21)]: BOX(2) },
            ...(over ? { returnOverFull: [C(21)] } : {}),
          },
        },
        names,
      );

    it("with her override: it goes back to Box B over its limit, recorded on a decision of its own", async () => {
      await asOwner(db);
      await join(true);
      expect(await boxOf(C(21))).toEqual({ role: "bulk", unit: BOX(2) });
      expect(await heldInB()).toBe(2);
      // After the setup's own decision (she put it in the pocket: "line-filler").
      expect((await decisionsOf(C(21))).filter((d) => d.decision !== "line-filler")).toEqual([
        {
          decision: "filler-returned",
          overrides: ["bulk_box_full"],
          resolved_by: "user",
          reason: "Back to bulk from its pocket, into Box B, over its card limit (your call).",
        },
      ]);
    });

    it("without it: refused in her words, and the spare stays in its pocket", async () => {
      await asOwner(db);
      await expect(join(false)).rejects.toThrow(FULL_B);
      expect(await boxOf(C(21))).toEqual({ role: "block", unit: BOX(2) });
    });
  });

  describe("Lines' Choose: she changes what fills the stage", () => {
    const choose = (over: boolean) =>
      applyStageDecisions(pgliteClient(db), {
        lineId: LINE,
        stages: { 1: { kind: "empty" } },
        returnBoxes: { [C(21)]: BOX(2) },
        ...(over ? { returnOverFull: [C(21)] } : {}),
      });

    it("with her override: it goes back to Box B over its limit, recorded on a decision of its own", async () => {
      await asOwner(db);
      await choose(true);
      expect(await boxOf(C(21))).toEqual({ role: "bulk", unit: BOX(2) });
      expect(await heldInB()).toBe(2);
      // After the setup's own decision (she put it in the pocket: "line-filler").
      expect((await decisionsOf(C(21))).filter((d) => d.decision !== "line-filler")).toEqual([
        {
          decision: "filler-returned",
          overrides: ["bulk_box_full"],
          resolved_by: "user",
          reason: "Back to bulk from its pocket, into Box B, over its card limit (your call).",
        },
      ]);
    });

    it("without it: refused in her words, and the spare stays in its pocket", async () => {
      await asOwner(db);
      await expect(choose(false)).rejects.toThrow(FULL_B);
      expect(await boxOf(C(21))).toEqual({ role: "block", unit: BOX(2) });
    });
  });
});

/* ------------------------------------------- 6. out of a collection ------------------------------------------- */

describe("a card removed from a collection, to a full box", () => {
  const SPEC = "b0000000-0000-4000-8000-000000001372";
  const COL = "a0000000-0000-4000-8000-000000001371";
  beforeEach(async () => {
    await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
    await seedCollections(db, [
      { id: COL, name: "Starters", targetCatalogCardIds: ["emberling"], currentBinderIds: [SPEC] },
    ]);
    await q(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id) values ($1, $2, 'emberling', 'shelved', $3)`,
      [C(30), OWNER, SPEC],
    );
  });
  const remove = (destination: typeof OVER | typeof PLAIN) =>
    applyCollectionRemoval(
      pgliteClient(db),
      { collectionId: COL, tcgdexId: "emberling", destination },
      names,
    );

  it("with her override: it lands there, recorded on the removal's decision", async () => {
    await asOwner(db);
    await remove(OVER);
    expect(await boxOf(C(30))).toEqual({ role: "bulk", unit: BOX(2) });
    expect(await heldInB()).toBe(2);
    expect(await decisionsOf(C(30))).toEqual([
      expect.objectContaining({ decision: "collection-remove", overrides: ["bulk_box_full"] }),
    ]);
  });

  it("without it: refused in her words, and the card stays in the collection", async () => {
    await asOwner(db);
    await expect(remove(PLAIN)).rejects.toThrow(FULL_B);
    expect(await boxOf(C(30))).toEqual({ role: "shelved", unit: null });
  });
});

/* -------------------------------------- 7. Settings: a box deleted -------------------------------------- */

describe("Settings: a box deleted into one without room for its cards", () => {
  beforeEach(async () => {
    await q(
      `insert into bulk_unit (id, owner_id, name, is_default, capacity, sort_order) values ($1, $2, 'Tin', false, null, 2)`,
      [BOX(3), OWNER],
    );
    for (const n of [50, 51])
      await q(
        `insert into copy (id, owner_id, catalog_card_id, role, bulk_unit_id) values ($1, $2, 'emberling', 'bulk', $3)`,
        [C(n), OWNER, BOX(3)],
      );
  });
  const del = async (anyway: boolean) => {
    const views = await bulkUnitRepo.views(pgliteClient(db));
    await applyWriteOps(pgliteClient(db), deleteBoxWrite(BOX(3), BOX(2), views, anyway));
  };

  it("delete anyway: the cards go over Box B's limit, and the decision records it", async () => {
    await asOwner(db);
    await del(true);
    expect(await q(`select id from bulk_unit where id = $1`, [BOX(3)])).toEqual([]);
    expect(await heldInB()).toBe(3);
    expect(
      await q(
        `select decision, overrides, resolved_by, reason from placement_decision where decision = 'bulk-box-deleted-over-limit'`,
      ),
    ).toEqual([
      {
        decision: "bulk-box-deleted-over-limit",
        overrides: ["bulk_box_full"],
        resolved_by: "user",
        reason: "Deleted Tin: its 2 cards went to Box B, 2 over its card limit (your call).",
      },
    ]);
  });

  it("without it: refused in her words, and nothing moves", async () => {
    await asOwner(db);
    await expect(del(false)).rejects.toThrow(
      "Your Box B can't take these 2 cards: it has room for 0. Pick another box.",
    );
    expect(await boxOf(C(50))).toEqual({ role: "bulk", unit: BOX(3) });
  });
});
