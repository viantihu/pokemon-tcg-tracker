/**
 * UIL-117, the Senior BA's follow-up to #422: the Haul Plan's own Move sheet sends a back half through the ONE line
 * popup, as Lines, Lookup and Collections do. Its line choice rides with the back-half move (`override`), and the one
 * line builder writes it, stage choices included, whatever the cascade routed the card to. Before, the sheet's inline
 * line picker wrote the line with every unfilled stage undecided, and she was never asked.
 *
 * The REAL commit (`commitCardPlacement`), the REAL `apply_write_ops`, on PGlite, as the owner.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { clearCatalogCache, commitCardPlacement, LINE_CHOICE, type DraftItem } from "@/lib/plan";
import { JOIN_UNCONFIRMED, type LineChoice } from "@/lib/line/popup";
import type { MoveDestination } from "@/lib/line/types";
import { KEEP_IS_NO_LINE_MOVE } from "@/lib/line/write";
import { CHARMANDER_SV03_026, CHARMELEON_SV03_027 } from "../engine/fixtures";
import { OWNER } from "../support/pglite-rpc";
import {
  asOwner,
  asSuperuser,
  freshRpcDb,
  haulRow,
  seedBinders,
  seedCatalogCardsFull,
  seedHaulRows,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const KB1 = "1c000000-0000-0000-0000-0000000000b1";
const BACK: MoveDestination = { kind: "shelf", binderId: KB1, half: "back", band: "red" };
/** Her Charmander: a Basic the cascade files in a front half (nothing to join, no line yet). */
const CMD: DraftItem = haulRow(
  "d0000000-0000-4000-8000-0000000000e1",
  CHARMANDER_SV03_026.tcgdexId,
);
/** She starts its line here and CHASES the Stage 1: a stage choice the old inline picker never asked. */
const START_CHASING: LineChoice = {
  mode: "start",
  binderId: KB1,
  band: "red",
  pulls: [],
  stages: { 1: { kind: "chase", catalogCardId: CHARMELEON_SV03_027.tcgdexId } },
};

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedCatalogCardsFull(db, [CHARMANDER_SV03_026, CHARMELEON_SV03_027]);
  await seedBinders(db, [{ id: KB1, type: "general", name: "KB-001" }]);
  await seedHaulRows(db, [CMD]);
  clearCatalogCache();
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

async function read<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  await asSuperuser(db);
  const r = await db.query<T>(sql, params);
  await asOwner(db);
  return r.rows;
}
const move = (override: MoveDestination, lineChoice: LineChoice) =>
  commitCardPlacement(pgliteClient(db), { card: CMD, override, lineChoice });
const nothingWritten = async () => {
  expect(await read(`select id from evolution_line`)).toEqual([]);
  expect(await read(`select role from copy where id = $1`, [CMD.id])).toEqual([{ role: "haul" }]);
};

describe("the Plan's Move sheet → back half → the line popup's choice is what is written", () => {
  it("her start, with the Stage 1 she chose to chase, is written by the one line builder", async () => {
    const res = await move(BACK, START_CHASING);
    expect(res.counts.lines).toBe(1);
    expect(
      await read(
        `select stage_index, state, stage_choice, target_catalog_card_id target from line_slot order by stage_index`,
      ),
    ).toEqual([
      { stage_index: 0, state: "filled", stage_choice: null, target: CHARMANDER_SV03_026.tcgdexId },
      {
        stage_index: 1,
        state: "placeholder",
        stage_choice: "chase",
        target: CHARMELEON_SV03_027.tcgdexId,
      },
    ]);
    expect(await read(`select chosen_catalog_card_id c from wishlist_item`)).toEqual([
      { c: CHARMELEON_SV03_027.tcgdexId },
    ]);
    expect(
      await read(
        `select role, binder_half, line_slot_id is not null in_slot from copy where id = $1`,
        [CMD.id],
      ),
    ).toEqual([{ role: "shelved", binder_half: "back", in_slot: true }]);
    expect(
      await read(`select decision from placement_decision where copy_id = $1`, [CMD.id]),
    ).toEqual([{ decision: "line-start" }]);
  });

  it("a stage she has not decided is refused in the shared rule's words, with nothing written", async () => {
    await expect(move(BACK, { ...START_CHASING, stages: {} })).rejects.toThrow(
      "Choose what goes in the Stage 1 slot.",
    );
    await nothingWritten();
  });

  it("a line choice with a move anywhere but a back half is refused: the screen and the server disagree", async () => {
    await expect(
      move({ kind: "shelf", binderId: KB1, half: "front", band: "red" }, START_CHASING),
    ).rejects.toThrow(LINE_CHOICE.notALineCard);
    await nothingWritten();
  });

  it("a Keep is no move into a line, and is refused", async () => {
    await expect(
      move(BACK, { mode: "replace", lineId: "L", slotId: "S", keep: true }),
    ).rejects.toThrow(KEEP_IS_NO_LINE_MOVE);
    await nothingWritten();
  });
});

describe("…and a JOIN through the Move sheet is held to the line's own slot (TL review of #434)", () => {
  const LINE = "10000000-0000-0000-0000-0000000000e1";
  const S0 = "50000000-0000-0000-0000-0000000000e0";
  const S1 = "50000000-0000-0000-0000-0000000000e1";
  const OWNED_CMD = "c0000000-0000-0000-0000-0000000000e0";
  /** Her Charmeleon, waiting in the haul. */
  const CML: DraftItem = haulRow(
    "d0000000-0000-4000-8000-0000000000e2",
    CHARMELEON_SV03_027.tcgdexId,
  );
  beforeEach(async () => {
    await seedHaulRows(db, [CML]);
    await asSuperuser(db);
    // Her Charmander line in KB-001 · Back · Red: the Basic filled, the Stage 1 an open slot.
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band) values
        ('${OWNED_CMD}', '${OWNER}', '${CHARMANDER_SV03_026.tcgdexId}', 'normal', 'shelved', '${KB1}', 'back', 'red');
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
        values ('${LINE}', '${OWNER}', 4, 'red', '${KB1}', 'back', 'open');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id, target_catalog_card_id) values
        ('${S0}', '${OWNER}', '${LINE}', 0, 'Basic', 'filled', '${OWNED_CMD}', null),
        ('${S1}', '${OWNER}', '${LINE}', 1, 'Stage1', 'placeholder', null, null);
      update copy set line_slot_id = '${S0}' where id = '${OWNED_CMD}';
    `);
    await asOwner(db);
  });
  const join = (card: DraftItem, slotId: string) =>
    commitCardPlacement(pgliteClient(db), {
      card,
      override: BACK,
      // A two-stage line her join completes: she says what fills its third pocket (UIL-121 Q4).
      lineChoice: { mode: "join", lineId: LINE, slotId, thirdPocket: { material: "empty" } },
    });

  it("an Add to the open slot of the card's stage fills it, both pointers agreeing, with a line-join decision", async () => {
    await join(CML, S1);
    expect(await read(`select state, copy_id from line_slot where id = $1`, [S1])).toEqual([
      { state: "filled", copy_id: CML.id },
    ]);
    expect(
      await read(`select role, binder_half, line_slot_id from copy where id = $1`, [CML.id]),
    ).toEqual([{ role: "shelved", binder_half: "back", line_slot_id: S1 }]);
    expect(
      await read(`select decision, line_id from placement_decision where copy_id = $1`, [CML.id]),
    ).toEqual([{ decision: "line-join", line_id: LINE }]);
  });

  it("a join naming a slot of ANOTHER species is refused, with nothing written", async () => {
    // Her Charmander (the Basic) named for the Stage 1 slot: any card can bring a line choice now, so this holds it.
    const err = await join(CMD, S1).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Error).message).toBe(
      "That slot is for a different card — pick the slot for this card's own stage.",
    );
    expect(await read(`select state, copy_id from line_slot where id = $1`, [S1])).toEqual([
      { state: "placeholder", copy_id: null },
    ]);
    expect(await read(`select role, line_slot_id from copy where id = $1`, [CMD.id])).toEqual([
      { role: "haul", line_slot_id: null },
    ]);
    expect(await read(`select id from placement_decision`)).toEqual([]);
  });

  it("…and so is a join into ANOTHER family's line at the card's own stage: the line's root is held too", async () => {
    // A Squirtle line (root 7) with an undecided Stage 1: her Charmeleon is a Stage 1, but not of this line.
    const SQUIRTLE_LINE = "10000000-0000-0000-0000-0000000000e7";
    const SQ1 = "50000000-0000-0000-0000-0000000000e7";
    await asSuperuser(db);
    await db.exec(`
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
        values ('${SQUIRTLE_LINE}', '${OWNER}', 7, 'red', '${KB1}', 'back', 'open');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id, target_catalog_card_id)
        values ('${SQ1}', '${OWNER}', '${SQUIRTLE_LINE}', 1, 'Stage1', 'placeholder', null, null);
    `);
    await asOwner(db);
    await expect(
      commitCardPlacement(pgliteClient(db), {
        card: CML,
        override: BACK,
        lineChoice: { mode: "join", lineId: SQUIRTLE_LINE, slotId: SQ1 },
      }),
    ).rejects.toThrow("That slot is for a different card");
    expect(await read(`select state from line_slot where id = $1`, [SQ1])).toEqual([
      { state: "placeholder" },
    ]);
    expect(await read(`select role from copy where id = $1`, [CML.id])).toEqual([{ role: "haul" }]);
  });
});

/**
 * Branching families (the Senior BA's ruling and the TL's review of #434). A join is held to THIS card's own chain,
 * which follows its branch, and to its neighbours in the line: never to one species per stage seeded from the root.
 * Her live Charcadet line (root 935) has a Stage 1 of Armarouge (936) OR Ceruledge (937). The Twig family is the
 * Wurmple / Applin shape: Twigling → Twigleaf → Twigtree, and Twigling → Twigthorn → Thornking.
 */
describe("a join into a BRANCHING family's line is held to its own branch and its neighbours", () => {
  const mk = (tcgdexId: string, name: string, dex: number, stage: string, from: string | null) => ({
    ...CHARMANDER_SV03_026,
    tcgdexId,
    name,
    dexId: [dex],
    localId: tcgdexId.split("-")[1],
    stage,
    evolveFrom: from,
    artworkGroupId: `art-${name}`,
  });
  const CHARCADET = mk("sv04-9350", "Charcadet", 935, "Basic", null);
  const ARMAROUGE = mk("sv04-9360", "Armarouge", 936, "Stage1", "Charcadet");
  const CERULEDGE = mk("sv04-9370", "Ceruledge", 937, "Stage1", "Charcadet");
  const TWIGLING = mk("sv05-9500", "Twigling", 950, "Basic", null);
  const TWIGLEAF = mk("sv05-9510", "Twigleaf", 951, "Stage1", "Twigling");
  const TWIGTREE = mk("sv05-9520", "Twigtree", 952, "Stage2", "Twigleaf");
  const TWIGTHORN = mk("sv05-9530", "Twigthorn", 953, "Stage1", "Twigling");
  const THORNKING = mk("sv05-9540", "Thornking", 954, "Stage2", "Twigthorn");
  const haul = (name: string, tcgdexId: string, n: number) =>
    haulRow(`d0000000-0000-4000-8000-00000000f${String(n).padStart(3, "0")}`, tcgdexId);
  const H = {
    armarouge: haul("Armarouge", ARMAROUGE.tcgdexId, 1),
    ceruledge: haul("Ceruledge", CERULEDGE.tcgdexId, 2),
    charcadet: haul("Charcadet", CHARCADET.tcgdexId, 3),
    twigleaf: haul("Twigleaf", TWIGLEAF.tcgdexId, 4),
    twigthorn: haul("Twigthorn", TWIGTHORN.tcgdexId, 5),
    thornking: haul("Thornking", THORNKING.tcgdexId, 6),
  };
  const LINE = "10000000-0000-0000-0000-0000000000f1";
  const slotId = (i: number) => `50000000-0000-0000-0000-0000000000f${i}`;
  const ownedId = (i: number) => `c0000000-0000-0000-0000-0000000000f${i}`;

  beforeEach(async () => {
    await asSuperuser(db);
    await seedCatalogCardsFull(db, [
      CHARCADET,
      ARMAROUGE,
      CERULEDGE,
      TWIGLING,
      TWIGLEAF,
      TWIGTREE,
      TWIGTHORN,
      THORNKING,
    ]);
    await seedHaulRows(db, Object.values(H));
    clearCatalogCache();
    await asOwner(db);
  });

  /**
   * A red line in KB-001's back half, one slot per stage: a card's id fills it, `open` leaves it undecided (with an
   * optional leftover engine target), `chase` is her chase of that card.
   */
  async function seedLine(
    root: number,
    stages: ({ card: string } | { open: true; leftoverTarget?: string } | { chase: string })[],
  ) {
    await asSuperuser(db);
    await db.query(
      `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
         values ($1, $2, $3, 'red', $4, 'back', 'open')`,
      [LINE, OWNER, root, KB1],
    );
    for (const [i, st] of stages.entries()) {
      const stage = ["Basic", "Stage1", "Stage2"][i];
      if ("card" in st) {
        await db.query(
          `insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band)
             values ($1, $2, $3, 'normal', 'shelved', $4, 'back', 'red')`,
          [ownedId(i), OWNER, st.card, KB1],
        );
      }
      await db.query(
        `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id, target_catalog_card_id, stage_choice)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          slotId(i),
          OWNER,
          LINE,
          i,
          stage,
          "card" in st ? "filled" : "placeholder",
          "card" in st ? ownedId(i) : null,
          "card" in st ? null : "chase" in st ? st.chase : (st.leftoverTarget ?? null),
          "chase" in st ? "chase" : null,
        ],
      );
      if ("card" in st) {
        await db.query(`update copy set line_slot_id = $1 where id = $2`, [slotId(i), ownedId(i)]);
      }
    }
    await asOwner(db);
  }
  const joinAt = (card: DraftItem, i: number, twoStage = false) =>
    commitCardPlacement(pgliteClient(db), {
      card,
      override: BACK,
      lineChoice: {
        mode: "join",
        lineId: LINE,
        slotId: slotId(i),
        ...(twoStage ? { thirdPocket: { material: "empty" as const } } : {}),
      },
    });
  const WRONG = "That slot is for a different card — pick the slot for this card's own stage.";
  async function refusedAt(card: DraftItem, i: number) {
    await expect(joinAt(card, i)).rejects.toThrow(WRONG);
    expect(await read(`select state, copy_id from line_slot where id = $1`, [slotId(i)])).toEqual([
      { state: "placeholder", copy_id: null },
    ]);
    expect(await read(`select role from copy where id = $1`, [card.id])).toEqual([
      { role: "haul" },
    ]);
  }
  const filledBy = async (i: number) =>
    (await read<{ copy_id: string }>(`select copy_id from line_slot where id = $1`, [slotId(i)]))[0]
      ?.copy_id;

  it("Charcadet's Stage 1 takes Armarouge", async () => {
    await seedLine(935, [{ card: CHARCADET.tcgdexId }, { open: true }]);
    await joinAt(H.armarouge, 1, true);
    expect(await filledBy(1)).toBe(H.armarouge.id);
  });

  it("…and Ceruledge, even with a leftover engine target naming Armarouge on the undecided slot", async () => {
    // PRE-FIX of the TL's point: any target was trusted, so the old Armarouge target refused her Ceruledge.
    await seedLine(935, [
      { card: CHARCADET.tcgdexId },
      { open: true, leftoverTarget: ARMAROUGE.tcgdexId },
    ]);
    await joinAt(H.ceruledge, 1, true);
    expect(await filledBy(1)).toBe(H.ceruledge.id);
  });

  it("a stage she CHASES is held to her chase: Ceruledge is refused where she chases Armarouge", async () => {
    await seedLine(935, [{ card: CHARCADET.tcgdexId }, { chase: ARMAROUGE.tcgdexId }]);
    await refusedAt(H.ceruledge, 1);
  });

  it("with the Basic not filled yet, the root and the depth still refuse a wrong card", async () => {
    await seedLine(935, [{ open: true }, { open: true }]);
    // Another family's Stage 1, and this family's Basic at the Stage 1 slot.
    await refusedAt(H.twigleaf, 1);
    await refusedAt(H.charcadet, 1);
  });

  it("Twigleaf joins between Twigling and Twigtree: its own branch, and its neighbours agree", async () => {
    await seedLine(950, [{ card: TWIGLING.tcgdexId }, { open: true }, { card: TWIGTREE.tcgdexId }]);
    await joinAt(H.twigleaf, 1);
    expect(await filledBy(1)).toBe(H.twigleaf.id);
  });

  it("the TL's case 1: Twigthorn is refused between Twigling and Twigtree (the stage after is not its own)", async () => {
    await seedLine(950, [{ card: TWIGLING.tcgdexId }, { open: true }, { card: TWIGTREE.tcgdexId }]);
    await refusedAt(H.twigthorn, 1);
  });

  it("the TL's case 2: Thornking is refused after Twigleaf (the stage before is not its parent)", async () => {
    await seedLine(950, [{ card: TWIGLING.tcgdexId }, { card: TWIGLEAF.tcgdexId }, { open: true }]);
    await refusedAt(H.thornking, 2);
  });
});

/**
 * A card whose own language's catalog cannot walk back to a Basic (QA's gate on #434: 69 Japanese sets are short
 * upstream). The line's own chain stands in, from its highest known card; where that cannot reach the root or this
 * stage either, the catalog cannot tell, and she is told so in her words (JOIN_UNCONFIRMED), not "a different card".
 */
describe("a join the catalog cannot walk back from: the line's own chain stands in, or she is told it can't be confirmed", () => {
  const LINE = "10000000-0000-0000-0000-0000000000d1";
  const slotId = (i: number) => `50000000-0000-0000-0000-0000000000d${i}`;
  const ownedId = (i: number) => `c0000000-0000-0000-0000-0000000000d${i}`;
  const ja = (tcgdexId: string, name: string, dex: number, stage: string, from: string) => ({
    ...CHARMELEON_SV03_027,
    tcgdexId,
    name,
    dexId: [dex],
    stage,
    evolveFrom: from,
    artworkGroupId: `art-${tcgdexId}`,
  });
  // Japanese printings whose earlier stage is not in the catalog.
  const JA_CHARMELEON = ja("ja:sv3-027", "リザード", 5, "Stage1", "ヒトカゲ");
  const JA_CHARIZARD = ja("ja:sv3-028", "リザードン", 6, "Stage2", "リザード-missing");
  // A family whose Basic is not in the catalog in any language: Blazy (9601) → Blazeon (9602) → Blazking (9603).
  const BLAZEON = { ...ja("sv09-9602", "Blazeon", 9602, "Stage1", "Blazy"), locale: "en" };
  const BLAZKING = { ...ja("sv09-9603", "Blazking", 9603, "Stage2", "Blazeon"), locale: "en" };
  const JA_BLAZKING = ja("ja:sv9-9603", "ブレイズキング", 9603, "Stage2", "ブレイズ-missing");
  const H = {
    jaCharmeleon: haulRow("d0000000-0000-4000-8000-0000000000d1", JA_CHARMELEON.tcgdexId),
    jaCharizard: haulRow("d0000000-0000-4000-8000-0000000000d2", JA_CHARIZARD.tcgdexId),
    jaBlazking: haulRow("d0000000-0000-4000-8000-0000000000d3", JA_BLAZKING.tcgdexId),
  };
  beforeEach(async () => {
    await asSuperuser(db);
    for (const c of [JA_CHARMELEON, JA_CHARIZARD, JA_BLAZKING]) {
      await db.query(
        `insert into catalog_card (tcgdex_id, name, dex_id, set_id, local_id, types, stage, evolve_from, card_class, locale)
           values ($1, $2, $3, 'ja:sv3', '027', '{Fire}', $4, $5, 'standard', 'ja')`,
        [c.tcgdexId, c.name, c.dexId, c.stage, c.evolveFrom],
      );
    }
    await seedCatalogCardsFull(db, [BLAZEON, BLAZKING]);
    await seedHaulRows(db, Object.values(H));
    clearCatalogCache();
    await asOwner(db);
  });
  async function seedLine(root: number, stages: ({ card: string } | { open: true })[]) {
    await asSuperuser(db);
    await db.query(
      `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
         values ($1, $2, $3, 'red', $4, 'back', 'open')`,
      [LINE, OWNER, root, KB1],
    );
    for (const [i, st] of stages.entries()) {
      if ("card" in st) {
        await db.query(
          `insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band)
             values ($1, $2, $3, 'normal', 'shelved', $4, 'back', 'red')`,
          [ownedId(i), OWNER, st.card, KB1],
        );
      }
      await db.query(
        `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
           values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          slotId(i),
          OWNER,
          LINE,
          i,
          ["Basic", "Stage1", "Stage2"][i],
          "card" in st ? "filled" : "placeholder",
          "card" in st ? ownedId(i) : null,
        ],
      );
      if ("card" in st) {
        await db.query(`update copy set line_slot_id = $1 where id = $2`, [slotId(i), ownedId(i)]);
      }
    }
    await asOwner(db);
  }
  const joinAt = (card: DraftItem, i: number, extra: Partial<LineChoice> = {}) =>
    commitCardPlacement(pgliteClient(db), {
      card,
      override: BACK,
      lineChoice: { mode: "join", lineId: LINE, slotId: slotId(i), ...extra } as LineChoice,
    });
  const untouched = async (card: DraftItem, i: number) => {
    expect(await read(`select state from line_slot where id = $1`, [slotId(i)])).toEqual([
      { state: "placeholder" },
    ]);
    expect(await read(`select role from copy where id = $1`, [card.id])).toEqual([
      { role: "haul" },
    ]);
  };

  it("accepts from the line's own chain: a Japanese Charmeleon into an English Charmander line's Stage 1, with her OK for the language", async () => {
    await seedLine(4, [{ card: CHARMANDER_SV03_026.tcgdexId }, { open: true }]);
    await joinAt(H.jaCharmeleon, 1, {
      foreignLocale: true,
      thirdPocket: { material: "empty" },
    } as Partial<LineChoice>);
    expect(await read(`select copy_id from line_slot where id = $1`, [slotId(1)])).toEqual([
      { copy_id: H.jaCharmeleon.id },
    ]);
  });

  it("a slot above every card the line's chain knows: the catalog cannot tell, and she is told so", async () => {
    // The English catalog here has no Charizard, so the line's chain stops at the Stage 1.
    await seedLine(4, [{ card: CHARMANDER_SV03_026.tcgdexId }, { open: true }, { open: true }]);
    await expect(joinAt(H.jaCharizard, 2)).rejects.toThrow(JOIN_UNCONFIRMED);
    await untouched(H.jaCharizard, 2);
  });

  it("the line's chain must reach the line's root: one that does not is no stand-in (QA's Jf)", async () => {
    // Blazy's line, with only its Blazking known: that chain starts at Blazeon, one stage off the line's own.
    // Without the root check, its Stage 1 (Blazking at index 1) would take her Japanese Blazking.
    await seedLine(9601, [{ open: true }, { open: true }, { card: BLAZKING.tcgdexId }]);
    await expect(joinAt(H.jaBlazking, 1)).rejects.toThrow(JOIN_UNCONFIRMED);
    await untouched(H.jaBlazking, 1);
  });
});
