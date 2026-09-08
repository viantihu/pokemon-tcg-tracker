/**
 * End-to-end plan run over a mixed haul (dev-spec §5 M6 acceptance: "a mixed haul produces a plan
 * in exactly the grouped order"). Exercises the real M3 cascade wired through the M6 adapters,
 * assembly, and grouping — no DB, no mocks: a hand-built `PlanContext` from the verified engine
 * fixtures. Bands run in DB-key space (see adapt.ts), matching production.
 */

import { describe, expect, it } from "vitest";
import type { EngineContext } from "@/lib/engine";
import { groupPlan, planFromDraft, type DraftItem, type PlanContext } from "@/lib/plan";
import {
  ARVEN_SV03_186,
  CHARIZARD_BASE1_4,
  CHARIZARD_EX_SV035_006,
  CHARIZARD_EX_SV035_183,
  CHARIZARD_EX_SV03_125_DARK,
  CHARMANDER_SV03_026,
  CHARMELEON_SV03_027,
  EEVEE_SV035_133,
  NEST_BALL_SV01_181,
  SCYTHER_SV035_123,
  VAPOREON_SV035_134,
} from "../engine/fixtures";

const BANDS = [
  "red",
  "orange",
  "yellow",
  "olive",
  "green",
  "dark_blue",
  "light_blue",
  "purple",
  "pink",
  "white",
];

// DB-key type→band map (mirrors 0003_config.sql), the same shape the loader feeds the engine.
const TYPE_COLOR_MAP: Record<string, string> = {
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

const CATALOG = [
  CHARMANDER_SV03_026,
  CHARMELEON_SV03_027,
  CHARIZARD_BASE1_4,
  CHARIZARD_EX_SV035_006,
  CHARIZARD_EX_SV035_183,
  CHARIZARD_EX_SV03_125_DARK,
  EEVEE_SV035_133,
  VAPOREON_SV035_134,
  SCYTHER_SV035_123,
  NEST_BALL_SV01_181,
  ARVEN_SV03_186,
];

function makeContext(): PlanContext {
  const ctx: EngineContext = {
    typeColorMap: TYPE_COLOR_MAP,
    catalog: CATALOG,
    owned: [],
    binders: [
      { id: "b1", name: "Binder 1", type: "general", isActive: true },
      { id: "spec1", name: "Specialty A", type: "specialty", isActive: false },
    ],
    lines: [],
    collections: [],
    now: "2026-09-07T00:00:00.000Z",
  };
  const catalogById = new Map(CATALOG.map((c) => [c.tcgdexId, c]));
  return {
    ctx,
    catalogById,
    copyRowById: new Map(),
    orderedBandKeys: BANDS,
    lookups: {
      binderNameById: new Map([
        ["b1", "Binder 1"],
        ["spec1", "Specialty A"],
      ]),
      bandDisplayByKey: new Map([
        ["red", "Red"],
        ["green", "Green"],
        ["light_blue", "Light blue"],
        ["white", "White"],
      ]),
      collectionNameById: new Map(),
    },
  };
}

const draft: DraftItem[] = [
  { id: CHARMELEON_SV03_027.tcgdexId, tcgdexId: CHARMELEON_SV03_027.tcgdexId, variant: "normal" },
  { id: VAPOREON_SV035_134.tcgdexId, tcgdexId: VAPOREON_SV035_134.tcgdexId, variant: "normal" },
  { id: NEST_BALL_SV01_181.tcgdexId, tcgdexId: NEST_BALL_SV01_181.tcgdexId, variant: "normal" },
  {
    id: CHARIZARD_EX_SV035_006.tcgdexId,
    tcgdexId: CHARIZARD_EX_SV035_006.tcgdexId,
    variant: "holo",
  },
  { id: SCYTHER_SV035_123.tcgdexId, tcgdexId: SCYTHER_SV035_123.tcgdexId, variant: "normal" },
];

describe("planFromDraft + groupPlan (mixed haul)", () => {
  const pc = makeContext();
  const { items } = planFromDraft(pc, draft);
  const groups = groupPlan(items, BANDS);
  const byId = new Map(items.map((it) => [it.incomingId, it]));

  it("routes each card to the band + action the cascade dictates", () => {
    const charmeleon = byId.get(CHARMELEON_SV03_027.tcgdexId)!;
    expect(charmeleon.bandKey).toBe("red");
    expect(charmeleon.action).toBe("NEWLINE"); // viable Fire Charmander line

    const zardEx = byId.get(CHARIZARD_EX_SV035_006.tcgdexId)!;
    expect(zardEx.bandKey).toBe("red");
    expect(zardEx.action).toBe("SPEC"); // specialty class

    const vaporeon = byId.get(VAPOREON_SV035_134.tcgdexId)!;
    expect(vaporeon.bandKey).toBe("light_blue");
    expect(vaporeon.action).toBe("FRONT"); // non-viable (no Water Eevee)

    const nestBall = byId.get(NEST_BALL_SV01_181.tcgdexId)!;
    expect(nestBall.bandKey).toBe("white");
    expect(nestBall.action).toBe("FRONT");

    const scyther = byId.get(SCYTHER_SV035_123.tcgdexId)!;
    expect(scyther.bandKey).toBe("green");
    expect(scyther.isBasic).toBe(true);
    expect(scyther.action).toBe("FRONT");
  });

  it("emits all ten bands in rainbow order with the four occupied ones populated", () => {
    expect(groups.map((g) => g.bandKey)).toEqual(BANDS);
    const occupied = groups.filter((g) => g.count > 0).map((g) => g.bandKey);
    expect(occupied).toEqual(["red", "green", "light_blue", "white"]);
  });

  it("within Red, the Stage-1 new line precedes the specialty card (NEWLINE before SPEC)", () => {
    const red = groups.find((g) => g.bandKey === "red")!;
    const nonbasic = red.subgroups.find((s) => s.kind === "nonbasic")!;
    expect(nonbasic.rows.map((r) => r.action)).toEqual(["NEWLINE", "SPEC"]);
  });

  it("gives the new Fire line a workable destination in the active binder's back half", () => {
    const charmeleon = byId.get(CHARMELEON_SV03_027.tcgdexId)!;
    expect(charmeleon.destination).toBe("Binder 1 · Back · Red");
  });
});
