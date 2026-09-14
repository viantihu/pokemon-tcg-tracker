/**
 * UIL-017 — the cascade's internal decision trace (`CascadeResult.reason`) must never reach the
 * screen verbatim: it names internal fields (`cardClass`) and, in production, carries the colour
 * band as a raw DB key ("dark_blue") rather than a display name ("Dark blue"). `toPlanItem` must
 * derive a reader-facing `PlanItem.reason` instead of passing the trace through untouched.
 *
 * Bands here run in DB-key space (see adapt.ts / plan-run.test.ts) — the same space production
 * loads from `type_color_map` — because the leak only shows up in that space; the engine's own
 * fixtures (tests/engine/fixtures.ts, cascade.test.ts) use display-name bands and would hide it.
 */

import { describe, expect, it } from "vitest";
import { placeCard, type EngineContext } from "@/lib/engine";
import type { Binder, Collection, EvolutionLine, IncomingCard, OwnedCopy } from "@/lib/engine";
import { toPlanItem, type AssembleLookups } from "@/lib/plan/assemble";
import {
  CHARIZARD_EX_SV035_006,
  CHARMANDER_SV03_026,
  CHARMELEON_SV035_005,
  CHARMELEON_SV03_027,
  CHARMELEON_XY12_10,
  EEVEE_SV035_133,
  NEST_BALL_SV01_181,
  SCYTHER_SV035_123,
  VAPOREON_SV035_134,
} from "../engine/fixtures";

// DB-key type→band map (mirrors 0003_config.sql) — the space `reason` leaked its raw key in.
const TYPE_COLOR_MAP: Record<string, string> = {
  Fire: "red",
  Grass: "green",
  Water: "light_blue",
  Colorless: "white",
  Trainer: "white",
};

const LOOKUPS: AssembleLookups = {
  binderNameById: new Map([
    ["B1", "Binder 1"],
    ["SPEC", "Specialty"],
  ]),
  bandDisplayByKey: new Map([
    ["red", "Red"],
    ["green", "Green"],
    ["light_blue", "Light blue"],
    ["white", "White"],
  ]),
  collectionNameById: new Map([["coll-okubo", "Illustrator: OKUBO"]]),
};

const B1: Binder = {
  id: "B1",
  name: "Binder 1",
  type: "general",
  isActive: true,
  freeBackHalf: 20,
};
const SPEC: Binder = { id: "SPEC", name: "Specialty", type: "specialty", isActive: false };

function ctx(over: Partial<EngineContext> = {}): EngineContext {
  return {
    typeColorMap: TYPE_COLOR_MAP,
    catalog: [
      CHARMANDER_SV03_026,
      CHARMELEON_SV03_027,
      CHARMELEON_SV035_005,
      CHARIZARD_EX_SV035_006,
    ],
    owned: [],
    binders: [B1, SPEC],
    lines: [],
    collections: [],
    now: "2026-09-07T00:00:00.000Z",
    ...over,
  };
}

const incoming = (card: IncomingCard["card"], id = "inc"): IncomingCard => ({
  id,
  card,
  variant: "normal",
});

function reasonFor(card: IncomingCard["card"], over: Partial<EngineContext> = {}): string {
  const result = placeCard(incoming(card), ctx(over));
  return toPlanItem(incoming(card), result, result.target.kind === "bulk" ? "" : "band", LOOKUPS)
    .reason;
}

describe("UIL-017 — reason no longer leaks internal names or raw band keys", () => {
  it("card-class: never says 'cardClass' verbatim", () => {
    const reason = reasonFor(CHARIZARD_EX_SV035_006);
    expect(reason).not.toMatch(/cardClass/);
    expect(reason).toMatch(/specialty binder/i);
  });

  it("line-new: shows the display band name, not the DB key", () => {
    const owned: OwnedCopy = {
      id: "own-charmander",
      card: CHARMANDER_SV03_026,
      variant: "normal",
      role: "shelved",
      binderId: "B1",
      binderHalf: "front",
      colorBand: "red",
      lineSlotId: null,
    };
    const reason = reasonFor(CHARMELEON_SV03_027, { owned: [owned] });
    expect(reason).not.toMatch(/\bred\b/); // raw DB key
    expect(reason).toMatch(/\bRed\b/); // display name
  });

  it("line-existing (overflow): shows the display band name, not the DB key", () => {
    const fireLine: EvolutionLine = {
      id: "line-fire",
      rootDexId: 4,
      colorBand: "red",
      binderId: "B1",
      status: "capped",
      slots: [
        {
          id: "s0",
          stageIndex: 0,
          stage: "Basic",
          state: "filled",
          copyId: "c0",
          dexId: 4,
          targetCatalogCardId: null,
        },
        {
          id: "s1",
          stageIndex: 1,
          stage: "Stage1",
          state: "filled",
          copyId: "c1",
          dexId: 5,
          targetCatalogCardId: null,
        },
      ],
    };
    const reason = reasonFor(CHARMELEON_SV035_005, { lines: [fireLine] });
    expect(reason).not.toMatch(/\bred\b/);
    expect(reason).toMatch(/\bRed\b/);
  });

  it("line-nonviable: shows the display band name, not the DB key", () => {
    const reason = reasonFor(VAPOREON_SV035_134, {
      catalog: [EEVEE_SV035_133, VAPOREON_SV035_134],
    });
    expect(reason).not.toMatch(/light_blue/);
    expect(reason).toMatch(/Light blue/);
  });

  it("basic-no-line: shows the display band name, not the DB key", () => {
    const reason = reasonFor(SCYTHER_SV035_123, { catalog: [SCYTHER_SV035_123] });
    expect(reason).not.toMatch(/\bgreen\b/);
    expect(reason).toMatch(/\bGreen\b/);
  });

  it("trainer: shows the display band name, not the DB key", () => {
    const reason = reasonFor(NEST_BALL_SV01_181, { catalog: [NEST_BALL_SV01_181] });
    expect(reason).not.toMatch(/\bwhite\b/);
    expect(reason).toMatch(/\bWhite\b/);
  });

  it("collection-claim: names the collection, no raw band key leak in this step", () => {
    const openFireLine: EvolutionLine = {
      id: "line-fire",
      rootDexId: 4,
      colorBand: "red",
      binderId: "B1",
      status: "open",
      slots: [
        {
          id: "s0",
          stageIndex: 0,
          stage: "Basic",
          state: "filled",
          copyId: "c0",
          dexId: 4,
          targetCatalogCardId: null,
        },
      ],
    };
    const okubo: Collection = {
      id: "coll-okubo",
      name: "Illustrator: OKUBO",
      currentBinderIds: ["SPEC"],
      targetCatalogCardIds: ["xy12-10"],
    };
    const reason = reasonFor(CHARMELEON_XY12_10, { lines: [openFireLine], collections: [okubo] });
    expect(reason).toMatch(/Illustrator: OKUBO/);
    expect(reason).toMatch(/specialty binder/i);
  });

  it("duplicate (holo-swap): plain English, no field-name leak", () => {
    const shelvedNormal: OwnedCopy = {
      id: "shelved-normal",
      card: CHARMANDER_SV03_026,
      variant: "normal",
      role: "shelved",
      binderId: "B1",
      binderHalf: "back",
      colorBand: "red",
      lineSlotId: "slot-root",
    };
    const result = placeCard(
      { id: "inc", card: CHARMANDER_SV03_026, variant: "holo" },
      ctx({ owned: [shelvedNormal] }),
    );
    const reason = toPlanItem(
      { id: "inc", card: CHARMANDER_SV03_026, variant: "holo" },
      result,
      "red",
      LOOKUPS,
    ).reason;
    expect(reason).toMatch(/bulk box/i);
    expect(reason).toMatch(/line slot/i);
  });
});
