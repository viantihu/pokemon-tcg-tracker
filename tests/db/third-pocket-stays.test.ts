/**
 * UIL-121 A2b — migration 0032, on a real database.
 *
 *   1. A short line keeps its third-pocket choice when a card LEAVES it. 0030 also required the line to be complete,
 *      which refused every write out of such a line (a Move, a removal, a rebind, a sync undo): her always-movable
 *      rule broken the moment she chose what fills a pocket. Each of those writes' shapes is accepted here, and a
 *      real Move through `applyMove`.
 *   2. delete_line takes the line's untracked energy fillers with it; a tracked filler CARD still refuses it
 *      (UIL-118: a line that holds a card is not deleted).
 *   3. A line has at least two stages (Karvi, 2026-09-27: "A basic with no evolution should not be allowed to get put
 *      in the 'lines' area"): no writer can make a one-card line.
 *
 * Real Postgres (PGlite, every migration), the real `apply_write_ops`, as the authenticated owner.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyMove, type MoveNameLookups } from "@/lib/line";
import { releaseSlotOps } from "@/lib/line/move";
import type { WriteOp } from "@/lib/repo";
import { withLineSlotCheck } from "@/lib/repo/write-ops";
import {
  applyOps,
  asOwner,
  asSuperuser,
  freshRpcDb,
  OWNER,
  seedBinders,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const GEN = "b0000000-0000-4000-8000-000000000032";
const LINE = "10000000-0000-4000-8000-000000000032";
const [S0, S1] = ["20000000-0000-4000-8000-000000000320", "20000000-0000-4000-8000-000000000321"];
const [C0, C1, SPARE] = [
  "c0000000-0000-4000-8000-000000000320",
  "c0000000-0000-4000-8000-000000000321",
  "c0000000-0000-4000-8000-000000000322",
];
const BLOCK = "b1000000-0000-4000-8000-000000000032";
const names: MoveNameLookups = {
  binderName: () => "KB-001",
  collectionName: () => null,
  bandDisplay: (k) => k,
};

let db: PGlite;
afterEach(async () => {
  if (db && !db.closed) await db.close();
});

async function q<T>(sql: string, params: unknown[] = []) {
  await asSuperuser(db);
  return (await db.query<T>(sql, params)).rows;
}
/** The write, with the slot check appended, and a refusal's reasons (in its detail) in the message. */
async function write(ops: WriteOp[]) {
  await asOwner(db);
  try {
    await applyOps(db, { ops: withLineSlotCheck(ops) });
  } catch (e) {
    throw new Error(`${(e as Error).message} ${(e as { detail?: string }).detail ?? ""}`);
  }
}

beforeEach(async () => {
  db = await freshRpcDb();
  await db.query(
    `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from) values
       ('emberling', 'Emberling', '{9301}', '{Fire}', 'Basic', null),
       ('emberdrake', 'Emberdrake', '{9302}', '{Fire}', 'Stage1', 'Emberling')`,
  );
  await seedBinders(db, [{ id: GEN, type: "general", name: "KB-001" }]);
  // Her complete two-card line, CLOSED, with a basic energy in its third pocket.
  await db.query(
    `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status, extra_pocket)
       values ($1, $2, 9301, 'red', $3, 'back', 'closed', 'energy')`,
    [LINE, OWNER, GEN],
  );
  for (const [slot, copy, i, card] of [
    [S0, C0, 0, "emberling"],
    [S1, C1, 1, "emberdrake"],
  ] as const) {
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
         values ($1, $2, $3, 'shelved', $4, 'back', 'red')`,
      [copy, OWNER, card, GEN],
    );
    await db.query(
      `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
         values ($1, $2, $3, $4, $5, 'filled', $6)`,
      [slot, OWNER, LINE, i, i === 0 ? "Basic" : "Stage1", copy],
    );
    await db.query(`update copy set line_slot_id = $1 where id = $2`, [slot, copy]);
  }
  await db.query(
    `insert into binder_block (id, owner_id, binder_id, half, pocket_count, purpose, material, copy_id, line_id)
       values ($1, $2, $3, 'back', 1, 'line-filler', 'basicEnergy', null, $4)`,
    [BLOCK, OWNER, GEN, LINE],
  );
});

describe("0032 · a card can always leave a short line whose third pocket she chose", () => {
  const release = releaseSlotOps(S1, LINE); // the Stage 1's slot opens; the line reads open again

  it.each<[string, WriteOp[]]>([
    [
      "a Move to a front half",
      [
        ...release,
        {
          op: "update_copy",
          id: C1,
          patch: { binder_half: "front", line_slot_id: null },
        },
      ],
    ],
    ["a removal from her collection", [...release, { op: "delete_copy", id: C1 }]],
    [
      "a rebind to the bulk box",
      [
        ...release,
        {
          op: "update_copy",
          id: C1,
          patch: {
            role: "bulk",
            binder_id: null,
            binder_half: null,
            color_band: null,
            line_slot_id: null,
          },
        },
      ],
    ],
    ["a sync undo deleting the copy", [...release, { op: "delete_copy", id: C1 }]],
  ])("%s is accepted, and her third-pocket choice and its energy stay", async (_, ops) => {
    await write(ops);
    expect(
      await q(`select status, extra_pocket from evolution_line where id = $1`, [LINE]),
    ).toEqual([{ status: "open", extra_pocket: "energy" }]);
    expect(await q(`select id from binder_block where line_id = $1`, [LINE])).toEqual([
      { id: BLOCK },
    ]);
  });

  it("through the real Move: the Stage 1 goes to a front half, and the line keeps its pocket", async () => {
    await asOwner(db);
    await applyMove(
      pgliteClient(db),
      { copyId: C1, destination: { kind: "shelf", binderId: GEN, half: "front", band: "red" } },
      names,
    );
    expect(await q(`select state from line_slot where id = $1`, [S1])).toEqual([
      { state: "placeholder" },
    ]);
    expect(await q(`select extra_pocket from evolution_line where id = $1`, [LINE])).toEqual([
      { extra_pocket: "energy" },
    ]);
  });

  it("a third-pocket choice on a line of three stages is still refused", async () => {
    await q(
      `insert into line_slot (id, owner_id, line_id, stage_index, stage, state) values
               ('20000000-0000-4000-8000-000000000322', $1, $2, 2, 'Stage2', 'placeholder')`,
      [OWNER, LINE],
    );
    await expect(write([{ op: "update_line", id: LINE, patch: {} }])).rejects.toThrow(
      /a third-pocket choice on a line with no third pocket/,
    );
  });
});

describe("0032 · delete_line takes the line's energy fillers with it", () => {
  /** Empty the line: both cards out, slots open. */
  const emptied: WriteOp[] = [
    ...releaseSlotOps(S0, LINE),
    ...releaseSlotOps(S1, null),
    { op: "delete_copy", id: C0 },
    { op: "delete_copy", id: C1 },
  ];

  it("an energy filler goes with the line", async () => {
    await write(emptied);
    await write([{ op: "delete_line", line_id: LINE }]);
    expect(await q(`select count(*)::int n from evolution_line`)).toEqual([{ n: 0 }]);
    expect(await q(`select count(*)::int n from binder_block`)).toEqual([{ n: 0 }]);
  });

  it("a filler CARD is a card: the delete is refused and nothing goes", async () => {
    await q(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half)
         values ($1, $2, 'emberling', 'block', $3, 'back')`,
      [SPARE, OWNER, GEN],
    );
    await q(
      `update binder_block set copy_id = $1, material = 'repurposedDuplicate' where id = $2`,
      [SPARE, BLOCK],
    );
    await q(`update evolution_line set extra_pocket = 'card' where id = $1`, [LINE]);
    await write(emptied);
    await expect(write([{ op: "delete_line", line_id: LINE }])).rejects.toThrow(
      /still holds something/,
    );
    expect(await q(`select count(*)::int n from binder_block`)).toEqual([{ n: 1 }]);
  });
});

describe("0032 · a line has at least two stages (Karvi: a Basic with no evolution is never a line)", () => {
  const NEW = "10000000-0000-4000-8000-0000000003a2";
  const slot = (id: string, i: number): WriteOp => ({
    op: "insert_slot",
    id,
    line_id: NEW,
    stage_index: i,
    stage: i === 0 ? "Basic" : "Stage1",
    state: "placeholder",
    copy_id: null,
    target_catalog_card_id: null,
    note: null,
  });
  const line: WriteOp = {
    op: "insert_line",
    id: NEW,
    root_dex_id: 9301,
    color_band: "red",
    binder_id: GEN,
    half: "back",
    status: "open",
  };

  it("a one-stage line is refused, and nothing is written", async () => {
    await expect(write([line, slot("20000000-0000-4000-8000-0000000003a0", 0)])).rejects.toThrow(
      /a line needs at least two stages/,
    );
    expect(await q(`select count(*)::int n from evolution_line where id = $1`, [NEW])).toEqual([
      { n: 0 },
    ]);
  });

  it("an OLDER one-card line still lets its card move out (always movable): only a new line is held to it", async () => {
    await q(
      `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status, created_at)
         values ($1, $2, 9301, 'red', $3, 'back', 'closed', now() - interval '1 day')`,
      [NEW, OWNER, GEN],
    );
    await q(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
         values ($1, $2, 'emberling', 'shelved', $3, 'back', 'red')`,
      [SPARE, OWNER, GEN],
    );
    await q(
      `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
         values ('20000000-0000-4000-8000-0000000003a0', $1, $2, 0, 'Basic', 'filled', $3)`,
      [OWNER, NEW, SPARE],
    );
    await q(`update copy set line_slot_id = '20000000-0000-4000-8000-0000000003a0' where id = $1`, [
      SPARE,
    ]);
    await write([
      ...releaseSlotOps("20000000-0000-4000-8000-0000000003a0", NEW),
      { op: "update_copy", id: SPARE, patch: { binder_half: "front", line_slot_id: null } },
    ]);
    expect(await q(`select binder_half from copy where id = $1`, [SPARE])).toEqual([
      { binder_half: "front" },
    ]);
  });

  it("two stages are accepted", async () => {
    await write([
      line,
      slot("20000000-0000-4000-8000-0000000003a0", 0),
      slot("20000000-0000-4000-8000-0000000003a1", 1),
    ]);
    expect(await q(`select count(*)::int n from line_slot where line_id = $1`, [NEW])).toEqual([
      { n: 2 },
    ]);
  });
});
