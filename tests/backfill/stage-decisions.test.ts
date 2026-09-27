/**
 * UIL-117 C (C1) — every stage of a Backfill line is HER choice, checked on the server by the one shared rule, before
 * anything is written. Karvi (UIL-121): "Functionally, there are only 2 stages: open or closed", and nothing is written
 * for her. A stage is the card she has (waiting in her haul), a card she chases (her wishlist add), left empty (on no
 * wishlist), or a filler in its pocket (a basic energy, or a spare card from her haul). A complete line shorter than
 * three pockets asks what fills the third. A line mixing languages needs her OK and reads as its lowest card's.
 *
 * Pinned: each choice's writes; the line's status is her choices' (CLOSED unless one is chased); every refusal writes
 * NOTHING; the chain is resolved again on the server; and every shape she can save passes 0030's slot check.
 *
 * The REAL executor (`commitBackLine`) against real Postgres (PGlite) and the real `apply_write_ops`, as the owner.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  BackLineRefused,
  commitBackLine,
  type BackLineCommit,
  type BackLineStageInput,
  type BackfillStageChoice,
} from "@/lib/backfill";
import { STAGE_REFUSAL, StageChoiceRefusal } from "@/lib/line/stage-choice";
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
const CML_JA = "a0000000-0000-4000-8000-000000000004";
const JA_CHARMELEON = "ja:sv03-027";

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  // Without a Charizard printing, the Charmander chain here is two stages: a complete line has a third pocket.
  await seedCatalogCardsFull(db, [CHARMANDER_SV03_026, CHARMELEON_SV03_027, SCIZOR_SV03_141]);
  await db.query(
    `insert into catalog_card (tcgdex_id, name, dex_id, set_id, local_id, types, stage, card_class, locale)
     values ($1, 'Charmeleon', '{5}', 'ja:sv3', '027', '{Fire}', 'Stage1', 'standard', 'ja')`,
    [JA_CHARMELEON],
  );
  await seedBinders(db, [
    { id: B1, type: "general", name: "KB-001" },
    { id: SPEC, type: "specialty", name: "Specialty A" },
  ]);
  await seedHaulCopies(db, [
    { id: CMD, catalogCardId: CHARMANDER_SV03_026.tcgdexId },
    { id: CML, catalogCardId: CHARMELEON_SV03_027.tcgdexId },
    { id: SCZ, catalogCardId: SCIZOR_SV03_141.tcgdexId, variant: "holo", dexVariantRaw: "Holo" },
    { id: CML_JA, catalogCardId: JA_CHARMELEON },
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
async function roles(): Promise<string[]> {
  await asSuperuser(db);
  const r = await db.query<{ role: string }>(`select role from copy order by id`);
  await asOwner(db);
  return r.rows.map((x) => x.role);
}
async function read<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  await asSuperuser(db);
  const r = await db.query<T>(sql, params);
  await asOwner(db);
  return r.rows;
}

const HAVE_CMD: BackfillStageChoice = {
  kind: "have",
  tcgdexId: CHARMANDER_SV03_026.tcgdexId,
  dexVariantRaw: "Normal",
};
const basic = (choice: BackfillStageChoice | undefined = HAVE_CMD): BackLineStageInput => ({
  stageIndex: 0,
  stage: "Basic",
  dexId: 4,
  choice,
});
const stage1 = (choice: BackfillStageChoice | undefined): BackLineStageInput => ({
  stageIndex: 1,
  stage: "Stage1",
  dexId: 5,
  choice,
});
const line = (
  stages: BackLineStageInput[],
  extra: Partial<BackLineCommit> = {},
): BackLineCommit => ({
  binderId: B1,
  bandKey: "red",
  seedTcgdexId: CHARMANDER_SV03_026.tcgdexId,
  rootDexId: 4,
  stages,
  ...extra,
});
const save = (input: BackLineCommit) => commitBackLine(pgliteClient(db), OWNER, input);

async function refusedWithNothingWritten(
  input: BackLineCommit,
  message: RegExp | string,
  kind: typeof BackLineRefused | typeof StageChoiceRefusal = BackLineRefused,
) {
  const before = await roles();
  const err = await save(input).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(kind);
  expect((err as Error).message).toMatch(message);
  expect(await tallies()).toEqual(NOTHING);
  // Every copy where it was: her haul copies still wait (and a bulk box one is still in the bulk box).
  expect(await roles()).toEqual(before);
  expect(before.filter((r) => r === "haul")).toHaveLength(4);
}

const statusOfLine = async () =>
  (await read<{ status: string }>(`select status from evolution_line`))[0]?.status;
const stage1Slot = async () =>
  (
    await read<{ state: string; stage_choice: string | null; target: string | null }>(
      `select state, stage_choice, target_catalog_card_id target from line_slot where stage_index = 1`,
    )
  )[0];

describe("UIL-117 C · each stage choice writes what the shared rule says", () => {
  it("Chase: the slot targets that card, and it goes on her wishlist; the line stays OPEN", async () => {
    await save(
      line([basic(), stage1({ kind: "chase", catalogCardId: CHARMELEON_SV03_027.tcgdexId })]),
    );
    expect(await stage1Slot()).toEqual({
      state: "placeholder",
      stage_choice: "chase",
      target: CHARMELEON_SV03_027.tcgdexId,
    });
    expect(
      await read(`select chosen_catalog_card_id c, required_type t from wishlist_item`),
    ).toEqual([{ c: CHARMELEON_SV03_027.tcgdexId, t: "Fire" }]);
    expect(await statusOfLine()).toBe("open");
  });

  it("Leave empty: on NO wishlist, and a line with nothing chased reads CLOSED", async () => {
    await save(line([basic(), stage1({ kind: "empty" })]));
    expect(await stage1Slot()).toEqual({
      state: "placeholder",
      stage_choice: "empty",
      target: null,
    });
    expect(await tallies()).toMatchObject({ wishlist_item: 0 });
    expect(await statusOfLine()).toBe("closed");
  });

  it("Filler, a basic energy: a filler block in that pocket, no copy placed", async () => {
    await save(line([basic(), stage1({ kind: "filler", filler: { material: "energy" } })]));
    expect(await stage1Slot()).toEqual({ state: "block", stage_choice: "filler", target: null });
    expect(
      await read(
        `select purpose, material, copy_id from binder_block where line_slot_id is not null`,
      ),
    ).toEqual([{ purpose: "line-filler", material: "basicEnergy", copy_id: null }]);
    expect(await statusOfLine()).toBe("closed");
  });

  it("Filler, a spare card from her haul: THAT copy becomes the block, with its line-filler decision", async () => {
    await save(
      line([
        basic(),
        stage1({
          kind: "filler",
          filler: { material: "card", tcgdexId: SCIZOR_SV03_141.tcgdexId, dexVariantRaw: "Holo" },
        }),
      ]),
    );
    expect(
      await read(`select role, binder_half, line_slot_id from copy where id = $1`, [SCZ]),
    ).toEqual([{ role: "block", binder_half: "back", line_slot_id: null }]);
    expect(await read(`select copy_id, purpose from binder_block`)).toEqual([
      { copy_id: SCZ, purpose: "line-filler" },
    ]);
    expect(await read(`select decision from placement_decision where copy_id = $1`, [SCZ])).toEqual(
      [{ decision: "line-filler" }],
    );
  });

  it("Chase a placeholder card she makes: a catalog-only stand-in, and her wish for it", async () => {
    await save(
      line([
        basic(),
        stage1({
          kind: "chase",
          newStandIn: { name: "Charmeleon", setName: "Trainer Kit", localId: "7", language: "en" },
        }),
      ]),
    );
    const [slot] = await read<{ target: string }>(
      `select target_catalog_card_id target from line_slot where stage_index = 1`,
    );
    expect(slot.target).toMatch(/^user:/);
    expect(
      await read(`select name, dex_id, stage, source from catalog_card where tcgdex_id = $1`, [
        slot.target,
      ]),
    ).toEqual([{ name: "Charmeleon", dex_id: [5], stage: "Stage1", source: "user" }]);
    expect(await tallies()).toMatchObject({ wishlist_item: 1 });
  });
});

describe("the Senior BA's ruling · a spare card fills a pocket from her bulk box first, or her haul", () => {
  const BULK_SCZ = "b0000000-0000-4000-8000-0000000000b1";
  const bulkCard = (copyId = BULK_SCZ) =>
    ({ kind: "filler", filler: { material: "card", from: "bulk", copyId } }) as const;
  beforeEach(async () => {
    await asSuperuser(db);
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, variant, role) values ($1, $2, $3, 'normal', 'bulk')`,
      [BULK_SCZ, OWNER, SCIZOR_SV03_141.tcgdexId],
    );
    await asOwner(db);
  });
  const roleOf = async (id: string) =>
    (await read<{ role: string }>(`select role from copy where id = $1`, [id]))[0]?.role;

  it("a bulk box card: THAT copy leaves the bulk box and becomes the block, and no haul card is taken", async () => {
    await save(line([basic(), stage1(bulkCard())]));
    expect(await read(`select role, binder_half from copy where id = $1`, [BULK_SCZ])).toEqual([
      { role: "block", binder_half: "back" },
    ]);
    expect(await read(`select copy_id, purpose from binder_block`)).toEqual([
      { copy_id: BULK_SCZ, purpose: "line-filler" },
    ]);
    expect(
      await read(`select decision from placement_decision where copy_id = $1`, [BULK_SCZ]),
    ).toEqual([{ decision: "line-filler" }]);
    // Her haul Scizor still waits: only the Charmander she has left the haul.
    expect(await roleOf(SCZ)).toBe("haul");
  });

  it("the third pocket takes one too", async () => {
    await save(
      line(
        [
          basic(),
          stage1({ kind: "have", tcgdexId: CHARMELEON_SV03_027.tcgdexId, dexVariantRaw: "Normal" }),
        ],
        { thirdPocket: { material: "card", from: "bulk", copyId: BULK_SCZ } },
      ),
    );
    expect(await read(`select extra_pocket from evolution_line`)).toEqual([
      { extra_pocket: "card" },
    ]);
    expect(await roleOf(BULK_SCZ)).toBe("block");
  });

  it("one bulk box copy fills one pocket: the same copy twice is refused, with nothing written", async () => {
    await refusedWithNothingWritten(
      line([basic(bulkCard()), stage1(bulkCard())]),
      STAGE_REFUSAL.fillerNotInBulk,
      StageChoiceRefusal,
    );
    expect(await roleOf(BULK_SCZ)).toBe("bulk");
  });

  it("a card that is not in her bulk box is refused in its words, with nothing written", async () => {
    // Her haul Scizor, named as if it were in the bulk box.
    await refusedWithNothingWritten(
      line([basic(), stage1(bulkCard(SCZ))]),
      STAGE_REFUSAL.fillerNotInBulk,
      StageChoiceRefusal,
    );
    expect(await roleOf(BULK_SCZ)).toBe("bulk");
  });
});

describe("UIL-117 C · every stage is her choice, and a refusal writes nothing", () => {
  it("a stage she has not decided is refused (the shared rule's words)", async () => {
    await refusedWithNothingWritten(
      line([basic(), stage1(undefined)]),
      STAGE_REFUSAL.missing("Stage1"),
    );
  });

  it("a chase of another species is refused by the shared rule, with nothing written", async () => {
    await refusedWithNothingWritten(
      line([basic(), stage1({ kind: "chase", catalogCardId: CHARMANDER_SV03_026.tcgdexId })]),
      STAGE_REFUSAL.wrongSpecies("Charmeleon"),
      StageChoiceRefusal,
    );
  });

  it("a chase of a card in another language than the line is refused", async () => {
    await refusedWithNothingWritten(
      line([basic(), stage1({ kind: "chase", catalogCardId: JA_CHARMELEON })]),
      STAGE_REFUSAL.otherLanguage,
      StageChoiceRefusal,
    );
  });

  it("a card she has must be that stage's species", async () => {
    await refusedWithNothingWritten(
      line([basic(), stage1({ ...HAVE_CMD })]),
      "Charmander is not a Charmeleon. Pick the Charmeleon you have for the Stage 1 stage (Charmeleon).",
    );
  });

  it("a missing binder, a specialty binder, an unset band, a wrong root, and stages off the chain", async () => {
    const ok = [basic(), stage1({ kind: "empty" })];
    await refusedWithNothingWritten(
      line(ok, { binderId: "1c000000-0000-0000-0000-00000000dead" }),
      /That binder no longer exists/,
    );
    await refusedWithNothingWritten(line(ok, { binderId: SPEC }), /specialty binder/);
    await refusedWithNothingWritten(
      line(ok, { bandKey: "ultraviolet" }),
      /colour band is not set up/,
    );
    await refusedWithNothingWritten(line(ok, { rootDexId: 6 }), /not the Charmander line/);
    await refusedWithNothingWritten(line([basic()]), /stages are not the Charmander line's/);
  });
});

describe("UIL-121 Q4 · a complete line shorter than three pockets: the third pocket", () => {
  const complete = [
    basic(),
    stage1({ kind: "have", tcgdexId: CHARMELEON_SV03_027.tcgdexId, dexVariantRaw: "Normal" }),
  ];

  it("is required, and refused without a choice", async () => {
    await refusedWithNothingWritten(
      line(complete),
      STAGE_REFUSAL.thirdPocketMissing,
      StageChoiceRefusal,
    );
  });

  it("a basic energy: recorded on the line, with its filler block; the line reads CLOSED", async () => {
    await save(line(complete, { thirdPocket: { material: "energy" } }));
    expect(await read(`select status, extra_pocket from evolution_line`)).toEqual([
      { status: "closed", extra_pocket: "energy" },
    ]);
    expect(
      await read(`select material, line_slot_id from binder_block where purpose = 'line-filler'`),
    ).toEqual([{ material: "basicEnergy", line_slot_id: null }]);
  });

  it("left empty: recorded, with no block", async () => {
    await save(line(complete, { thirdPocket: { material: "empty" } }));
    expect(await read(`select extra_pocket from evolution_line`)).toEqual([
      { extra_pocket: "empty" },
    ]);
    expect(await tallies()).toMatchObject({ binder_block: 0 });
  });

  it("is refused on a line that is not complete (nothing to fill)", async () => {
    await refusedWithNothingWritten(
      line([basic(), stage1({ kind: "empty" })], { thirdPocket: { material: "energy" } }),
      STAGE_REFUSAL.noThirdPocket,
      StageChoiceRefusal,
    );
  });
});

describe("the Senior BA's ruling · a line mixing languages needs her OK", () => {
  const mixed = [
    basic(),
    stage1({ kind: "have", tcgdexId: JA_CHARMELEON, dexVariantRaw: "Normal" }),
  ];

  it("is refused without it, naming the languages and what it will read as", async () => {
    await refusedWithNothingWritten(
      line(mixed, { thirdPocket: { material: "empty" } }),
      "This line mixes English and Japanese cards; it will read as English. Confirm that to save it.",
    );
  });

  it("is written with it", async () => {
    await save(line(mixed, { thirdPocket: { material: "empty" }, mixedLanguageOk: true }));
    expect(await tallies()).toMatchObject({ evolution_line: 1, line_slot: 2 });
    // By copy id: her Charmander and the Japanese Charmeleon are shelved; the other two still wait.
    expect(await roles()).toEqual(["shelved", "haul", "haul", "shelved"]);
  });
});

describe("UIL-117 C · every line she can save passes 0030's slot check", () => {
  it.each([
    [
      "a chase",
      [basic(), stage1({ kind: "chase", catalogCardId: CHARMELEON_SV03_027.tcgdexId })],
      {},
    ],
    ["left empty", [basic(), stage1({ kind: "empty" })], {}],
    ["an energy filler", [basic(), stage1({ kind: "filler", filler: { material: "energy" } })], {}],
    [
      "a card filler",
      [
        basic(),
        stage1({
          kind: "filler",
          filler: { material: "card", tcgdexId: SCIZOR_SV03_141.tcgdexId, dexVariantRaw: "Holo" },
        }),
      ],
      {},
    ],
    [
      "complete, with a card in the third pocket",
      [
        basic(),
        stage1({ kind: "have", tcgdexId: CHARMELEON_SV03_027.tcgdexId, dexVariantRaw: "Normal" }),
      ],
      {
        thirdPocket: {
          material: "card" as const,
          tcgdexId: SCIZOR_SV03_141.tcgdexId,
          dexVariantRaw: "Holo",
        },
      },
    ],
    ["every stage empty but the one she has", [basic(), stage1({ kind: "empty" })], {}],
  ] as const)("%s", async (_name, stages, extra) => {
    await save(line([...stages], extra as Partial<BackLineCommit>));
    // Both pointers of every filled slot agree: the rule 0030's assert_line_slots enforces, read back here as well.
    expect(
      await read(
        `select s.id from line_slot s left join copy c on c.id = s.copy_id
          where s.state = 'filled' and (c.line_slot_id is distinct from s.id or c.binder_half <> 'back')`,
      ),
    ).toEqual([]);
    expect(await tallies()).toMatchObject({ evolution_line: 1 });
  });
});
