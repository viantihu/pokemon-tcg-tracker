/**
 * UIL-121 (QA on #435) — one spare card fills one pocket, per WRITE, on real Postgres (PGlite, every migration),
 * through the real `applyMove`, as the owner.
 *
 *   - A replace whose card coming out starts ANOTHER line is one write over two lines: naming the same bulk card for
 *     a pocket in each is refused, and nothing is written. (The two lines' states were built separately, so each had
 *     its own claims; nothing in the database holds one card to one pocket yet.)
 *   - The claims last one write: a SECOND save naming a card the first one used is refused because the card has left
 *     the bulk box, never because a claim from the first write was still held.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyMove, type MoveNameLookups } from "@/lib/line";
import type { LineChoice } from "@/lib/line/popup";
import { STAGE_REFUSAL } from "@/lib/line/stage-choice";
import type { MoveDestination } from "@/lib/line/types";
import { asOwner, asSuperuser, freshRpcDb, OWNER, seedBinders } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";
import { clearCatalogCache } from "@/lib/plan/catalog-cache";

const GEN = "b0000000-0000-4000-8000-0000000435d1";
const GEN2 = "b0000000-0000-4000-8000-0000000435d2";
const LINE = "10000000-0000-4000-8000-0000000435d1";
const SLOT = (n: number) => `20000000-0000-4000-8000-0000000435d${n}`;
const BASIC = "c0000000-0000-4000-8000-0000000435d0";
const OLD = "c0000000-0000-4000-8000-0000000435d1"; // the Emberdrake in the Stage 1 slot now
const NEW = "c0000000-0000-4000-8000-0000000435d2"; // a second Emberdrake, front half
const SPARE = "c0000000-0000-4000-8000-0000000435d3"; // a spare Emberling in her bulk box

const names: MoveNameLookups = {
  binderName: () => "KB-001",
  collectionName: () => null,
  bandDisplay: (k) => k,
};
const HERE: MoveDestination = { kind: "shelf", binderId: GEN, half: "back", band: "red" };
const THERE: MoveDestination = { kind: "shelf", binderId: GEN2, half: "back", band: "red" };
const spare = { kind: "filler", filler: { material: "card", copyId: SPARE } } as const;

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  // Every catalog loader reads through the shared cache (module state): each fresh database starts it cold.
  clearCatalogCache();
  await seedBinders(db, [
    { id: GEN, type: "general", name: "KB-001" },
    { id: GEN2, type: "general", name: "KB-002" },
  ]);
  await db.query(
    `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from, card_class) values
       ('emberling', 'Emberling', '{9301}', '{Fire}', 'Basic', null, 'standard'),
       ('emberdrake', 'Emberdrake', '{9302}', '{Fire}', 'Stage1', 'Emberling', 'standard'),
       ('emberdrake-alt', 'Emberdrake', '{9302}', '{Fire}', 'Stage1', 'Emberling', 'standard'),
       ('emberlord', 'Emberlord', '{9303}', '{Fire}', 'Stage2', 'Emberdrake', 'standard')`,
  );
  await db.query(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band) values
       ($1, $5, 'emberling', 'shelved', $6, 'back', 'red'),
       ($2, $5, 'emberdrake', 'shelved', $6, 'back', 'red'),
       ($3, $5, 'emberdrake-alt', 'shelved', $6, 'front', 'red'),
       ($4, $5, 'emberling', 'bulk', null, null, null)`,
    [BASIC, OLD, NEW, SPARE, OWNER, GEN],
  );
  // Her open three-stage line in KB-001: Emberling, Emberdrake, and the Stage 2 not decided.
  await db.query(
    `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
       values ($1, $2, 9301, 'red', $3, 'back', 'open')`,
    [LINE, OWNER, GEN],
  );
  await db.query(
    `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id) values
       ($1, $4, $5, 0, 'Basic', 'filled', $6), ($2, $4, $5, 1, 'Stage1', 'filled', $7),
       ($3, $4, $5, 2, 'Stage2', 'placeholder', null)`,
    [SLOT(0), SLOT(1), SLOT(2), OWNER, LINE, BASIC, OLD],
  );
  await db.query(`update copy set line_slot_id = $1 where id = $2`, [SLOT(0), BASIC]);
  await db.query(`update copy set line_slot_id = $1 where id = $2`, [SLOT(1), OLD]);
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
const move = (copyId: string, destination: MoveDestination, lineChoice: LineChoice) =>
  applyMove(pgliteClient(db), { copyId, destination, lineChoice }, names);
/** The new Emberdrake swaps in; the old one comes out to `outgoing`, into a line when `outgoingLine` is given. */
const swapIn = (extra: Partial<LineChoice>) =>
  move(NEW, HERE, {
    mode: "replace",
    lineId: LINE,
    slotId: SLOT(1),
    keep: false,
    outgoing: { kind: "bulk" },
    ...extra,
  } as LineChoice);

describe("one write, two lines: a replace whose card coming out starts another line", () => {
  it("the same spare card for a pocket in each line is refused, and nothing is written", async () => {
    await expect(
      swapIn({
        stages: { 2: spare },
        outgoing: THERE,
        outgoingLine: {
          mode: "start",
          binderId: GEN2,
          band: "red",
          pulls: [],
          stages: { 0: spare, 2: { kind: "empty" } },
        },
      } as Partial<LineChoice>),
    ).rejects.toThrow(STAGE_REFUSAL.fillerTwice);
    expect(await q(`select role, binder_id from copy where id = $1`, [SPARE])).toEqual([
      { role: "bulk", binder_id: null },
    ]);
    expect(await q(`select count(*)::int n from binder_block`)).toEqual([{ n: 0 }]);
    expect(await q(`select count(*)::int n from evolution_line`)).toEqual([{ n: 1 }]);
    expect(await q(`select copy_id from line_slot where id = $1`, [SLOT(1)])).toEqual([
      { copy_id: OLD },
    ]);
  });

  it("after that refusal, her corrected save goes through: a refused write leaves no claim behind", async () => {
    const both = {
      stages: { 2: spare },
      outgoing: THERE,
      outgoingLine: {
        mode: "start",
        binderId: GEN2,
        band: "red",
        pulls: [],
        stages: { 0: spare, 2: { kind: "empty" } },
      },
    } as Partial<LineChoice>;
    await expect(swapIn(both)).rejects.toThrow(STAGE_REFUSAL.fillerTwice);
    await swapIn({
      stages: { 2: spare },
      outgoing: THERE,
      outgoingLine: {
        mode: "start",
        binderId: GEN2,
        band: "red",
        pulls: [],
        stages: { 0: { kind: "empty" }, 2: { kind: "empty" } },
      },
    } as Partial<LineChoice>);
    expect(await q(`select role from copy where id = $1`, [SPARE])).toEqual([{ role: "block" }]);
    expect(await q(`select count(*)::int n from evolution_line`)).toEqual([{ n: 2 }]);
  });
});

describe("the claims last one write", () => {
  it("a second save naming the card the first one used is refused because it left the bulk box", async () => {
    // Save 1: the swap, and the spare card fills this line's Stage 2; the old Emberdrake goes to bulk.
    await swapIn({ stages: { 2: spare } });
    expect(await q(`select role from copy where id = $1`, [SPARE])).toEqual([{ role: "block" }]);
    // Save 2: the old Emberdrake, now in bulk, starts a line in KB-002 and names the same spare card.
    await expect(
      move(OLD, THERE, {
        mode: "start",
        binderId: GEN2,
        band: "red",
        pulls: [],
        stages: { 0: spare, 2: { kind: "empty" } },
      }),
    ).rejects.toThrow(STAGE_REFUSAL.fillerNotInBulk);
    expect(await q(`select count(*)::int n from evolution_line`)).toEqual([{ n: 1 }]);
  });
});

describe("a JOIN cannot fill a stage and the third pocket with one card: it has no third pocket then", () => {
  // QA's K3 case. A third pocket exists only once every stage holds a CARD; a filler makes its stage a block, so a
  // join that fills one stage with a spare card leaves no third pocket to fill, and that is what refuses it.
  const SHORT = "10000000-0000-4000-8000-0000000435e1";
  const ASH = "c0000000-0000-4000-8000-0000000435e2";
  beforeEach(async () => {
    await q(
      `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from, card_class) values
         ('ashling', 'Ashling', '{9311}', '{Fire}', 'Basic', null, 'standard'),
         ('ashdrake', 'Ashdrake', '{9312}', '{Fire}', 'Stage1', 'Ashling', 'standard')`,
    );
    await q(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
         values ($1, $2, 'ashdrake', 'shelved', $3, 'front', 'red')`,
      [ASH, OWNER, GEN],
    );
    await q(
      `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
         values ($1, $2, 9311, 'red', $3, 'back', 'open')`,
      [SHORT, OWNER, GEN],
    );
    await q(
      `insert into line_slot (id, owner_id, line_id, stage_index, stage, state) values
         ($1, $3, $4, 0, 'Basic', 'placeholder'), ($2, $3, $4, 1, 'Stage1', 'placeholder')`,
      [SLOT(8), SLOT(9), OWNER, SHORT],
    );
  });

  it("the spare card for the Basic AND the third pocket is refused, and nothing is written", async () => {
    await expect(
      move(ASH, HERE, {
        mode: "join",
        lineId: SHORT,
        slotId: SLOT(9),
        stages: { 0: spare },
        thirdPocket: { material: "card", copyId: SPARE },
      } as LineChoice),
    ).rejects.toThrow(STAGE_REFUSAL.noThirdPocket);
    expect(await q(`select role from copy where id = $1`, [SPARE])).toEqual([{ role: "bulk" }]);
    expect(await q(`select count(*)::int n from binder_block`)).toEqual([{ n: 0 }]);
    expect(
      await q(`select state from line_slot where line_id = $1 order by stage_index`, [SHORT]),
    ).toEqual([{ state: "placeholder" }, { state: "placeholder" }]);
  });
});
