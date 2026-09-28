/**
 * Her top blocker (the Senior BA, 2026-09-27): since UIL-121 a stage she has not decided has no target, and the Haul
 * Plan's cascade matched a card to a line's slot only by a target or a card in it. So every line she started with an
 * undecided stage had its next card badged as a NEW line ("Starts … line"): confirm it, and she has two. Past a
 * branch (Eevee, Charcadet) it was never offered as an Add on any screen either.
 *
 * Now an open stage that names no species is matched by the ONE rule the line builder holds a join to (`stageFit`):
 * the card's own chain has the line's root and puts it at that depth, and the neighbours agree. A leftover engine
 * target on an undecided stage names nothing (the TL's rule). Pinned through the REAL plan context and cascade, the
 * popup's model, and the real commit, on PGlite, as the owner; so the plan's offer and the builder agree.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { CatalogCard } from "@/lib/engine";
import { loadLinePopupModel } from "@/lib/line/popup-load";
import {
  clearCatalogCache,
  commitCardPlacement,
  loadPlanContext,
  planFromDraft,
  type DraftItem,
} from "@/lib/plan";
import { CHARMANDER_SV03_026, CHARMELEON_SV03_027 } from "../engine/fixtures";
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

const KB1 = "1c000000-0000-0000-0000-0000000000b1";
const LINE = "10000000-0000-0000-0000-0000000000a1";
const slotId = (i: number) => `50000000-0000-0000-0000-0000000000a${i}`;
const ownedId = (i: number) => `c0000000-0000-0000-0000-0000000000a${i}`;

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
const EEVEE = mk("sv08-1330", "Eevee", 133, "Basic", null);
const VAPOREON = mk("sv08-1340", "Vaporeon", 134, "Stage1", "Eevee");
const JOLTEON = mk("sv08-1350", "Jolteon", 135, "Stage1", "Eevee");
const CHARCADET = mk("sv04-9350", "Charcadet", 935, "Basic", null);
const ARMAROUGE = mk("sv04-9360", "Armarouge", 936, "Stage1", "Charcadet");
const CERULEDGE = mk("sv04-9370", "Ceruledge", 937, "Stage1", "Charcadet");
const TWIGLING = mk("sv05-9500", "Twigling", 950, "Basic", null);
const TWIGLEAF = mk("sv05-9510", "Twigleaf", 951, "Stage1", "Twigling");
const TWIGTREE = mk("sv05-9520", "Twigtree", 952, "Stage2", "Twigleaf");
const TWIGTHORN = mk("sv05-9530", "Twigthorn", 953, "Stage1", "Twigling");
const JA_CHARMELEON = {
  ...CHARMELEON_SV03_027,
  tcgdexId: "ja:sv3-027",
  name: "リザード",
  evolveFrom: "ヒトカゲ",
};
const CATALOG: CatalogCard[] = [
  CHARMANDER_SV03_026,
  CHARMELEON_SV03_027,
  EEVEE,
  VAPOREON,
  JOLTEON,
  CHARCADET,
  ARMAROUGE,
  CERULEDGE,
  TWIGLING,
  TWIGLEAF,
  TWIGTREE,
  TWIGTHORN,
];

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedCatalogCardsFull(db, CATALOG);
  await db.query(
    `insert into catalog_card (tcgdex_id, name, dex_id, set_id, local_id, types, stage, evolve_from, card_class, locale)
       values ($1, $2, $3, 'ja:sv3', '027', '{Fire}', 'Stage1', $4, 'standard', 'ja')`,
    [JA_CHARMELEON.tcgdexId, JA_CHARMELEON.name, JA_CHARMELEON.dexId, JA_CHARMELEON.evolveFrom],
  );
  await seedBinders(db, [{ id: KB1, type: "general", name: "KB-001" }]);
  clearCatalogCache();
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

/**
 * Her red line in KB-001's back half: a card fills a stage, `open` leaves it undecided (no target, or an old engine
 * target), `chase` is her chase of a card.
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
        ["Basic", "Stage1", "Stage2"][i],
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
let n = 0;
const haulOf = async (card: CatalogCard): Promise<DraftItem> => {
  n += 1;
  const row = haulRow(
    `d0000000-0000-4000-8000-0000000${String(n).padStart(5, "0")}`,
    card.tcgdexId,
  );
  await seedHaulRows(db, [row]);
  await asOwner(db);
  return row;
};
/** What the Haul Plan proposes for this card, from the real plan context and cascade. */
async function proposalFor(card: DraftItem) {
  const pc = await loadPlanContext(pgliteClient(db), { excludeOwnedCopyIds: [card.id] });
  return planFromDraft(pc, [card]).items[0]?.lineProposal ?? null;
}
const ADDS_TO = (i: number) => ({ kind: "add", lineId: LINE, slotId: slotId(i) });

describe("the Haul Plan: a card for a stage she has not decided ADDS to her line (it proposed a second one)", () => {
  it("a linear family: her Charmeleon for the Charmander line's undecided Stage 1", async () => {
    await seedLine(4, [{ card: CHARMANDER_SV03_026.tcgdexId }, { open: true }]);
    // PRE-FIX: { kind: "start", … }, "Starts … line".
    expect(await proposalFor(await haulOf(CHARMELEON_SV03_027))).toEqual(ADDS_TO(1));
  });

  it("an Eevee line's open Stage 1 takes Vaporeon AND Jolteon", async () => {
    await seedLine(133, [{ card: EEVEE.tcgdexId }, { open: true }]);
    expect(await proposalFor(await haulOf(VAPOREON))).toEqual(ADDS_TO(1));
    expect(await proposalFor(await haulOf(JOLTEON))).toEqual(ADDS_TO(1));
  });

  it("Charcadet's open Stage 1 takes Armarouge and Ceruledge, a leftover engine target naming Armarouge steering nothing", async () => {
    await seedLine(935, [
      { card: CHARCADET.tcgdexId },
      { open: true, leftoverTarget: ARMAROUGE.tcgdexId },
    ]);
    expect(await proposalFor(await haulOf(ARMAROUGE))).toEqual(ADDS_TO(1));
    expect(await proposalFor(await haulOf(CERULEDGE))).toEqual(ADDS_TO(1));
  });

  it("a branch beside a filled neighbour is not matched: Twigthorn is not Twigtree's Stage 1; Twigleaf is", async () => {
    await seedLine(950, [{ card: TWIGLING.tcgdexId }, { open: true }, { card: TWIGTREE.tcgdexId }]);
    expect(await proposalFor(await haulOf(TWIGTHORN))).not.toEqual(ADDS_TO(1));
    expect(await proposalFor(await haulOf(TWIGLEAF))).toEqual(ADDS_TO(1));
  });

  it("a CHASED neighbour of the other branch counts: no Add for Twigthorn beside her chased Twigtree, in the Plan, the popup or the builder (TL)", async () => {
    await seedLine(950, [
      { card: TWIGLING.tcgdexId },
      { open: true },
      { chase: TWIGTREE.tcgdexId },
    ]);
    const card = await haulOf(TWIGTHORN);
    // The Plan's offer…
    expect(await proposalFor(card)).not.toEqual(ADDS_TO(1));
    // …the popup's Add (the join index)…
    const model = await loadLinePopupModel(pgliteClient(db), card.existingCopyId!, {
      kind: "start",
      binderId: KB1,
      band: "red",
    });
    expect(model.existingLines.map((l) => l.joinSlotId)).toEqual([null]);
    // …and the builder agree.
    await expect(
      commitCardPlacement(pgliteClient(db), {
        card,
        override: { kind: "shelf", binderId: KB1, half: "back", band: "red" },
        lineChoice: { mode: "join", lineId: LINE, slotId: slotId(1) },
      }),
    ).rejects.toThrow("That slot is for a different card");
  });

  it("the language is still held (UIL-090): a Japanese Charmeleon is not routed into her English line", async () => {
    await seedLine(4, [{ card: CHARMANDER_SV03_026.tcgdexId }, { open: true }]);
    expect(await proposalFor(await haulOf(JA_CHARMELEON))).not.toEqual(ADDS_TO(1));
  });
});

describe("the plan's offer and the line builder agree on the same line", () => {
  it("the Add the plan proposes for her Vaporeon is one the builder writes", async () => {
    await seedLine(133, [{ card: EEVEE.tcgdexId }, { open: true }]);
    const card = await haulOf(VAPOREON);
    const p = await proposalFor(card);
    if (p?.kind !== "add") throw new Error(`expected an add, got ${p?.kind}`);
    await commitCardPlacement(pgliteClient(db), {
      card,
      lineChoice: {
        mode: "join",
        lineId: p.lineId,
        slotId: p.slotId,
        thirdPocket: { material: "empty" },
      },
    });
    await asSuperuser(db);
    expect(
      (await db.query(`select copy_id from line_slot where id = $1`, [slotId(1)])).rows,
    ).toEqual([{ copy_id: card.id }]);
  });

  it("the popup's START names her line with room for the card: it offers 'Add it there instead' (UIL-096's warning)", async () => {
    await seedLine(4, [{ card: CHARMANDER_SV03_026.tcgdexId }, { open: true }]);
    const card = await haulOf(CHARMELEON_SV03_027);
    const model = await loadLinePopupModel(pgliteClient(db), card.existingCopyId!, {
      kind: "start",
      binderId: KB1,
      band: "red",
    });
    // PRE-FIX: null; the slot named no species, so the popup offered no Add.
    expect(model.existingLines.map((l) => [l.lineId, l.joinSlotId])).toEqual([[LINE, slotId(1)]]);
  });

  it("…and starting a new line anyway is still hers: a second Charmander line is written", async () => {
    await seedLine(4, [{ card: CHARMANDER_SV03_026.tcgdexId }, { open: true }]);
    const card = await haulOf(CHARMELEON_SV03_027);
    await commitCardPlacement(pgliteClient(db), {
      card,
      override: { kind: "shelf", binderId: KB1, half: "back", band: "red" },
      // Its Basic she leaves empty: nothing is decided for her.
      lineChoice: {
        mode: "start",
        binderId: KB1,
        band: "red",
        pulls: [],
        stages: { 0: { kind: "empty" } },
      },
    });
    await asSuperuser(db);
    expect((await db.query(`select id from evolution_line`)).rows).toHaveLength(2);
  });
});

/**
 * QA's survivors on #434, conditions on this PR (the Senior BA): the chase-only rule holds for a stage's NEIGHBOURS
 * too (F6), and the line's own chain is seeded from its HIGHEST known card (F7). Pinned in every caller of the one
 * rule: the Plan's offer (the cascade), the popup's Add (the join index), and the line builder's write.
 */
describe("QA's F6 and F7: a neighbour's leftover engine target names nothing; the fallback is seeded from the top", () => {
  const THORNKING = mk("sv05-9540", "Thornking", 954, "Stage2", "Twigthorn");
  const JA_TWIGLEAF = {
    ...TWIGLEAF,
    tcgdexId: "ja:sv5-9510",
    name: "ツイッグリーフ",
    evolveFrom: "ツイッグ-missing",
  };
  beforeEach(async () => {
    await asSuperuser(db);
    await seedCatalogCardsFull(db, [THORNKING]);
    await db.query(
      `insert into catalog_card (tcgdex_id, name, dex_id, set_id, local_id, types, stage, evolve_from, card_class, locale)
         values ($1, $2, $3, 'ja:sv5', '9510', '{Fire}', 'Stage1', $4, 'standard', 'ja')`,
      [JA_TWIGLEAF.tcgdexId, JA_TWIGLEAF.name, JA_TWIGLEAF.dexId, JA_TWIGLEAF.evolveFrom],
    );
    clearCatalogCache();
    await asOwner(db);
  });
  const joinAt = (card: DraftItem, i: number, extra: Record<string, unknown> = {}) =>
    commitCardPlacement(pgliteClient(db), {
      card,
      override: { kind: "shelf", binderId: KB1, half: "back", band: "red" },
      lineChoice: { mode: "join", lineId: LINE, slotId: slotId(i), ...extra } as never,
    });
  const filledBy = async (i: number) => {
    await asSuperuser(db);
    const r = await db.query<{ copy_id: string }>(`select copy_id from line_slot where id = $1`, [
      slotId(i),
    ]);
    await asOwner(db);
    return r.rows[0]?.copy_id;
  };

  it("F6, the stage BEFORE: a leftover Twigleaf target on the undecided Stage 1 does not refuse her Thornking at Stage 2", async () => {
    await seedLine(950, [
      { card: TWIGLING.tcgdexId },
      { open: true, leftoverTarget: TWIGLEAF.tcgdexId },
      { open: true },
    ]);
    const card = await haulOf(THORNKING);
    // The Plan's offer…
    expect(await proposalFor(card)).toEqual(ADDS_TO(2));
    // …the popup's Add…
    const model = await loadLinePopupModel(pgliteClient(db), card.existingCopyId!, {
      kind: "start",
      binderId: KB1,
      band: "red",
    });
    expect(model.existingLines.map((l) => l.joinSlotId)).toEqual([slotId(2)]);
    // …and the builder's write agree (the other open stage she decides later, as the popup lets her).
    await joinAt(card, 2, { stages: { 1: { kind: "later" } } });
    expect(await filledBy(2)).toBe(card.id);
  });

  it("F6, the stage AFTER: a leftover Twigtree target on the undecided Stage 2 does not refuse her Twigthorn at Stage 1", async () => {
    await seedLine(950, [
      { card: TWIGLING.tcgdexId },
      { open: true },
      { open: true, leftoverTarget: TWIGTREE.tcgdexId },
    ]);
    const card = await haulOf(TWIGTHORN);
    expect(await proposalFor(card)).toEqual(ADDS_TO(1));
    await joinAt(card, 1, { stages: { 2: { kind: "later" } } });
    expect(await filledBy(1)).toBe(card.id);
  });

  it("F7: a Japanese Twigleaf with no Japanese Twigling mirrored joins, seeded from the line's HIGHEST card (Twigtree)", async () => {
    // Seeded from the lowest (Twigling), the chain stops at the branch and the builder could only say "can't confirm".
    await seedLine(950, [{ card: TWIGLING.tcgdexId }, { open: true }, { card: TWIGTREE.tcgdexId }]);
    const card = await haulOf(JA_TWIGLEAF);
    await joinAt(card, 1, { foreignLocale: true });
    expect(await filledBy(1)).toBe(card.id);
  });
});

/**
 * QA's F7 in the Plan's offer and the popup's Add, not only the builder: a card of the line's own language whose
 * catalog entry cannot walk back to a Basic (a mirror gap) is matched through the line's own chain, seeded from its
 * HIGHEST known card. Seeded from the lowest, a branch stops the chain and nothing is offered.
 */
describe("QA's F7 in every caller: a Japanese Twigleaf whose own entry cannot walk back, in her Japanese Twig line", () => {
  const jaCard = (id: string, name: string, dex: number, stage: string, from: string | null) => ({
    ...mk(id, name, dex, stage, from),
    locale: "ja" as const,
  });
  const JA_TWIGLING = jaCard("ja:sv5-9500", "ツイッグ", 950, "Basic", null);
  const JA_TWIGLEAF_A = jaCard("ja:sv5-9510", "ツイッグリーフ", 951, "Stage1", "ツイッグ");
  const JA_TWIGTHORN = jaCard("ja:sv5-9530", "ツイッグソーン", 953, "Stage1", "ツイッグ");
  const JA_TWIGTREE = jaCard("ja:sv5-9520", "ツイッグツリー", 952, "Stage2", "ツイッグリーフ");
  // Another printing of the Stage 1 whose "evolves from" the mirror has wrong: its own chain cannot walk back.
  const JA_TWIGLEAF_B = jaCard("ja:sv6-9510", "ツイッグリーフ", 951, "Stage1", "ツイッグ?");
  beforeEach(async () => {
    await asSuperuser(db);
    for (const c of [JA_TWIGLING, JA_TWIGLEAF_A, JA_TWIGTHORN, JA_TWIGTREE, JA_TWIGLEAF_B]) {
      await db.query(
        `insert into catalog_card (tcgdex_id, name, dex_id, set_id, local_id, types, stage, evolve_from, card_class, locale)
           values ($1, $2, $3, $4, $5, '{Fire}', $6, $7, 'standard', 'ja')`,
        [c.tcgdexId, c.name, c.dexId, c.tcgdexId.split("-")[0], c.localId, c.stage, c.evolveFrom],
      );
    }
    clearCatalogCache();
    await asOwner(db);
  });

  it("the Plan proposes the Add, the popup offers it, and the builder writes it", async () => {
    await seedLine(950, [
      { card: JA_TWIGLING.tcgdexId },
      { open: true },
      { card: JA_TWIGTREE.tcgdexId },
    ]);
    const card = await haulOf(JA_TWIGLEAF_B);
    expect(await proposalFor(card)).toEqual(ADDS_TO(1));
    const model = await loadLinePopupModel(pgliteClient(db), card.existingCopyId!, {
      kind: "start",
      binderId: KB1,
      band: "red",
    });
    expect(model.existingLines.map((l) => l.joinSlotId)).toEqual([slotId(1)]);
    await commitCardPlacement(pgliteClient(db), {
      card,
      lineChoice: { mode: "join", lineId: LINE, slotId: slotId(1) },
    });
    await asSuperuser(db);
    expect(
      (await db.query(`select copy_id from line_slot where id = $1`, [slotId(1)])).rows,
    ).toEqual([{ copy_id: card.id }]);
  });
});
