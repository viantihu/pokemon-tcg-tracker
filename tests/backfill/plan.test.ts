/**
 * M5 backfill — pure logic (dev-spec §5 M5; system-design §7A).
 *
 * No DB, no mocks: the resolver + planners run over the verified engine fixtures, the same way the
 * `tests/plan/plan-run.test.ts` suite exercises the M6 cascade. Covers band auto-computation, the
 * back-half chain resolution (placeholder / cap / block evidence), the terminated-line invariant
 * ("a terminated line never offers a back-half slot"), and the exact rows each step writes.
 *
 * Every card is a copy waiting in her haul (UIL-098): the planners take copy ids from `takeCopy` and emit
 * PLACEMENTS, never new copies. `makeDeps`' taker hands out ids that name the key they came from, so a
 * test can see which (printing, Dex variant) each placement took.
 */

import { describe, expect, it } from "vitest";
import type { CatalogCard, TypeColorMap } from "@/lib/engine";
import {
  bandKeyForTypes,
  deriveLineStatus,
  fillableStages,
  planBackLine,
  planFrontHalf,
  planSpecialty,
  resolveBackLine,
  typeForBand,
  type BackLineStageInput,
  type PlanDeps,
} from "@/lib/backfill";
import {
  ARVEN_SV03_186,
  CHARIZARD_BASE1_4,
  CHARIZARD_EX_SV035_006,
  CHARMANDER_SV03_026,
  CHARMELEON_SV03_027,
  SCIZOR_SV03_141,
  SCYTHER_SV035_123,
} from "../engine/fixtures";

// DB-key type→band map (mirrors 0003_config.sql) — the shape the loader feeds the planners.
const MAP: TypeColorMap = {
  Fire: "red",
  Fighting: "orange",
  Lightning: "yellow",
  Dragon: "olive",
  Grass: "green",
  Darkness: "dark_blue",
  Water: "light_blue",
  Psychic: "purple",
  Fairy: "pink",
  Colorless: "white",
  Metal: "white",
  Trainer: "white",
  Supporter: "white",
  Item: "white",
};

const BAND_DISPLAY = new Map([
  ["red", "Red"],
  ["olive", "Olive"],
  ["green", "Green"],
  ["white", "White"],
]);

const OWNER = "00000000-0000-0000-0000-000000000001";
const B1 = "binder-1";
const SPEC = "binder-spec";

function makeDeps(catalog: CatalogCard[]): PlanDeps {
  let n = 0;
  return {
    ownerId: OWNER,
    catalogById: new Map(catalog.map((c) => [c.tcgdexId, c])),
    typeColorMap: MAP,
    binderNameById: new Map([
      [B1, "Binder 1"],
      [SPEC, "Specialty A"],
    ]),
    bandDisplayByKey: BAND_DISPLAY,
    collectionNameById: new Map([["coll-okubo", "OKUBO cards"]]),
    newId: () => `id-${++n}`,
    takeCopy: (tcgdexId, dexVariantRaw) => `waiting:${tcgdexId}:${dexVariantRaw}:${++n}`,
    now: "2026-09-08T00:00:00.000Z",
  };
}

/* --------------------------------- resolve -------------------------------- */

describe("bandKeyForTypes / typeForBand", () => {
  it("auto-computes the band from the first type; White is the catch-all", () => {
    expect(bandKeyForTypes(["Fire"], MAP)).toBe("red");
    expect(bandKeyForTypes(["Water"], MAP)).toBe("light_blue");
    expect(bandKeyForTypes(["Metal"], MAP)).toBe("white");
    expect(bandKeyForTypes([], MAP)).toBe("white"); // trainers/energy carry no type
    expect(bandKeyForTypes(["Bug"], MAP)).toBe("white"); // unmapped → catch-all
  });

  it("reverse-maps a band to a representative type for wishlist metadata", () => {
    expect(typeForBand("red", MAP)).toBe("Fire");
    expect(typeForBand("olive", MAP)).toBe("Dragon");
  });
});

describe("resolveBackLine", () => {
  const fireCatalog = [
    CHARMANDER_SV03_026,
    CHARMELEON_SV03_027,
    CHARIZARD_BASE1_4,
    CHARIZARD_EX_SV035_006,
  ];

  it("resolves the ordered Fire Charmander chain with placeholder evidence per stage", () => {
    const r = resolveBackLine(CHARMANDER_SV03_026, "red", fireCatalog, MAP);
    expect(r.rootDexId).toBe(4);
    expect(r.bandKey).toBe("red");
    expect(r.requiredType).toBe("Fire");
    expect(r.stages.map((s) => s.stage)).toEqual(["Basic", "Stage1", "Stage2"]);
    // Charizard has a STANDARD Fire printing (Base Set 4) → not specialty-only.
    const zard = r.stages[2];
    expect(zard.sameColorPrintingExists).toBe(true);
    expect(zard.specialtyOnly).toBe(false);
    expect(zard.suggestedTargetId).toBe(CHARIZARD_BASE1_4.tcgdexId);
  });

  it("flags the top stage specialty-only (cap) when only an ex printing exists in-colour", () => {
    const noStandardTop = [CHARMANDER_SV03_026, CHARMELEON_SV03_027, CHARIZARD_EX_SV035_006];
    const r = resolveBackLine(CHARMANDER_SV03_026, "red", noStandardTop, MAP);
    expect(r.stages[2].specialtyOnly).toBe(true);
    expect(r.stages[2].suggestedTargetId).toBe(CHARIZARD_EX_SV035_006.tcgdexId);
  });

  it("marks a stage with no same-colour printing as a block candidate (Grass Scizor)", () => {
    const r = resolveBackLine(
      SCYTHER_SV035_123,
      "green",
      [SCYTHER_SV035_123, SCIZOR_SV03_141],
      MAP,
    );
    // Scizor only exists as Metal → no Grass printing for the Stage 1 slot.
    const scizor = r.stages.find((s) => s.name === "Scizor")!;
    expect(scizor.sameColorPrintingExists).toBe(false);
  });

  it("reports the seed stage index of the picked printing", () => {
    const r = resolveBackLine(CHARMELEON_SV03_027, "red", fireCatalog, MAP);
    expect(r.seedStageIndex).toBe(1); // Charmeleon is Stage 1
  });
});

/* ------------------------------ line invariants --------------------------- */

describe("deriveLineStatus + fillableStages", () => {
  const stage = (
    decision: BackLineStageInput["decision"],
    extra: Partial<BackLineStageInput> = {},
  ) => ({ stageIndex: 0, stage: "Basic", dexId: 1, decision, ...extra }) as BackLineStageInput;

  it("terminated wins over everything", () => {
    expect(deriveLineStatus([stage("filled")], true)).toBe("terminated");
  });

  it("caps when a placeholder can only be a specialty printing", () => {
    expect(
      deriveLineStatus([stage("filled"), stage("placeholder", { specialtyOnly: true })], false),
    ).toBe("capped");
  });

  it("completes when every stage is filled, else stays open", () => {
    expect(deriveLineStatus([stage("filled"), stage("filled")], false)).toBe("complete");
    expect(deriveLineStatus([stage("filled"), stage("placeholder")], false)).toBe("open");
  });

  it("a terminated line offers NO fillable slot (M5 acceptance invariant)", () => {
    const stages = [stage("filled"), stage("block")];
    expect(fillableStages(stages, "terminated")).toEqual([]);
    expect(fillableStages(stages, "open")).toHaveLength(2);
  });
});

/* --------------------------------- planners ------------------------------- */

describe("planFrontHalf", () => {
  const deps = makeDeps([CHARMANDER_SV03_026, ARVEN_SV03_186]);

  it("writes one shelved copy per card, band auto-computed, resolved_by user, no haul", () => {
    const w = planFrontHalf(
      {
        binderId: B1,
        half: "front",
        cards: [
          { tcgdexId: CHARMANDER_SV03_026.tcgdexId, dexVariantRaw: "Normal" },
          { tcgdexId: ARVEN_SV03_186.tcgdexId, dexVariantRaw: "Normal" },
        ],
      },
      deps,
    );
    expect(w.placements).toHaveLength(2);
    expect(w.placements.map((c) => c.color_band)).toEqual(["red", "white"]); // Fire→red, Trainer→white
    expect(w.placements.every((c) => c.role === "shelved" && c.binder_half === "front")).toBe(true);
    // Each placement is a WAITING copy of the key she picked, taken in her order.
    expect(w.placements.map((c) => c.copyId.split(":").slice(0, 3).join(":"))).toEqual([
      `waiting:${CHARMANDER_SV03_026.tcgdexId}:Normal`,
      `waiting:${ARVEN_SV03_186.tcgdexId}:Normal`,
    ]);
    expect(w.decisions).toHaveLength(2);
    expect(w.decisions.every((d) => d.resolved_by === "user" && d.haul_id === null)).toBe(true);
  });
});

describe("planBackLine", () => {
  const catalog = [CHARMANDER_SV03_026, CHARMELEON_SV03_027, CHARIZARD_BASE1_4, SCIZOR_SV03_141];
  const deps = makeDeps(catalog);

  const line = (terminated: boolean, stages: BackLineStageInput[]) =>
    planBackLine(
      { binderId: B1, bandKey: "red", rootDexId: 4, requiredType: "Fire", terminated, stages },
      deps,
    );

  it("writes the line, slots, a filled copy, a placeholder wishlist, and a repurposed-dup block", () => {
    const w = line(false, [
      {
        stageIndex: 0,
        stage: "Basic",
        dexId: 4,
        decision: "filled",
        filledTcgdexId: CHARMANDER_SV03_026.tcgdexId,
        filledDexVariantRaw: "Normal",
      },
      {
        stageIndex: 1,
        stage: "Stage1",
        dexId: 5,
        decision: "placeholder",
        targetCatalogCardId: CHARMELEON_SV03_027.tcgdexId,
        alternateCatalogCardIds: [],
        specialtyOnly: false,
      },
      {
        stageIndex: 2,
        stage: "Stage2",
        dexId: 6,
        decision: "block",
        blockMaterial: "repurposedDuplicate",
        blockCopyTcgdexId: SCIZOR_SV03_141.tcgdexId,
        blockCopyDexVariantRaw: "Holo",
        pocketCount: 2,
      },
    ]);

    expect(w.lines).toHaveLength(1);
    expect(w.lines[0].status).toBe("open");
    expect(w.slots.map((s) => s.state)).toEqual(["filled", "placeholder", "block"]);

    // Filled stage → a waiting copy placed in the back half, wired to its slot.
    const filledCopy = w.placements.find((c) => c.role === "shelved")!;
    expect(filledCopy.binder_half).toBe("back");
    expect(filledCopy.color_band).toBe("red");
    expect(filledCopy.copyId).toMatch(`waiting:${CHARMANDER_SV03_026.tcgdexId}:Normal:`);
    expect(w.copyLineSlotLinks).toHaveLength(1);
    expect(w.copyLineSlotLinks[0].copyId).toBe(filledCopy.copyId);
    expect(w.slots[0].copy_id).toBe(filledCopy.copyId);

    // Placeholder → a wishlist item on its slot.
    expect(w.wishlist).toHaveLength(1);
    expect(w.wishlist[0].chosen_catalog_card_id).toBe(CHARMELEON_SV03_027.tcgdexId);
    expect(w.wishlist[0].required_type).toBe("Fire");

    // Repurposed-duplicate block → the waiting copy of THAT card placed as role=block, and a sized block.
    const blockCopy = w.placements.find((c) => c.role === "block")!;
    expect(blockCopy.copyId).toMatch(`waiting:${SCIZOR_SV03_141.tcgdexId}:Holo:`);
    expect(w.blocks).toHaveLength(1);
    expect(w.blocks[0].pocket_count).toBe(2);
    expect(w.blocks[0].material).toBe("repurposedDuplicate");
    expect(w.blocks[0].copy_id).toBe(blockCopy.copyId);

    // A decision per physical copy (filled + repurposed block), never for the placeholder.
    expect(w.decisions).toHaveLength(2);
    expect(w.decisions.every((d) => d.resolved_by === "user")).toBe(true);
  });

  it("stamps status terminated when the line is terminated", () => {
    const w = line(true, [
      {
        stageIndex: 0,
        stage: "Basic",
        dexId: 4,
        decision: "filled",
        filledTcgdexId: CHARMANDER_SV03_026.tcgdexId,
        filledDexVariantRaw: "Normal",
      },
      {
        stageIndex: 1,
        stage: "Stage1",
        dexId: 5,
        decision: "block",
        blockMaterial: "basicEnergy",
        pocketCount: 1,
      },
    ]);
    expect(w.lines[0].status).toBe("terminated");
    // A basic-energy block still reserves pockets but places no copy.
    expect(w.blocks[0].material).toBe("basicEnergy");
    expect(w.blocks[0].copy_id).toBeNull();
    expect(w.placements.filter((c) => c.role === "block")).toHaveLength(0);
  });
});

describe("planSpecialty", () => {
  const deps = makeDeps([CHARIZARD_EX_SV035_006]);

  it("places single-section copies (no half/band) and tags them into collections", () => {
    const w = planSpecialty(
      {
        binderId: SPEC,
        cards: [
          {
            tcgdexId: CHARIZARD_EX_SV035_006.tcgdexId,
            dexVariantRaw: "Holo",
            collectionIds: ["coll-okubo"],
          },
        ],
      },
      deps,
    );
    expect(w.placements).toHaveLength(1);
    expect(w.placements[0].binder_half).toBeNull();
    expect(w.placements[0].color_band).toBeNull();
    expect(w.placements[0].binder_id).toBe(SPEC);
    expect(w.collectionTags).toEqual([
      { collectionId: "coll-okubo", catalogCardId: CHARIZARD_EX_SV035_006.tcgdexId },
    ]);
    expect(w.decisions).toHaveLength(1);
  });
});
