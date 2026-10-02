/**
 * UIL-133, her report: "I'm not able to move arven's toedscool to the other toedscool line." Reproduced on the Database
 * Engineer's read of Testing (2026-10-02), with its ids: two Toedscool lines in one binder, both orange, both open.
 *
 *   206bfa6a (Arven's, made 09-30 01:43)  Basic: she CHASES sv10-109 (Arven's Toedscool)  Stage 1: Arven's Toedscruel
 *   d5649e38 (plain, made 5 minutes before)  Basic: she chases sv03-118 (Toedscool)          Stage 1: Toedscruel
 *
 * Her Arven's Toedscool (sv10-109) waiting in the haul was proposed into the PLAIN line: both Basics were chased dex
 * 948 in one binder and band, so the cascade fell to "the oldest". And the ADD popup that opened listed no other line,
 * so she had no way to her Arven's line from it. The fix ranks a stage chasing her exact printing first (the Senior
 * BA's ruling), then lines of the card's own form, and lists the family's other lines on an ADD.
 *
 * Real TCGdex printings (2026-10-01): sv03-118 Toedscool Fighting, sv09-089 Toedscruel Fighting, sv01-024 Toedscool
 * Grass, sv10-109 Arven's Toedscool Fighting, sv10-110 Arven's Toedscruel Fighting (evolves from "Arven's Toedscool").
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { CatalogCard } from "@/lib/engine";
import { applyMove, loadLineScreen } from "@/lib/line";
import { loadLinePopupModel } from "@/lib/line/popup-load";
import { clearCatalogCache, commitCardPlacement, loadPlanContext, planFromDraft } from "@/lib/plan";
import { CHARMANDER_SV03_026 } from "../engine/fixtures";
import {
  asOwner,
  asSuperuser,
  freshRpcDb,
  haulRow,
  OWNER,
  seedBinders,
  seedCatalogCardsFull,
  seedHaulRows,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const real = (
  id: string,
  name: string,
  dex: number,
  stage: string,
  evolveFrom: string | null,
  type: string,
): CatalogCard => ({
  ...CHARMANDER_SV03_026,
  tcgdexId: id,
  name,
  dexId: [dex],
  setId: id.split("-")[0],
  localId: id.split("-")[1],
  stage,
  evolveFrom,
  types: [type],
  artworkGroupId: `art-${id}`,
});

const CATALOG = [
  real("sv01-024", "Toedscool", 948, "Basic", null, "Grass"),
  real("sv03-118", "Toedscool", 948, "Basic", null, "Fighting"),
  real("sv09-089", "Toedscruel", 949, "Stage1", "Toedscool", "Fighting"),
  real("sv10-109", "Arven's Toedscool", 948, "Basic", null, "Fighting"),
  real("sv10-110", "Arven's Toedscruel", 949, "Stage1", "Arven's Toedscool", "Fighting"),
  // A Hisuian Decidueye evolves from a plain Dartrix (TCGdex, 2026-10-02).
  real("2017sm-1", "Rowlet", 722, "Basic", null, "Grass"),
  real("sv06.5-004", "Dartrix", 723, "Stage1", "Rowlet", "Grass"),
  real("swsh10-082", "Hisuian Decidueye", 724, "Stage2", "Dartrix", "Fighting"),
  // Two regional Meowths (TCGdex, 2026-10-02).
  real("swsh12.5-084", "Galarian Meowth", 52, "Basic", null, "Metal"),
  real("2017sm-8", "Alolan Meowth", 52, "Basic", null, "Darkness"),
  real("sm1-79", "Alolan Persian", 53, "Stage1", "Alolan Meowth", "Darkness"),
  // An Alolan Raichu evolves from a plain Pikachu (TCGdex, 2026-10-01).
  real("base1-58", "Pikachu", 25, "Basic", null, "Lightning"),
  real("sm4-31", "Alolan Raichu", 26, "Stage1", "Pikachu", "Lightning"),
];

const BINDER = "9da0166d-f449-4a5d-87d5-e9764229a974";
/** Her Arven's line, and its two slots and the Arven's Toedscruel in it. */
const ARVEN = {
  line: "206bfa6a-06bd-4849-8a7c-9d5ed4fe6d74",
  basic: "74e2f26d-ac0d-46ac-ab4c-0e7b77b519c0",
  stage1: "8594684b-b391-46e7-8b48-73ba07d8e229",
  copy: "2ba07bb5-a2d5-437c-95c6-c14da901dfa7",
  at: "2026-09-30T01:43:24Z",
};
/** Her plain line, 5 minutes older. */
const PLAIN = {
  line: "d5649e38-69cb-4a8d-9225-3965f5d4b5ba",
  basic: "09e60514-db6f-4072-8915-9750c52cb381",
  stage1: "62ba7cb0-3ee7-4b18-970f-50b5db73e8cb",
  copy: "668430d8-9af3-406b-a1dc-715965849cc1",
  at: "2026-09-30T01:38:34Z",
};
/** A second Arven's line, newer than the first. */
const ARVEN2 = {
  line: "306bfa6a-06bd-4849-8a7c-9d5ed4fe6d74",
  basic: "84e2f26d-ac0d-46ac-ab4c-0e7b77b519c0",
  stage1: "9594684b-b391-46e7-8b48-73ba07d8e229",
  copy: "3ba07bb5-a2d5-437c-95c6-c14da901dfa7",
  at: "2026-09-30T02:00:00Z",
};
/** Her one Arven's Toedscool, in the haul. */
const MINE = "02bfae7f-f06d-43a0-8997-9014a3620cb6";

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedCatalogCardsFull(db, CATALOG);
  await seedBinders(db, [{ id: BINDER, type: "general", name: "KB-001" }]);
  clearCatalogCache();
});
afterEach(async () => {
  await db.close();
});

/** A two-stage orange line: what she chases at the Basic (or nothing decided), and the Stage 1 card in it. */
async function seedLine(
  l: typeof ARVEN,
  basicChase: string | null,
  stage1Card: string,
): Promise<void> {
  await asSuperuser(db);
  await db.query(
    `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status, created_at)
       values ($1, $2, 948, 'orange', $3, 'back', 'open', $4)`,
    [l.line, OWNER, BINDER, l.at],
  );
  await db.query(
    `insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band)
       values ($1, $2, $3, 'normal', 'shelved', $4, 'back', 'orange')`,
    [l.copy, OWNER, stage1Card, BINDER],
  );
  await db.query(
    `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, stage_choice, target_catalog_card_id)
       values ($1, $2, $3, 0, 'Basic', 'placeholder', $4, $5)`,
    [l.basic, OWNER, l.line, basicChase ? "chase" : null, basicChase],
  );
  await db.query(
    `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id, target_catalog_card_id)
       values ($1, $2, $3, 1, 'Stage1', 'filled', $4, $5)`,
    [l.stage1, OWNER, l.line, l.copy, stage1Card],
  );
  await db.query(`update copy set line_slot_id = $1 where id = $2`, [l.stage1, l.copy]);
  if (basicChase) {
    await db.query(
      `insert into wishlist_item (owner_id, line_slot_id, required_dex_id, chosen_catalog_card_id, held_for_binder_id)
         values ($1, $2, 948, $3, $4)`,
      [OWNER, l.basic, basicChase, BINDER],
    );
  }
  await asOwner(db);
}

/** Her live shape, exactly. */
async function herShape(): Promise<void> {
  await seedLine(PLAIN, "sv03-118", "sv09-089");
  await seedLine(ARVEN, "sv10-109", "sv10-110");
}

/**
 * Her lines as 0038 leaves them: stamped from their cards, by the migration's own rule (line_form_derived). Seeded
 * here a statement at a time, a line is stamped at its own insert's commit, before its slots exist, so it is stamped
 * again once they do, as the migration stamps every line she has.
 */
async function stamped(): Promise<void> {
  await asSuperuser(db);
  await db.exec(`update evolution_line set form = line_form_derived(id) where true`);
  await asOwner(db);
}
async function screenOf() {
  await stamped();
  return loadLineScreen(pgliteClient(db));
}
async function popupOf(
  ...args: Parameters<typeof loadLinePopupModel> extends [unknown, ...infer R] ? R : never
) {
  await stamped();
  return loadLinePopupModel(pgliteClient(db), ...args);
}

async function planFor(tcgdexId: string, copyId = MINE, opts: { stamp?: boolean } = {}) {
  const card = haulRow(copyId, tcgdexId);
  await seedHaulRows(db, [card]);
  if (opts.stamp === false) await asOwner(db);
  else await stamped();
  const pc = await loadPlanContext(pgliteClient(db), { excludeOwnedCopyIds: [copyId] });
  return { card, item: planFromDraft(pc, [card]).items[0] };
}

describe("UIL-133: her Arven's Toedscool goes to her Arven's line, on her exact shape", () => {
  it("the Haul Plan proposes her Arven's line's Basic, the stage chasing this very printing, not the older plain line", async () => {
    await herShape();
    const { item } = await planFor("sv10-109");
    expect(item.lineProposal).toEqual({ kind: "add", lineId: ARVEN.line, slotId: ARVEN.basic });
    // The row badge names her line in its form: "◆ Adds to Arven's Toedscruel line".
    expect(item.lineName).toBe("Arven's Toedscruel");
  });

  it("its popup lays out her Arven's line and lists the plain line as another line, nothing picked for her", async () => {
    await herShape();
    await planFor("sv10-109");
    const m = await popupOf(MINE, {
      kind: "add",
      lineId: ARVEN.line,
      slotId: ARVEN.basic,
    });
    expect(m.mode).toBe("add");
    expect(m.line.form).toBe("trainer:arven");
    expect(m.stages.map((s) => [s.state, s.card?.name ?? null])).toEqual([
      ["incoming", "Arven's Toedscool"],
      ["here", "Arven's Toedscruel"],
    ]);
    expect(
      m.existingLines.map((l) => [l.lineId, l.joinSlotId, l.sameForm, l.speciesLabel]),
    ).toEqual([[PLAIN.line, PLAIN.basic, false, "TOEDSCOOL LINE"]]);
  });

  it("the plain line's ADD popup (where she was stuck) now offers her Arven's line, first and with room", async () => {
    await herShape();
    await planFor("sv10-109");
    const m = await popupOf(MINE, {
      kind: "add",
      lineId: PLAIN.line,
      slotId: PLAIN.basic,
    });
    expect(
      m.existingLines.map((l) => [l.lineId, l.joinSlotId, l.sameForm, l.speciesLabel]),
    ).toEqual([[ARVEN.line, ARVEN.basic, true, "ARVEN'S TOEDSCOOL LINE"]]);
  });

  it("the join writes her card into her Arven's line (the third pocket, which this completes, is hers to answer)", async () => {
    await herShape();
    const { card } = await planFor("sv10-109");
    await commitCardPlacement(pgliteClient(db), {
      card,
      override: { kind: "shelf", binderId: BINDER, half: "back", band: "orange" },
      lineChoice: {
        mode: "join",
        lineId: ARVEN.line,
        slotId: ARVEN.basic,
        thirdPocket: { material: "empty" },
      },
    });
    await asSuperuser(db);
    const { rows } = await db.query<{ copy_id: string | null; state: string }>(
      `select copy_id, state from line_slot where id = $1`,
      [ARVEN.basic],
    );
    expect(rows[0]).toEqual({ copy_id: MINE, state: "filled" });
  });

  it("moved from a front half, it is offered her Arven's line first, the plain one after (the Move sheet's pick)", async () => {
    await herShape();
    await asSuperuser(db);
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band)
         values ($1, $2, 'sv10-109', 'normal', 'shelved', $3, 'front', 'orange')`,
      [MINE, OWNER, BINDER],
    );
    await asOwner(db);
    const screen = await screenOf();
    const unlined = screen.unlinedCards.find((c) => c.copyId === MINE);
    expect(unlined?.joinCandidates.map((c) => [c.lineId, c.slotId, c.sameForm])).toEqual([
      [ARVEN.line, ARVEN.basic, true],
      [PLAIN.line, PLAIN.basic, false],
    ]);
  });

  it("a plain Toedscool moved from a front half is offered the plain line first", async () => {
    await herShape();
    await asSuperuser(db);
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band)
         values ($1, $2, 'sv01-024', 'normal', 'shelved', $3, 'front', 'green')`,
      [MINE, OWNER, BINDER],
    );
    await asOwner(db);
    const screen = await screenOf();
    const unlined = screen.unlinedCards.find((c) => c.copyId === MINE);
    expect(unlined?.joinCandidates.map((c) => c.lineId)).toEqual([PLAIN.line, ARVEN.line]);
  });

  it("the Lines page tells the two apart", async () => {
    await herShape();
    const screen = await screenOf();
    const label = (id: string) => screen.lines.find((l) => l.lineId === id)?.speciesLabel;
    expect(label(ARVEN.line)).toBe("ARVEN'S TOEDSCOOL LINE");
    expect(label(PLAIN.line)).toBe("TOEDSCOOL LINE");
  });

  it("a regional line whose root is a plain card says its form after the name", async () => {
    const HISUI = "406bfa6a-06bd-4849-8a7c-9d5ed4fe6d74";
    const DECIDUEYE = "4ba07bb5-a2d5-437c-95c6-c14da901dfa7";
    await asSuperuser(db);
    await db.query(
      `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
         values ($1, $2, 722, 'orange', $3, 'back', 'open')`,
      [HISUI, OWNER, BINDER],
    );
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band)
         values ($1, $2, 'swsh10-082', 'normal', 'shelved', $3, 'back', 'orange')`,
      [DECIDUEYE, OWNER, BINDER],
    );
    await db.query(
      `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id) values
         ('a4e2f26d-ac0d-46ac-ab4c-0e7b77b519c0', $1, $2, 0, 'Basic', 'placeholder', null),
         ('b4e2f26d-ac0d-46ac-ab4c-0e7b77b519c0', $1, $2, 1, 'Stage1', 'placeholder', null),
         ('c4e2f26d-ac0d-46ac-ab4c-0e7b77b519c0', $1, $2, 2, 'Stage2', 'filled', $3)`,
      [OWNER, HISUI, DECIDUEYE],
    );
    await db.query(
      `update copy set line_slot_id = 'c4e2f26d-ac0d-46ac-ab4c-0e7b77b519c0' where id = $1`,
      [DECIDUEYE],
    );
    await asOwner(db);
    const screen = await screenOf();
    expect(screen.lines.find((l) => l.lineId === HISUI)?.speciesLabel).toBe(
      "ROWLET LINE · HISUIAN",
    );
  });
});

describe("UIL-133: the order, a chase of the exact printing, then the card's own form, then as before", () => {
  it("a plain Toedscool goes to the plain line, by its form, with no chase naming it", async () => {
    await herShape();
    const { item } = await planFor("sv01-024", "d0000000-0000-4000-8000-0000000000d1");
    expect(item.lineProposal).toEqual({ kind: "add", lineId: PLAIN.line, slotId: PLAIN.basic });
    expect(item.lineName).toBe("Toedscruel");
  });

  it("by form alone: her Arven's Basic undecided, the plain one chasing a plain Toedscool", async () => {
    await seedLine(PLAIN, "sv03-118", "sv09-089");
    await seedLine(ARVEN, null, "sv10-110");
    const { item } = await planFor("sv10-109");
    expect(item.lineProposal).toEqual({ kind: "add", lineId: ARVEN.line, slotId: ARVEN.basic });
  });

  it("her chase of the exact printing comes first: of two Arven's lines, the newer one chasing it wins", async () => {
    await seedLine(ARVEN, null, "sv10-110");
    await seedLine(ARVEN2, "sv10-109", "sv10-110");
    const { item } = await planFor("sv10-109");
    expect(item.lineProposal).toEqual({ kind: "add", lineId: ARVEN2.line, slotId: ARVEN2.basic });
    // And the back half lists it first: the chase, then her other Arven's line, then the plain one.
    await seedLine(PLAIN, "sv03-118", "sv09-089");
    const m = await popupOf(MINE, {
      kind: "start",
      binderId: BINDER,
      band: "orange",
    });
    expect(m.existingLines.map((l) => l.lineId)).toEqual([ARVEN2.line, ARVEN.line, PLAIN.line]);
  });

  it("her chase of a printing of ANOTHER form than the line's still sends it there (a line she mixed herself)", async () => {
    // Her Basic chases a Galarian Meowth under an Alolan Persian: the line reads Alolan, the card Galarian.
    const MIXED = "506bfa6a-06bd-4849-8a7c-9d5ed4fe6d74";
    const BASIC = "d4e2f26d-ac0d-46ac-ab4c-0e7b77b519c0";
    const PERSIAN = "5ba07bb5-a2d5-437c-95c6-c14da901dfa7";
    await asSuperuser(db);
    await db.query(
      `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
         values ($1, $2, 52, 'orange', $3, 'back', 'open')`,
      [MIXED, OWNER, BINDER],
    );
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band)
         values ($1, $2, 'sm1-79', 'normal', 'shelved', $3, 'back', 'orange')`,
      [PERSIAN, OWNER, BINDER],
    );
    await db.query(
      `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id, stage_choice, target_catalog_card_id)
         values ($1, $2, $3, 0, 'Basic', 'placeholder', null, 'chase', 'swsh12.5-084'),
                ('e4e2f26d-ac0d-46ac-ab4c-0e7b77b519c0', $2, $3, 1, 'Stage1', 'filled', $4, null, null)`,
      [BASIC, OWNER, MIXED, PERSIAN],
    );
    await db.query(
      `update copy set line_slot_id = 'e4e2f26d-ac0d-46ac-ab4c-0e7b77b519c0' where id = $1`,
      [PERSIAN],
    );
    await asOwner(db);
    const { item } = await planFor("swsh12.5-084", "d0000000-0000-4000-8000-0000000000d3");
    expect(item.lineProposal).toEqual({ kind: "add", lineId: MIXED, slotId: BASIC });
  });

  it("a chase of the exact printing in a line that also holds a plain card still wins", async () => {
    await seedLine(PLAIN, "sv10-109", "sv09-089");
    await seedLine(ARVEN, null, "sv10-110");
    const { item } = await planFor("sv10-109");
    expect(item.lineProposal).toEqual({ kind: "add", lineId: PLAIN.line, slotId: PLAIN.basic });
  });

  it("with only a plain line, an Arven's Toedscool is not put in it: a Basic with no line of its own goes to a front half", async () => {
    await seedLine(PLAIN, "sv03-118", "sv09-089");
    const { item } = await planFor("sv10-109");
    expect(item.lineProposal).toBeNull();
    expect(item.action).toBe("FRONT");
    // On the back half she is offered a line of its own; the plain line is listed, never "room for this card".
    const m = await popupOf(MINE, {
      kind: "start",
      binderId: BINDER,
      band: "orange",
    });
    expect(m.line.form).toBe("trainer:arven");
    expect(m.existingLines.map((l) => [l.lineId, l.joinSlotId, l.sameForm])).toEqual([
      [PLAIN.line, PLAIN.basic, false],
    ]);
    // Its Stage 1 suggests an Arven's Toedscruel, never the plain one of the same colour.
    const stage1 = m.stages.find((s) => s.stageIndex === 1);
    expect(stage1?.suggestion?.card.tcgdexId).toBe("sv10-110");
  });

  it("an Arven's Toedscruel starts an Arven's line rather than filling a plain line's open Stage 1", async () => {
    await asSuperuser(db);
    await db.query(
      `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
         values ($1, $2, 948, 'orange', $3, 'back', 'open')`,
      [PLAIN.line, OWNER, BINDER],
    );
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band)
         values ($1, $2, 'sv03-118', 'normal', 'shelved', $3, 'back', 'orange')`,
      [PLAIN.copy, OWNER, BINDER],
    );
    await db.query(
      `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
         values ($1, $2, $3, 0, 'Basic', 'filled', $4), ($5, $2, $3, 1, 'Stage1', 'placeholder', null)`,
      [PLAIN.basic, OWNER, PLAIN.line, PLAIN.copy, PLAIN.stage1],
    );
    await db.query(`update copy set line_slot_id = $1 where id = $2`, [PLAIN.basic, PLAIN.copy]);
    await asOwner(db);
    const { item } = await planFor("sv10-110", "d0000000-0000-4000-8000-0000000000d2");
    expect(item.lineProposal).toEqual({ kind: "start", binderId: BINDER, band: "orange" });
    expect(item.lineName).toBe("Arven's Toedscruel");
  });
});

describe("UIL-133 γ: a line keeps the form it was made with (0038, the Tech Lead's review of #454)", () => {
  /** Her plain line, made plain, with an Arven's Toedscruel put at its top since (a join she chose). Not re-stamped. */
  async function plainLineWithAnArvenCard(): Promise<void> {
    await seedLine(PLAIN, null, "sv10-110");
    await asSuperuser(db);
    await db.query(`update evolution_line set form = 'plain' where id = $1`, [PLAIN.line]);
    await asOwner(db);
  }

  it("still reads plain: a plain Toedscool is proposed there, an Arven's Toedscool is not", async () => {
    await plainLineWithAnArvenCard();
    const plain = await planFor("sv01-024", "d0000000-0000-4000-8000-0000000000d4", {
      stamp: false,
    });
    expect(plain.item.lineProposal).toEqual({
      kind: "add",
      lineId: PLAIN.line,
      slotId: PLAIN.basic,
    });
    // Its badge names it in its own form, though an Arven's card sits at its top.
    expect(plain.item.lineName).toBe("Toedscruel");
    const add = await loadLinePopupModel(pgliteClient(db), "d0000000-0000-4000-8000-0000000000d4", {
      kind: "add",
      lineId: PLAIN.line,
      slotId: PLAIN.basic,
    });
    expect(add.line.form).toBeNull();
    const arvens = await planFor("sv10-109", MINE, { stamp: false });
    expect(arvens.item.lineProposal).toBeNull();
  });

  it("its label and its popup stay plain too", async () => {
    await plainLineWithAnArvenCard();
    const screen = await loadLineScreen(pgliteClient(db));
    expect(screen.lines.find((l) => l.lineId === PLAIN.line)?.speciesLabel).toBe("TOEDSCOOL LINE");
    await planFor("sv10-109", MINE, { stamp: false });
    const m = await loadLinePopupModel(pgliteClient(db), MINE, {
      kind: "start",
      binderId: BINDER,
      band: "orange",
    });
    expect(m.existingLines.map((l) => [l.lineId, l.sameForm])).toEqual([[PLAIN.line, false]]);
  });
});

describe("UIL-133 γ: a new line is written with its form", () => {
  const formOf = async (lineId?: string) =>
    (
      await (async () => {
        await asSuperuser(db);
        return db.query<{ form: string }>(
          lineId
            ? `select form from evolution_line where id = $1`
            : `select form from evolution_line`,
          lineId ? [lineId] : [],
        );
      })()
    ).rows.map((r) => r.form);

  it("an Arven's Toedscool started from the Haul Plan popup, its Arven's Toedscruel chased: an Arven's line", async () => {
    const { card } = await planFor("sv10-109");
    await commitCardPlacement(pgliteClient(db), {
      card,
      override: { kind: "shelf", binderId: BINDER, half: "back", band: "orange" },
      lineChoice: {
        mode: "start",
        binderId: BINDER,
        band: "orange",
        pulls: [],
        stages: { 1: { kind: "chase", catalogCardId: "sv10-110" } },
      },
    });
    expect(await formOf()).toEqual(["trainer:arven"]);
  });

  it("a plain Pikachu started with an Alolan Raichu chased above it: an Alolan line", async () => {
    const { card } = await planFor("base1-58", "d0000000-0000-4000-8000-0000000000d5");
    await commitCardPlacement(pgliteClient(db), {
      card,
      override: { kind: "shelf", binderId: BINDER, half: "back", band: "yellow" },
      lineChoice: {
        mode: "start",
        binderId: BINDER,
        band: "yellow",
        pulls: [],
        stages: { 1: { kind: "chase", catalogCardId: "sm4-31" } },
      },
    });
    expect(await formOf()).toEqual(["region:alolan"]);
  });

  it("a plain Toedscool started with its next stage left for later: plain", async () => {
    const { card } = await planFor("sv03-118", "d0000000-0000-4000-8000-0000000000d6");
    await commitCardPlacement(pgliteClient(db), {
      card,
      override: { kind: "shelf", binderId: BINDER, half: "back", band: "orange" },
      lineChoice: {
        mode: "start",
        binderId: BINDER,
        band: "orange",
        pulls: [],
        stages: { 1: { kind: "later" } },
      },
    });
    expect(await formOf()).toEqual(["plain"]);
  });
});

describe("UIL-135: a card that is not the stage's own goes in with her “Put it here anyway”, recorded", () => {
  const PLAIN_TOEDSCOOL = "d0000000-0000-4000-8000-0000000000e1";
  /** The client, with every write's payload kept: what the write DECLARES it overrides (0037). */
  const capturing = () => {
    const client = pgliteClient(db);
    const declared: unknown[] = [];
    const rpc = client.rpc.bind(client) as unknown as (fn: string, args: unknown) => unknown;
    client.rpc = ((fn: string, args: { payload: { overrides?: unknown } }) => {
      declared.push(args.payload.overrides ?? []);
      return rpc(fn, args);
    }) as unknown as typeof client.rpc;
    return { client, declared };
  };
  const decisions = async () => {
    await asSuperuser(db);
    const rows = (
      await db.query<{ decision: string; overrides: string[]; reason: string }>(
        `select decision, overrides, reason from placement_decision where overrides <> '{}'`,
      )
    ).rows;
    await asOwner(db);
    return rows;
  };
  const basicHolds = async (slotId: string) => {
    await asSuperuser(db);
    const r = (
      await db.query<{ copy_id: string | null }>(`select copy_id from line_slot where id = $1`, [
        slotId,
      ])
    ).rows[0];
    await asOwner(db);
    return r?.copy_id ?? null;
  };

  it("a plain Toedscool into her Arven's line: warned in the popup, refused without her say, written with it", async () => {
    await herShape();
    const { card } = await planFor("sv03-118", PLAIN_TOEDSCOOL);
    const m = await popupOf(PLAIN_TOEDSCOOL, {
      kind: "add",
      lineId: ARVEN.line,
      slotId: ARVEN.basic,
    });
    expect(m.warnings).toEqual([
      {
        rule: "line_fit",
        text: "This is your Arven's Toedscool line, and this is a regular Toedscool.",
      },
    ]);
    const join = {
      mode: "join" as const,
      lineId: ARVEN.line,
      slotId: ARVEN.basic,
      thirdPocket: { material: "empty" as const },
    };
    const shelf = {
      kind: "shelf" as const,
      binderId: BINDER,
      half: "back" as const,
      band: "orange",
    };
    await expect(
      commitCardPlacement(pgliteClient(db), { card, override: shelf, lineChoice: join }),
    ).rejects.toThrow(/This is your Arven's Toedscool line, and this is a regular Toedscool/);
    expect(await basicHolds(ARVEN.basic)).toBeNull();
    const { client, declared } = capturing();
    await commitCardPlacement(client, {
      card,
      override: shelf,
      lineChoice: { ...join, overrides: ["line_fit"] },
    });
    expect(declared).toEqual([["line_fit"]]);
    expect(await basicHolds(ARVEN.basic)).toBe(PLAIN_TOEDSCOOL);
    const [d] = await decisions();
    expect(d).toMatchObject({ decision: "line-join", overrides: ["line_fit"] });
    expect(d.reason).toMatch(/Put in this line anyway \(your call\)\./);
  });

  it("a card of another stage: warned, and written with her say; the line keeps its form", async () => {
    await herShape();
    // Her Arven's Toedscruel (a Stage 1) into the Arven's line's Basic.
    const STAGE1 = "d0000000-0000-4000-8000-0000000000e2";
    const { card } = await planFor("sv10-110", STAGE1);
    const m = await popupOf(STAGE1, { kind: "add", lineId: ARVEN.line, slotId: ARVEN.basic });
    expect(m.warnings).toEqual([
      {
        rule: "line_fit",
        text: "This spot is for Arven's Toedscool (Basic). This card is Arven's Toedscruel.",
      },
    ]);
    await commitCardPlacement(pgliteClient(db), {
      card,
      override: { kind: "shelf", binderId: BINDER, half: "back", band: "orange" },
      lineChoice: {
        mode: "join",
        lineId: ARVEN.line,
        slotId: ARVEN.basic,
        thirdPocket: { material: "empty" },
        overrides: ["line_fit"],
      },
    });
    expect(await basicHolds(ARVEN.basic)).toBe(STAGE1);
    await asSuperuser(db);
    expect(
      (await db.query(`select form from evolution_line where id = $1`, [ARVEN.line])).rows,
    ).toEqual([{ form: "trainer:arven" }]);
  });

  it("a card in another language: the key alone never joins it; her Join anyway with the key does, recorded", async () => {
    // A Japanese Toedscool (TCGdex ja:SV9-087) into her plain English line's Basic.
    await asSuperuser(db);
    await db.query(
      `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, locale, set_id, local_id)
         values ('ja:SV9-087', 'ノノクラゲ', '{948}', '{Fighting}', 'Basic', 'ja', 'SV9', '087')`,
    );
    await seedLine(PLAIN, null, "sv09-089");
    const JA = "d0000000-0000-4000-8000-0000000000e3";
    const { card } = await planFor("ja:SV9-087", JA);
    const shelf = {
      kind: "shelf" as const,
      binderId: BINDER,
      half: "back" as const,
      band: "orange",
    };
    const join = {
      mode: "join" as const,
      lineId: PLAIN.line,
      slotId: PLAIN.basic,
      thirdPocket: { material: "empty" as const },
    };
    // PRE-FIX (the Tech Lead's review of #462): line_fit alone passed the language rule unseen.
    await expect(
      commitCardPlacement(pgliteClient(db), {
        card,
        override: shelf,
        lineChoice: { ...join, overrides: ["line_fit"] },
      }),
    ).rejects.toThrow(/That line is in another language \(English\) than this card \(Japanese\)/);
    expect(await basicHolds(PLAIN.basic)).toBeNull();
    const { client, declared } = capturing();
    await commitCardPlacement(client, {
      card,
      override: shelf,
      lineChoice: { ...join, foreignLocale: true, overrides: ["line_fit"] },
    });
    expect(declared).toEqual([["line_fit"]]);
    expect(await basicHolds(PLAIN.basic)).toBe(JA);
    expect(await decisions()).toMatchObject([{ decision: "line-join", overrides: ["line_fit"] }]);
  });

  it("from the Move sheet too: the move's own decision records it", async () => {
    await herShape();
    await asSuperuser(db);
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band)
         values ($1, $2, 'sv03-118', 'normal', 'shelved', $3, 'front', 'orange')`,
      [PLAIN_TOEDSCOOL, OWNER, BINDER],
    );
    await stamped();
    const names = {
      binderName: () => "KB-001",
      collectionName: () => null,
      bandDisplay: () => "Orange",
    };
    const req = {
      copyId: PLAIN_TOEDSCOOL,
      destination: {
        kind: "shelf" as const,
        binderId: BINDER,
        half: "back" as const,
        band: "orange",
      },
      lineChoice: {
        mode: "join" as const,
        lineId: ARVEN.line,
        slotId: ARVEN.basic,
        thirdPocket: { material: "empty" as const },
      },
    };
    await expect(applyMove(pgliteClient(db), req, names)).rejects.toThrow(
      /This is your Arven's Toedscool line/,
    );
    const { client, declared } = capturing();
    await applyMove(
      client,
      { ...req, lineChoice: { ...req.lineChoice, overrides: ["line_fit"] } },
      names,
    );
    expect(declared).toEqual([["line_fit"]]);
    expect(await basicHolds(ARVEN.basic)).toBe(PLAIN_TOEDSCOOL);
    expect(await decisions()).toMatchObject([
      { decision: "placement-move", overrides: ["line_fit"] },
    ]);
  });
});
