/**
 * UIL-117 PR 5 (5a) — every stage of a Backfill line is HER decision, and the server checks the line before it
 * writes anything.
 *
 * UIL-119, on Backfill's side: the screen pre-set every stage with a same-colour printing to a hunt, and the planner
 * wished every placeholder, so saving a line put stages on her wishlist she never chose. Karvi's ruling is that a
 * stage goes on her wishlist only when she adds it. Now a placeholder says `hunt`: true is a wishlist hunt, false is
 * "Leave empty" (a slot on no wishlist), and one that does not say is refused.
 *
 * The Tech Lead's outline and the Senior BA's rulings, pinned below: the chain is resolved again on the server from
 * the card she picked the species by, and a line that does not match it, a stage she has not decided, a hunt on a
 * terminated line or with nothing to hunt, a card of the wrong species, or a malformed block is refused with NOTHING
 * written. What the server derives (a capped status, the wishlist's type) it does not take from the browser. Every
 * shape she can save passes 0028's slot check.
 *
 * The REAL executor (`commitBackLine`) against real Postgres (PGlite) and the real `apply_write_ops`, as the owner.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  BackLineRefused,
  commitBackLine,
  LEFT_EMPTY_NOTE,
  type BackLineCommit,
  type BackLineStageInput,
} from "@/lib/backfill";
import { clearCatalogCache } from "@/lib/plan";
import { CHARMANDER_SV03_026, CHARMELEON_SV03_027, SCIZOR_SV03_141 } from "../engine/fixtures";
import {
  asOwner,
  asSuperuser,
  count,
  freshRpcDb,
  OWNER,
  seedBinders,
  seedCatalogCardsFull,
  seedHaulCopies,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const B1 = "1c000000-0000-0000-0000-0000000000b1";
const SPEC = "1c000000-0000-0000-0000-00000000c5ec";
const CMD = "a0000000-0000-4000-8000-000000000001";
const CML = "a0000000-0000-4000-8000-000000000002";
const SCZ = "a0000000-0000-4000-8000-000000000003";

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedCatalogCardsFull(db, [CHARMANDER_SV03_026, CHARMELEON_SV03_027, SCIZOR_SV03_141]);
  await seedBinders(db, [
    { id: B1, type: "general", name: "KB-001" },
    { id: SPEC, type: "specialty", name: "Specialty A" },
  ]);
  await seedHaulCopies(db, [
    { id: CMD, catalogCardId: CHARMANDER_SV03_026.tcgdexId },
    { id: CML, catalogCardId: CHARMELEON_SV03_027.tcgdexId },
    { id: SCZ, catalogCardId: SCIZOR_SV03_141.tcgdexId, variant: "holo", dexVariantRaw: "Holo" },
  ]);
  clearCatalogCache();
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

const TABLES = [
  "evolution_line",
  "line_slot",
  "wishlist_item",
  "binder_block",
  "placement_decision",
];
async function tallies(): Promise<Record<string, number>> {
  await asSuperuser(db);
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = await count(db, t);
  await asOwner(db);
  return out;
}
const NOTHING = Object.fromEntries(TABLES.map((t) => [t, 0]));
async function rolesOf(): Promise<string[]> {
  await asSuperuser(db);
  const r = await db.query<{ role: string }>(`select role from copy order by id`);
  await asOwner(db);
  return r.rows.map((x) => x.role);
}

/** Her Basic Charmander, filled from her haul. */
const BASIC: BackLineStageInput = {
  stageIndex: 0,
  stage: "Basic",
  dexId: 4,
  decision: "filled",
  filledTcgdexId: CHARMANDER_SV03_026.tcgdexId,
  filledDexVariantRaw: "Normal",
};
/** The Stage 1 Charmeleon as a placeholder, hunted or left empty. */
const stage1 = (extra: Partial<BackLineStageInput> = {}): BackLineStageInput => ({
  stageIndex: 1,
  stage: "Stage1",
  dexId: 5,
  decision: "placeholder",
  hunt: true,
  targetCatalogCardId: CHARMELEON_SV03_027.tcgdexId,
  alternateCatalogCardIds: [],
  specialtyOnly: false,
  ...extra,
});
const line = (
  stages: BackLineStageInput[],
  extra: Partial<BackLineCommit> = {},
): BackLineCommit => ({
  binderId: B1,
  bandKey: "red",
  seedTcgdexId: CHARMANDER_SV03_026.tcgdexId,
  rootDexId: 4,
  requiredType: "Fire",
  terminated: false,
  stages,
  ...extra,
});
const save = (input: BackLineCommit) => commitBackLine(pgliteClient(db), OWNER, input);

async function refusedWithNothingWritten(input: BackLineCommit, message: RegExp | string) {
  const err = await save(input).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BackLineRefused);
  expect((err as Error).message).toMatch(message);
  expect(await tallies()).toEqual(NOTHING);
  expect(await rolesOf()).toEqual(["haul", "haul", "haul"]);
}

describe("UIL-119 · a Backfill stage goes on her wishlist only when she adds it", () => {
  it("Leave empty writes the slot, with NO wishlist row", async () => {
    // PRE-FIX: a placeholder always wished (and the screen pre-set every stage to one).
    await save(line([BASIC, stage1({ hunt: false })]));
    expect(await tallies()).toMatchObject({ line_slot: 2, wishlist_item: 0 });
    await asSuperuser(db);
    const slot = (
      await db.query<{ state: string; note: string | null; target: string | null }>(
        `select state, note, target_catalog_card_id target from line_slot where stage_index = 1`,
      )
    ).rows[0];
    expect(slot).toEqual({
      state: "placeholder",
      note: LEFT_EMPTY_NOTE,
      target: CHARMELEON_SV03_027.tcgdexId,
    });
  });

  it("a Wishlist hunt writes one wishlist row, on its slot", async () => {
    await save(line([BASIC, stage1({ hunt: true })]));
    await asSuperuser(db);
    const rows = (
      await db.query<{ chosen: string; on_slot: boolean }>(
        `select w.chosen_catalog_card_id chosen, s.stage_index = 1 on_slot
           from wishlist_item w join line_slot s on s.id = w.line_slot_id`,
      )
    ).rows;
    expect(rows).toEqual([{ chosen: CHARMELEON_SV03_027.tcgdexId, on_slot: true }]);
  });

  it("a placeholder that does not say is refused, never read as a hunt, and nothing is written", async () => {
    await refusedWithNothingWritten(
      line([BASIC, stage1({ hunt: undefined })]),
      "Choose Wishlist hunt or Leave empty for the Stage 1 stage (Charmeleon).",
    );
  });

  it("a stage she has not decided is refused, and nothing is written", async () => {
    const undecided = { ...stage1(), decision: undefined } as unknown as BackLineStageInput;
    await refusedWithNothingWritten(
      line([BASIC, undecided]),
      "Decide the Stage 1 stage (Charmeleon) before saving: Filled, Wishlist hunt, Leave empty or Block.",
    );
  });
});

describe("UIL-117 PR 5 · a block is hers to choose, never the system's", () => {
  it("a stage no card can fill, left undecided, is refused: no block is written for her", async () => {
    // No Light blue Charmeleon exists, so this stage used to open as a Block (the Senior BA / Tech Lead condition).
    const undecided = {
      ...stage1({ targetCatalogCardId: null }),
      decision: undefined,
    } as unknown as BackLineStageInput;
    await refusedWithNothingWritten(
      line([BASIC, undecided], { bandKey: "light_blue" }),
      "Decide the Stage 1 stage (Charmeleon) before saving: Filled, Wishlist hunt, Leave empty or Block.",
    );
  });

  it("a block with no material is refused, not given one", async () => {
    await refusedWithNothingWritten(
      line([
        BASIC,
        { stageIndex: 1, stage: "Stage1", dexId: 5, decision: "block", pocketCount: 1 },
      ]),
      /Choose what fills the block for the Stage 1 stage/,
    );
  });
});

describe("UIL-117 PR 5 · the server checks the line against the chain it resolves again", () => {
  it("a missing binder, a specialty binder and a band that is not set up are refused", async () => {
    await refusedWithNothingWritten(
      line([BASIC, stage1()], { binderId: "1c000000-0000-0000-0000-00000000dead" }),
      /That binder no longer exists/,
    );
    await refusedWithNothingWritten(
      line([BASIC, stage1()], { binderId: SPEC }),
      "Specialty A is a specialty binder, which has no back half. Pick a general binder.",
    );
    await refusedWithNothingWritten(
      line([BASIC, stage1()], { bandKey: "ultraviolet" }),
      /That colour band is not set up/,
    );
  });

  it("an inactive general binder is allowed: she may be transcribing a shelved one (Q2)", async () => {
    await asSuperuser(db);
    await db.query(`update binder set is_active = false where id = $1`, [B1]);
    await asOwner(db);
    await save(line([BASIC, stage1({ hunt: false })]));
    expect(await tallies()).toMatchObject({ evolution_line: 1, line_slot: 2 });
  });

  it("a seed card not in the catalog, or a root that is not the chain's, is refused", async () => {
    await refusedWithNothingWritten(
      line([BASIC, stage1()], { seedTcgdexId: "zz-000" }),
      /The card this line was started from is not in the catalog/,
    );
    await refusedWithNothingWritten(
      line([BASIC, stage1()], { rootDexId: 6 }),
      /That line is not the Charmander line it was started as/,
    );
  });

  it("stages that are not the chain's, exactly and in order, are refused", async () => {
    const wrong = /That line's stages are not the Charmander line's/;
    await refusedWithNothingWritten(line([BASIC]), wrong); // one missing
    await refusedWithNothingWritten(
      line([stage1({ stageIndex: 0 }), { ...BASIC, stageIndex: 1 }]),
      wrong,
    ); // swapped
    await refusedWithNothingWritten(line([BASIC, stage1({ dexId: 6 })]), wrong); // another species
    await refusedWithNothingWritten(line([BASIC, stage1(), { ...stage1(), stageIndex: 2 }]), wrong); // one extra
  });

  it("a filled stage's card must be that stage's species", async () => {
    await refusedWithNothingWritten(
      line([
        BASIC,
        {
          ...stage1(),
          decision: "filled",
          filledTcgdexId: CHARMANDER_SV03_026.tcgdexId,
          filledDexVariantRaw: "Normal",
        },
      ]),
      "Charmander is not a Charmeleon. Pick the Charmeleon you own for the Stage 1 stage (Charmeleon).",
    );
  });

  it("a placeholder's wishlist target, and each alternate, must be that stage's species", async () => {
    const wrong = /The wishlist card for the Stage 1 stage \(Charmeleon\) is not a Charmeleon/;
    await refusedWithNothingWritten(
      line([BASIC, stage1({ targetCatalogCardId: CHARMANDER_SV03_026.tcgdexId })]),
      wrong,
    );
    await refusedWithNothingWritten(
      line([BASIC, stage1({ alternateCatalogCardIds: [SCIZOR_SV03_141.tcgdexId] })]),
      wrong,
    );
  });

  it("a terminated line hunts nothing (Q1); Leave empty is still hers to choose there", async () => {
    await refusedWithNothingWritten(
      line([BASIC, stage1({ hunt: true })], { terminated: true }),
      "A terminated line has no stage to hunt. Choose Leave empty or Block for the Stage 1 stage (Charmeleon).",
    );
    await save(line([BASIC, stage1({ hunt: false })], { terminated: true }));
    expect(await tallies()).toMatchObject({ evolution_line: 1, wishlist_item: 0 });
  });

  it("a hunt with no same-colour printing to hunt is refused", async () => {
    // No Light blue Charmeleon exists, so there is nothing to put on the wishlist.
    await refusedWithNothingWritten(
      line([BASIC, stage1({ hunt: true, targetCatalogCardId: null })], {
        bandKey: "light_blue",
      }),
      "There is no Light blue Charmeleon to hunt for the Stage 1 stage (Charmeleon). Choose Leave empty or Block.",
    );
  });

  it("a block needs its material, its card when repurposed, and at least one pocket", async () => {
    const block = (extra: Partial<BackLineStageInput>): BackLineStageInput => ({
      stageIndex: 1,
      stage: "Stage1",
      dexId: 5,
      decision: "block",
      blockMaterial: "basicEnergy",
      pocketCount: 1,
      ...extra,
    });
    await refusedWithNothingWritten(
      line([BASIC, block({ blockMaterial: "glue" as never })]),
      /Choose what fills the block for the Stage 1 stage/,
    );
    await refusedWithNothingWritten(
      line([BASIC, block({ blockMaterial: "repurposedDuplicate", blockCopyTcgdexId: null })]),
      "Pick which duplicate was repurposed for the Stage 1 stage (Charmeleon).",
    );
    for (const pocketCount of [0, 1.5, undefined]) {
      await refusedWithNothingWritten(
        line([BASIC, block({ pocketCount })]),
        "The block for the Stage 1 stage (Charmeleon) needs at least one pocket.",
      );
    }
  });

  it("what the server derives it does not take from the browser: capped status and the wishlist's type", async () => {
    // The browser claims a specialty-only stage (a capped line) and a Water wish; the chain says neither.
    await save(
      line([BASIC, stage1({ hunt: true, specialtyOnly: true })], { requiredType: "Water" }),
    );
    await asSuperuser(db);
    expect((await db.query(`select status from evolution_line`)).rows).toEqual([
      { status: "open" },
    ]);
    expect(
      (await db.query(`select required_type, will_live_in_specialty from wishlist_item`)).rows,
    ).toEqual([{ required_type: "Fire", will_live_in_specialty: false }]);
  });
});

describe("UIL-117 PR 5 · every line she can save passes 0028's slot check", () => {
  const energyBlock: BackLineStageInput = {
    stageIndex: 1,
    stage: "Stage1",
    dexId: 5,
    decision: "block",
    blockMaterial: "basicEnergy",
    pocketCount: 2,
  };
  const dupBlock: BackLineStageInput = {
    ...energyBlock,
    blockMaterial: "repurposedDuplicate",
    blockCopyTcgdexId: SCIZOR_SV03_141.tcgdexId,
    blockCopyDexVariantRaw: "Holo",
    pocketCount: 1,
  };
  const filledStage1: BackLineStageInput = {
    ...stage1(),
    decision: "filled",
    filledTcgdexId: CHARMELEON_SV03_027.tcgdexId,
    filledDexVariantRaw: "Normal",
  };

  it.each([
    ["complete", [BASIC, filledStage1], false, "complete"],
    ["open, with a hunt", [BASIC, stage1({ hunt: true })], false, "open"],
    ["open, with a stage left empty", [BASIC, stage1({ hunt: false })], false, "open"],
    ["a basic-energy block", [BASIC, energyBlock], false, "open"],
    ["a repurposed-duplicate block", [BASIC, dupBlock], false, "open"],
    ["terminated", [BASIC, energyBlock], true, "terminated"],
  ] as const)("%s", async (_name, stages, terminated, status) => {
    await save(line([...stages], { terminated }));
    await asSuperuser(db);
    expect((await db.query(`select status from evolution_line`)).rows).toEqual([{ status }]);
    // Both pointers of every filled slot agree: the rule 0028 enforces, read back here as well.
    const bad = await db.query(
      `select s.id from line_slot s left join copy c on c.id = s.copy_id
        where s.state = 'filled' and (c.line_slot_id is distinct from s.id or c.binder_half <> 'back')`,
    );
    expect(bad.rows).toEqual([]);
  });
});
