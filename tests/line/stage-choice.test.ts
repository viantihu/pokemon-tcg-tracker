/**
 * UIL-121 A2 — her choice for each unfilled stage, and for a short complete line's third pocket, checked on the server
 * (`validateStageDecision`, `validateThirdPocket`). Karvi, 2026-09-27: nothing is written for her; every empty stage
 * is chased, left empty, or given a filler, by her. The refusals are in her words, and nothing is written with one.
 */
import { describe, expect, it } from "vitest";
import {
  STAGE_REFUSAL,
  StageChoiceRefusal,
  hasThirdPocket,
  stageWriteOps,
  thirdPocketWriteOps,
  validateStageDecision,
  validateThirdPocket,
  type StageCatalogCard,
  type StageState,
  type StageTarget,
} from "@/lib/line/stage-choice";
import { lineStatusOf, type StageDecision } from "@/lib/line/popup";

const card = (over: Partial<StageCatalogCard> & { tcgdexId: string }): StageCatalogCard => ({
  name: "Charmeleon",
  dexId: [5],
  cardClass: "standard",
  setName: "151",
  localId: "005",
  locale: "en",
  ...over,
});

const CATALOG = [
  card({ tcgdexId: "sv03.5-005" }),
  card({ tcgdexId: "sv03.5-199", cardClass: "specialty", localId: "199" }),
  card({ tcgdexId: "ja:sv2a-005", locale: "ja" }),
  card({ tcgdexId: "sv03.5-004", name: "Charmander", dexId: [4], localId: "004" }),
  card({ tcgdexId: "user:en:mine", name: "Charmeleon", setName: "Promo", localId: "P1" }),
];
const COPIES = [
  { id: "c-bulk", role: "bulk" },
  { id: "c-haul", role: "haul" },
  { id: "c-shelved", role: "shelved" },
];

function state(over: Partial<StageState> = {}): StageState {
  let n = 0;
  return {
    card: (id) => CATALOG.find((c) => c.tcgdexId === id) ?? null,
    copy: (id) => COPIES.find((c) => c.id === id) ?? null,
    standIns: CATALOG.filter((c) => c.tcgdexId.startsWith("user:")),
    mirrorCandidates: (d) =>
      CATALOG.filter((c) => !c.tcgdexId.startsWith("user:") && c.name === d.name),
    newId: () => `id-${++n}`,
    newStandInId: (language) => `user:${language}:new`,
    ...over,
  };
}

const TARGET: StageTarget = {
  lineId: "L",
  slotId: "S1",
  stageIndex: 1,
  stage: "Stage1",
  dexId: 5,
  speciesName: "Charmeleon",
  lineLocale: "en",
  binderId: "B",
  requiredType: "Fire",
};

const decide = (d: StageDecision | undefined, fillerFrom?: ("bulk" | "haul")[]) =>
  validateStageDecision(state(), TARGET, d, fillerFrom ? { fillerFrom } : {});
const refusedWith = (fn: () => unknown, message: string) => {
  expect(fn).toThrow(StageChoiceRefusal);
  expect(fn).toThrow(message);
};

describe("a CHASE: her wishlist add, for the stage's species in the line's language", () => {
  it("a catalog card: the slot names it, and one wish for it, held for the line's binder", () => {
    const w = decide({ kind: "chase", catalogCardId: "sv03.5-005" });
    expect(w.slotPatch).toEqual({
      state: "placeholder",
      target_catalog_card_id: "sv03.5-005",
      note: null,
      stage_choice: "chase",
    });
    expect(w.wish).toEqual({
      op: "upsert_wishlist_for_slot",
      line_slot_id: "S1",
      required_dex_id: 5,
      required_type: "Fire",
      required_stage: "Stage1",
      chosen_catalog_card_id: "sv03.5-005",
      alternate_catalog_card_ids: [],
      will_live_in_specialty: false,
      held_for_binder_id: "B",
    });
    expect(w.standIn).toBeUndefined();
    expect(w.resolveWish).toBeUndefined();
  });

  it("the special printing lives in the specialty binder", () => {
    expect(
      decide({ kind: "chase", catalogCardId: "sv03.5-199" }).wish?.will_live_in_specialty,
    ).toBe(true);
  });

  it("refused: another species, another language, or a card no longer in the catalog", () => {
    refusedWith(
      () => decide({ kind: "chase", catalogCardId: "sv03.5-004" }),
      "That card isn't a Charmeleon; pick one for this stage.",
    );
    refusedWith(
      () => decide({ kind: "chase", catalogCardId: "ja:sv2a-005" }),
      STAGE_REFUSAL.otherLanguage,
    );
    refusedWith(() => decide({ kind: "chase", catalogCardId: "gone" }), STAGE_REFUSAL.unknownCard);
  });

  it("a Japanese line takes the Japanese printing", () => {
    const w = validateStageDecision(
      state(),
      { ...TARGET, lineLocale: "ja" },
      {
        kind: "chase",
        catalogCardId: "ja:sv2a-005",
      },
    );
    expect(w.wish?.chosen_catalog_card_id).toBe("ja:sv2a-005");
  });
});

describe("a CHASE of a placeholder card she makes: catalog-only, no copy", () => {
  const draft = {
    name: " Charmeleon ",
    setName: "Promo 2",
    localId: "P2",
    language: "en" as const,
  };

  it("the stand-in carries the stage's dex id, stage and type (never hers to send); the slot and wish name it", () => {
    const w = decide({ kind: "chase", newStandIn: draft });
    expect(w.standIn).toEqual({
      op: "insert_catalog_stand_in",
      tcgdex_id: "user:en:new",
      name: "Charmeleon",
      set_id: null,
      set_name: "Promo 2",
      local_id: "P2",
      dex_id: [5],
      types: ["Fire"],
      stage: "Stage1",
      card_class: "standard",
    });
    expect(w.slotPatch.target_catalog_card_id).toBe("user:en:new");
    expect(w.wish?.chosen_catalog_card_id).toBe("user:en:new");
    // Nothing here makes a copy: a placeholder card is a catalog row only.
    expect(stageWriteOps("S1", w).map((o) => o.op)).not.toContain("insert_copy");
  });

  it("refused: no name, another language, a twin of one she made, or a card TCGdex already has", () => {
    refusedWith(
      () => decide({ kind: "chase", newStandIn: { ...draft, name: "  " } }),
      STAGE_REFUSAL.standInName,
    );
    refusedWith(
      () => decide({ kind: "chase", newStandIn: { ...draft, language: "ja" } }),
      STAGE_REFUSAL.otherLanguage,
    );
    refusedWith(
      () =>
        decide({
          kind: "chase",
          newStandIn: { ...draft, setName: "promo", localId: "p1" }, // hers, in other case
        }),
      STAGE_REFUSAL.standInTwin,
    );
    refusedWith(
      () => decide({ kind: "chase", newStandIn: { ...draft, setName: "151", localId: "5" } }), // 5 = 005
      STAGE_REFUSAL.mirrorDuplicate,
    );
  });

  it("a twin in ANOTHER language is not hers (UIL-108): a French one is not an English twin", () => {
    const st = state({
      standIns: [card({ tcgdexId: "user:fr:x", setName: "Promo 2", localId: "P2" })],
    });
    expect(() =>
      validateStageDecision(st, TARGET, { kind: "chase", newStandIn: draft }),
    ).not.toThrow();
  });
});

describe("EMPTY: nothing on her wishlist", () => {
  it("the slot is an open slot she left empty, and any open wish on it is closed", () => {
    const w = decide({ kind: "empty" });
    expect(w.slotPatch).toEqual({
      state: "placeholder",
      target_catalog_card_id: null,
      note: null,
      stage_choice: "empty",
    });
    expect(w.wish).toBeUndefined();
    expect(stageWriteOps("S1", w)).toEqual([
      { op: "resolve_wishlist_for_slot", line_slot_id: "S1" },
      { op: "update_slot", id: "S1", patch: w.slotPatch },
    ]);
  });
});

describe("a FILLER: what physically fills the stage's pocket", () => {
  it("a basic energy: an untracked block on that slot", () => {
    const w = decide({ kind: "filler", filler: { material: "energy" } });
    expect(w.slotPatch.state).toBe("block");
    expect(w.slotPatch.stage_choice).toBe("filler");
    expect(w.block).toEqual({
      op: "insert_binder_block",
      id: "id-1",
      binder_id: "B",
      half: "back",
      pocket_count: 1,
      purpose: "line-filler",
      material: "basicEnergy",
      copy_id: null,
      line_id: "L",
      line_slot_id: "S1",
    });
    expect(w.copyPatch).toBeUndefined();
    expect(w.resolveWish).toBe(true);
  });

  it("a card from her bulk box: it becomes a block in the line's binder, back half, on no slot, and it is recorded", () => {
    const w = decide({ kind: "filler", filler: { material: "card", copyId: "c-bulk" } });
    expect(w.copyPatch).toEqual({
      op: "update_copy",
      id: "c-bulk",
      patch: {
        role: "block",
        binder_id: "B",
        binder_half: "back",
        color_band: null,
        line_slot_id: null,
      },
    });
    expect(w.block).toMatchObject({
      copy_id: "c-bulk",
      material: "repurposedDuplicate",
      line_slot_id: "S1",
    });
    expect(w.decision).toMatchObject({
      copy_id: "c-bulk",
      decision: "line-filler",
      resolved_by: "user",
    });
    expect(stageWriteOps("S1", w).map((o) => o.op)).toEqual([
      "resolve_wishlist_for_slot",
      "update_slot",
      "update_copy",
      "insert_binder_block",
      "insert_decision",
    ]);
  });

  it("the popup takes a card from her bulk box only; Backfill takes one from her haul", () => {
    refusedWith(
      () => decide({ kind: "filler", filler: { material: "card", copyId: "c-haul" } }),
      STAGE_REFUSAL.fillerNotInBulk,
    );
    refusedWith(
      () => decide({ kind: "filler", filler: { material: "card", copyId: "c-shelved" } }),
      STAGE_REFUSAL.fillerNotInBulk,
    );
    refusedWith(
      () => decide({ kind: "filler", filler: { material: "card", copyId: "gone" } }),
      STAGE_REFUSAL.fillerNotInBulk,
    );
    expect(
      decide({ kind: "filler", filler: { material: "card", copyId: "c-haul", from: "haul" } }, [
        "haul",
      ]).copyPatch?.id,
    ).toBe("c-haul");
    refusedWith(
      // A haul pick whose card is no longer waiting there.
      () =>
        decide({ kind: "filler", filler: { material: "card", copyId: "c-bulk", from: "haul" } }, [
          "haul",
        ]),
      STAGE_REFUSAL.fillerNotInHaul,
    );
    // Backfill offers both (the Senior BA's ruling): each pick is held to where she picked it from, and a stale pick
    // is refused in that place's words.
    const both = ["bulk", "haul"] as ("bulk" | "haul")[];
    expect(
      decide({ kind: "filler", filler: { material: "card", copyId: "c-bulk" } }, both).copyPatch
        ?.id,
    ).toBe("c-bulk");
    expect(
      decide({ kind: "filler", filler: { material: "card", copyId: "c-haul", from: "haul" } }, both)
        .copyPatch?.id,
    ).toBe("c-haul");
    refusedWith(
      () =>
        decide(
          { kind: "filler", filler: { material: "card", copyId: "c-bulk", from: "haul" } },
          both,
        ),
      STAGE_REFUSAL.fillerNotInHaul,
    );
    refusedWith(
      () => decide({ kind: "filler", filler: { material: "card", copyId: "c-haul" } }, both),
      STAGE_REFUSAL.fillerNotInBulk,
    );
    // A screen that offers only the bulk box refuses a haul pick.
    refusedWith(
      () =>
        decide({ kind: "filler", filler: { material: "card", copyId: "c-haul", from: "haul" } }),
      STAGE_REFUSAL.fillerNotInHaul,
    );
  });
});

describe("no choice: nothing is decided for her", () => {
  it("a stage with no decision is refused, naming the stage", () => {
    refusedWith(() => decide(undefined), "Choose what goes in the Stage 1 slot.");
  });
});

describe("the THIRD POCKET: a complete line shorter than 3 (Q4)", () => {
  const LINE = { lineId: "L", binderId: "B", slotCount: 2, completeAfterWrite: true };

  it("has one only when the write completes a line of fewer than 3", () => {
    expect(hasThirdPocket(LINE)).toBe(true);
    expect(hasThirdPocket({ ...LINE, completeAfterWrite: false })).toBe(false);
    expect(hasThirdPocket({ ...LINE, slotCount: 3 })).toBe(false);
  });

  it("required then; each choice is recorded on the line, with its block", () => {
    refusedWith(
      () => validateThirdPocket(state(), LINE, undefined),
      STAGE_REFUSAL.thirdPocketMissing,
    );
    expect(validateThirdPocket(state(), LINE, { material: "empty" })).toEqual({
      extraPocket: "empty",
    });
    const energy = validateThirdPocket(state(), LINE, { material: "energy" });
    expect(energy?.extraPocket).toBe("energy");
    expect(energy?.block).toMatchObject({
      material: "basicEnergy",
      line_slot_id: null,
      copy_id: null,
    });
    const cardW = validateThirdPocket(state(), LINE, { material: "card", copyId: "c-bulk" });
    expect(cardW?.extraPocket).toBe("card");
    expect(thirdPocketWriteOps("L", cardW!).map((o) => o.op)).toEqual([
      "update_line",
      "update_copy",
      "insert_binder_block",
      "insert_decision",
    ]);
    expect(thirdPocketWriteOps("L", cardW!)[0]).toEqual({
      op: "update_line",
      id: "L",
      patch: { extra_pocket: "card" },
    });
  });

  it("a line with no third pocket: nothing asked, and a choice sent for one is refused", () => {
    expect(validateThirdPocket(state(), { ...LINE, slotCount: 3 }, undefined)).toBeNull();
    refusedWith(
      () =>
        validateThirdPocket(state(), { ...LINE, completeAfterWrite: false }, { material: "empty" }),
      STAGE_REFUSAL.noThirdPocket,
    );
  });
});

describe("lineStatusOf: CLOSED when no stage waits (the Senior BA's Q1 ruling)", () => {
  it.each([
    [[{ state: "filled" }, { state: "filled" }], "closed"],
    [[{ state: "filled" }, { state: "placeholder", stageChoice: "empty" }], "closed"],
    [[{ state: "filled" }, { state: "block", stageChoice: "filler" }], "closed"],
    [
      [
        { state: "placeholder", stageChoice: "empty" },
        { state: "placeholder", stageChoice: "empty" },
      ],
      "closed",
    ],
    [[{ state: "filled" }, { state: "placeholder", stageChoice: "chase" }], "open"],
    [[{ state: "filled" }, { state: "placeholder", stageChoice: null }], "open"], // not decided yet
    [[{ state: "filled" }, { state: "block", stageChoice: null }], "open"], // a pre-0030 engine block
    [[], "open"],
  ])("%j → %s", (stages, status) => {
    expect(lineStatusOf(stages)).toBe(status);
  });
});
