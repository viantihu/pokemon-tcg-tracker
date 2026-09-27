/**
 * UIL-121 A2 — every write `validateStageDecision` and `validateThirdPocket` produce is one migration 0030's
 * `assert_line_slots` accepts, on a real database. The validator says what her choice means; the database holds it
 * to the same meaning. If the two ever disagree, a choice she made would be refused after she made it.
 *
 * Real Postgres (PGlite, every migration), the real `apply_write_ops`, as the authenticated owner.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { WriteOp } from "@/lib/repo";
import { withLineSlotCheck } from "@/lib/repo/write-ops";
import { lineStatusOf, type StageDecision, type ThirdPocketChoice } from "@/lib/line/popup";
import {
  stageWriteOps,
  thirdPocketWriteOps,
  validateStageDecision,
  validateThirdPocket,
  type StageCatalogCard,
  type StageState,
  type StageTarget,
} from "@/lib/line/stage-choice";
import {
  applyOps,
  asOwner,
  asSuperuser,
  freshRpcDb,
  OWNER,
  seedBinders,
} from "../support/pglite-rpc";

const BINDER = "b0000000-0000-4000-8000-0000000000a2";
const LINE = "10000000-0000-4000-8000-0000000000a2";
const SHORT = "10000000-0000-4000-8000-0000000000b2";
const SLOT = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const COPY = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const STAGES = ["Basic", "Stage1", "Stage2"] as const;
const DEX = [9301, 9302, 9303];

let db: PGlite;
afterEach(async () => {
  if (db && !db.closed) await db.close();
});

const CATALOG: StageCatalogCard[] = [
  {
    tcgdexId: "emberling",
    name: "Emberling",
    dexId: [9301],
    cardClass: "standard",
    setName: "S",
    localId: "1",
    locale: "en",
  },
  {
    tcgdexId: "emberdrake",
    name: "Emberdrake",
    dexId: [9302],
    cardClass: "standard",
    setName: "S",
    localId: "2",
    locale: "en",
  },
  {
    tcgdexId: "emberlord",
    name: "Emberlord",
    dexId: [9303],
    cardClass: "specialty",
    setName: "S",
    localId: "3",
    locale: "en",
  },
];

let seq = 0;
const state = (copies: { id: string; role: string }[] = []): StageState => ({
  card: (id) => CATALOG.find((c) => c.tcgdexId === id) ?? null,
  copy: (id) => copies.find((c) => c.id === id) ?? null,
  standIns: [],
  mirrorCandidates: () => [],
  newId: () => `b1000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
  newStandInId: (language) =>
    `user:${language}:00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
});
const target = (i: number): StageTarget => ({
  lineId: LINE,
  slotId: SLOT(i),
  stageIndex: i,
  stage: STAGES[i],
  dexId: DEX[i],
  speciesName: CATALOG[i].name,
  lineLocale: "en",
  binderId: BINDER,
  requiredType: "Fire",
});

/** The write, as a screen sends it: her choices, then the slot check appended. */
async function write(ops: WriteOp[]) {
  await asOwner(db);
  try {
    await applyOps(db, { ops: withLineSlotCheck(ops) });
  } catch (e) {
    throw new Error(`${(e as Error).message} ${(e as { detail?: string }).detail ?? ""}`);
  }
}
const stage = (i: number, d: StageDecision, st = state()) =>
  stageWriteOps(SLOT(i), validateStageDecision(st, target(i), d));
async function q<T>(sql: string, params: unknown[] = []) {
  await asSuperuser(db);
  return (await db.query<T>(sql, params)).rows;
}
async function bulkCopy(n: number) {
  await db.query(
    `insert into copy (id, owner_id, catalog_card_id, role) values ($1, $2, 'emberling', 'bulk')`,
    [COPY(n), OWNER],
  );
}

beforeEach(async () => {
  db = await freshRpcDb();
  for (const c of CATALOG) {
    await db.query(
      `insert into catalog_card (tcgdex_id, name, dex_id, card_class) values ($1, $2, $3, $4)`,
      [c.tcgdexId, c.name, c.dexId, c.cardClass],
    );
  }
  await seedBinders(db, [{ id: BINDER, type: "general", name: "KB-001" }]);
  await db.query(
    `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
       values ($1, $2, 9301, 'red', $3, 'back', 'open')`,
    [LINE, OWNER, BINDER],
  );
  for (const i of [0, 1, 2]) {
    await db.query(
      `insert into line_slot (id, owner_id, line_id, stage_index, stage, state) values ($1, $2, $3, $4, $5, 'placeholder')`,
      [SLOT(i), OWNER, LINE, i, STAGES[i]],
    );
  }
});

describe("each stage choice, written, passes 0030's rules", () => {
  it("a CHASE of a catalog card: the slot names it and one open wish exists", async () => {
    await write(stage(1, { kind: "chase", catalogCardId: "emberdrake" }));
    expect(
      await q(`select stage_choice, target_catalog_card_id from line_slot where id = $1`, [
        SLOT(1),
      ]),
    ).toEqual([{ stage_choice: "chase", target_catalog_card_id: "emberdrake" }]);
    expect(await q(`select count(*)::int n from wishlist_item where resolved_at is null`)).toEqual([
      { n: 1 },
    ]);
  });

  it("a CHASE of a placeholder card she makes: the stand-in exists, with no copy", async () => {
    await write(
      stage(2, {
        kind: "chase",
        newStandIn: { name: "Emberlord ex", setName: "Promo", localId: "P9", language: "en" },
      }),
    );
    const [si] = await q<{ source: string; dex_id: number[]; stage: string; types: string[] }>(
      `select source, dex_id, stage, types from catalog_card where tcgdex_id like 'user:%'`,
    );
    expect(si).toEqual({ source: "user", dex_id: [9303], stage: "Stage2", types: ["Fire"] });
    expect(await q(`select count(*)::int n from copy`)).toEqual([{ n: 0 }]);
  });

  it("EMPTY on every stage: accepted, and the line can be closed", async () => {
    await write([
      ...stage(0, { kind: "empty" }),
      ...stage(1, { kind: "empty" }),
      ...stage(2, { kind: "empty" }),
      { op: "update_line", id: LINE, patch: { status: "closed" } },
    ]);
    expect(await q(`select status from evolution_line where id = $1`, [LINE])).toEqual([
      { status: "closed" },
    ]);
  });

  it("re-deciding a chased stage as EMPTY closes its wish in the same write", async () => {
    await write(stage(1, { kind: "chase", catalogCardId: "emberdrake" }));
    await write(stage(1, { kind: "empty" }));
    expect(await q(`select count(*)::int n from wishlist_item where resolved_at is null`)).toEqual([
      { n: 0 },
    ]);
  });

  it("a FILLER of basic energy, and of a card from her bulk box", async () => {
    await bulkCopy(1);
    await write([
      ...stage(0, { kind: "filler", filler: { material: "energy" } }),
      ...stage(
        2,
        { kind: "filler", filler: { material: "card", copyId: COPY(1) } },
        state([{ id: COPY(1), role: "bulk" }]),
      ),
    ]);
    expect(
      await q(`select line_slot_id, material, copy_id from binder_block order by material`),
    ).toEqual([
      { line_slot_id: SLOT(0), material: "basicEnergy", copy_id: null },
      { line_slot_id: SLOT(2), material: "repurposedDuplicate", copy_id: COPY(1) },
    ]);
    expect(
      await q(`select role, binder_half, line_slot_id from copy where id = $1`, [COPY(1)]),
    ).toEqual([{ role: "block", binder_half: "back", line_slot_id: null }]);
  });

  it("a chased stage changed to a FILLER closes its wish too (a filler is on no wishlist)", async () => {
    await write(stage(1, { kind: "chase", catalogCardId: "emberdrake" }));
    await write(stage(1, { kind: "filler", filler: { material: "energy" } }));
    expect(await q(`select count(*)::int n from wishlist_item where resolved_at is null`)).toEqual([
      { n: 0 },
    ]);
  });
});

describe("a NEW line (Backfill's shape): insert the slots, then each stage's writes, in one call", () => {
  const NEW = "10000000-0000-4000-8000-0000000000c2";
  const newTarget = (i: number): StageTarget => ({
    ...target(i),
    lineId: NEW,
    slotId: SLOT(30 + i),
  });
  const build = (decisions: StageDecision[], st = state()): WriteOp[] => {
    const writes = decisions.map((d, i) => validateStageDecision(st, newTarget(i), d));
    const status = lineStatusOf(
      writes.map((w) => ({
        state: w.slotPatch.state ?? "placeholder",
        stageChoice: w.slotPatch.stage_choice,
      })),
    );
    return [
      {
        op: "insert_line",
        id: NEW,
        root_dex_id: 9301,
        color_band: "red",
        binder_id: BINDER,
        half: "back",
        status,
      },
      ...decisions.map((_, i): WriteOp => ({
        op: "insert_slot",
        id: SLOT(30 + i),
        line_id: NEW,
        stage_index: i,
        stage: STAGES[i],
        state: "placeholder",
        copy_id: null,
        target_catalog_card_id: null,
        note: null,
      })),
      ...writes.flatMap((w, i) => stageWriteOps(SLOT(30 + i), w)),
    ];
  };

  it("a chased stage: accepted, and the line reads open", async () => {
    await write(
      build([
        {
          kind: "chase",
          newStandIn: { name: "Emberling", setName: "Promo", localId: "P1", language: "en" },
        },
        { kind: "filler", filler: { material: "energy" } },
      ]),
    );
    expect(await q(`select status from evolution_line where id = $1`, [NEW])).toEqual([
      { status: "open" },
    ]);
  });

  it("every stage left empty or given a filler: accepted, and the line reads closed", async () => {
    await write(build([{ kind: "empty" }, { kind: "filler", filler: { material: "energy" } }]));
    expect(await q(`select status from evolution_line where id = $1`, [NEW])).toEqual([
      { status: "closed" },
    ]);
  });
});

describe("the third pocket, written, passes 0030's rules", () => {
  beforeEach(async () => {
    // A complete two-card line: closed, with a third pocket to fill.
    await db.query(
      `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
         values ($1, $2, 9301, 'red', $3, 'back', 'closed')`,
      [SHORT, OWNER, BINDER],
    );
    for (const i of [0, 1]) {
      await db.query(
        `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
           values ($1, $2, $3, 'shelved', $4, 'back', 'red')`,
        [COPY(10 + i), OWNER, CATALOG[i].tcgdexId, BINDER],
      );
      await db.query(
        `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
           values ($1, $2, $3, $4, $5, 'filled', $6)`,
        [SLOT(10 + i), OWNER, SHORT, i, STAGES[i], COPY(10 + i)],
      );
      await db.query(`update copy set line_slot_id = $1 where id = $2`, [
        SLOT(10 + i),
        COPY(10 + i),
      ]);
    }
    await bulkCopy(20);
  });
  const pocket = (choice: ThirdPocketChoice) =>
    thirdPocketWriteOps(
      SHORT,
      validateThirdPocket(
        state([{ id: COPY(20), role: "bulk" }]),
        { lineId: SHORT, binderId: BINDER, slotCount: 2, completeAfterWrite: true },
        choice,
      )!,
    );

  it.each([
    [{ material: "energy" } as ThirdPocketChoice, "energy"],
    [{ material: "card", copyId: COPY(20) } as ThirdPocketChoice, "card"],
    [{ material: "empty" } as ThirdPocketChoice, "empty"],
  ])("%j is recorded and accepted", async (choice, recorded) => {
    await write(pocket(choice));
    expect(await q(`select extra_pocket from evolution_line where id = $1`, [SHORT])).toEqual([
      { extra_pocket: recorded },
    ]);
  });
});
