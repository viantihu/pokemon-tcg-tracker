import { describe, expect, it } from "vitest";

import { DEFAULT_TYPE_COLOR_MAP } from "@/lib/engine/bands";
import { buildChain, generateSlots, rankAlternates, testViability } from "@/lib/engine/line";
import type { IncomingCard, OwnedCopy } from "@/lib/engine/types";
import {
  CHARIZARD_EX_SV03_125_DARK,
  CHARIZARD_EX_SV035_006,
  CHARIZARD_EX_SV035_183,
  CHARMANDER_SV03_026,
  CHARMELEON_A1_034_DIGITAL,
  CHARMELEON_SV035_005,
  CHARMELEON_SV03_027,
  CHARMELEON_SWSH4_24,
  CHARMELEON_XY12_10,
  EEVEE_SV035_133,
  FLYGON_XY3_76,
  FLYGON_XY5_110,
  SCIZOR_SV03_141,
  SCYTHER_SV035_123,
  TRAPINCH_XY5_82,
  VAPOREON_SV035_134,
  VIBRAVA_XY3_75,
  VIBRAVA_XY5_109,
} from "./fixtures";

const MAP = DEFAULT_TYPE_COLOR_MAP;

const incoming = (card: IncomingCard["card"], id = "inc"): IncomingCard => ({
  id,
  card,
  variant: "normal",
});

// The Fire Charmander catalog: every Fire Charizard printing is specialty (ex); one Darkness ex is
// present to prove the same-colour filter excludes it. One TCG Pocket Charmeleon is digital-only.
const CHARMANDER_CATALOG = [
  CHARMANDER_SV03_026,
  CHARMELEON_SV03_027,
  CHARMELEON_SV035_005,
  CHARMELEON_XY12_10,
  CHARMELEON_SWSH4_24,
  CHARMELEON_A1_034_DIGITAL,
  CHARIZARD_EX_SV035_006,
  CHARIZARD_EX_SV035_183,
  CHARIZARD_EX_SV03_125_DARK,
];

describe("line: chain resolution walks evolveFrom/dexId and excludes digital-only", () => {
  it("resolves Charmander → Charmeleon → Charizard from an incoming Charmeleon", () => {
    const chain = buildChain(incoming(CHARMELEON_SV03_027), CHARMANDER_CATALOG);
    expect(chain.map((n) => n.dexId)).toEqual([4, 5, 6]);
    expect(chain.map((n) => n.stage)).toEqual(["Basic", "Stage1", "Stage2"]);
  });

  it("does not invent a forward stage past the final species (no top-of-chain block)", () => {
    // Flygon is the final stage — nothing evolves from it, so the chain stops at Flygon.
    const chain = buildChain(incoming(FLYGON_XY5_110), [
      TRAPINCH_XY5_82,
      VIBRAVA_XY5_109,
      FLYGON_XY5_110,
    ]);
    expect(chain.map((n) => n.dexId)).toEqual([328, 329, 330]);
  });
});

describe("line: viability is a ≥2 same-colour-member threshold (system-design §6)", () => {
  it("Charmeleon forms a viable Fire line (Charmander + Charmeleon + Charizard = 3 members)", () => {
    const v = testViability(incoming(CHARMELEON_SV03_027), [], CHARMANDER_CATALOG, MAP);
    expect(v.viable).toBe(true);
    expect(v.members).toBe(3);
    expect(v.band).toBe("Red");
  });

  it("Vaporeon is NOT viable: Eevee is Colorless, Vaporeon does not evolve (1 member)", () => {
    const v = testViability(
      incoming(VAPOREON_SV035_134),
      [],
      [EEVEE_SV035_133, VAPOREON_SV035_134],
      MAP,
    );
    expect(v.viable).toBe(false);
    expect(v.members).toBe(1);
    expect(v.band).toBe("Light blue");
    expect(v.blockedStages).toContain(133); // Eevee has no Water printing
  });

  it("2-stage Scizor line dies on a root block (Scyther has no Metal printing)", () => {
    const v = testViability(
      incoming(SCIZOR_SV03_141),
      [],
      [SCYTHER_SV035_123, SCIZOR_SV03_141],
      MAP,
    );
    expect(v.viable).toBe(false);
    expect(v.members).toBe(1);
    expect(v.blockedStages).toContain(123);
  });

  it("3-stage Dragon line survives the SAME root block (Vibrava + Flygon = 2 members)", () => {
    const v = testViability(
      incoming(FLYGON_XY5_110),
      [],
      [TRAPINCH_XY5_82, VIBRAVA_XY5_109, FLYGON_XY5_110, VIBRAVA_XY3_75, FLYGON_XY3_76],
      MAP,
    );
    expect(v.viable).toBe(true);
    expect(v.members).toBe(2);
    expect(v.blockedStages).toContain(328); // Trapinch has no Dragon printing
  });
});

describe("line: slot generation (system-design §6 table)", () => {
  it("Fire Charmander line caps on an ex-only top and pulls the owned root from the front half", () => {
    const ownedCharmander: OwnedCopy = {
      id: "own-charmander",
      card: CHARMANDER_SV03_026,
      variant: "normal",
      role: "shelved",
      binderId: "B1",
      binderHalf: "front",
      colorBand: "Red",
      lineSlotId: null,
    };
    const v = testViability(
      incoming(CHARMELEON_SV03_027, "inc-charmeleon"),
      [ownedCharmander],
      CHARMANDER_CATALOG,
      MAP,
    );
    const gen = generateSlots(
      incoming(CHARMELEON_SV03_027, "inc-charmeleon"),
      v,
      [ownedCharmander],
      CHARMANDER_CATALOG,
      MAP,
    );

    expect(gen.slots).toHaveLength(3); // no phantom Stage-3 block
    expect(gen.status).toBe("capped");

    const [root, mid, top] = gen.slots;
    // Root Charmander: filled from an owned front-half copy → pull action.
    expect(root).toMatchObject({
      stageIndex: 0,
      dexId: 4,
      state: "filled",
      copyId: "own-charmander",
      pullFrom: { binderId: "B1", half: "front" },
    });
    // Mid Charmeleon: filled by the incoming card.
    expect(mid).toMatchObject({
      stageIndex: 1,
      dexId: 5,
      state: "filled",
      copyId: "inc-charmeleon",
    });
    // Top Charizard: placeholder, ex-only → willLiveInSpecialty, cheapest Fire ex chosen.
    expect(top).toMatchObject({ stageIndex: 2, dexId: 6, state: "placeholder" });
    expect(top.targetCatalogCardId).toBe("sv03.5-006");

    const cap = gen.wishlist.find((w) => w.requiredDexId === 6);
    expect(cap?.willLiveInSpecialty).toBe(true);
    expect(cap?.chosenCatalogCardId).toBe("sv03.5-006");
    expect(cap?.alternateCatalogCardIds).toEqual(["sv03.5-183"]); // ascending, Darkness ex excluded
    expect(gen.proposals.some((p) => p.kind === "ex-only-cap")).toBe(true);
  });

  it("3-stage Dragon line: root block, mid placeholder, top filled — line stays open", () => {
    const cat = [TRAPINCH_XY5_82, VIBRAVA_XY5_109, FLYGON_XY5_110, VIBRAVA_XY3_75, FLYGON_XY3_76];
    const v = testViability(incoming(FLYGON_XY5_110, "inc-flygon"), [], cat, MAP);
    const gen = generateSlots(incoming(FLYGON_XY5_110, "inc-flygon"), v, [], cat, MAP);

    expect(gen.slots).toHaveLength(3);
    expect(gen.status).toBe("open");
    expect(gen.slots[0]).toMatchObject({ dexId: 328, state: "block" }); // Trapinch root blocked
    expect(gen.slots[1]).toMatchObject({ dexId: 329, state: "placeholder" }); // Vibrava
    expect(gen.slots[2]).toMatchObject({ dexId: 330, state: "filled", copyId: "inc-flygon" });
    expect(gen.proposals.some((p) => p.kind === "root-block")).toBe(true);

    // Vibrava placeholder alternates: cheapest Dragon Vibrava first, ascending.
    const vib = gen.wishlist.find((w) => w.requiredDexId === 329);
    expect(vib?.chosenCatalogCardId).toBe("xy5-109"); // 0.4 < 0.7
    expect(vib?.alternateCatalogCardIds).toEqual(["xy3-75"]);
    expect(vib?.willLiveInSpecialty).toBe(false);
  });
});

describe("line: alternates ranked by market price ascending, standard class, physical only", () => {
  it("ranks Fire Charmeleon printings cheapest-first and excludes the digital-only card", () => {
    const alt = rankAlternates(5, "Red", CHARMANDER_CATALOG, MAP);
    expect(alt.willLiveInSpecialty).toBe(false);
    // sv03-027 (0.30) < sv03.5-005 (0.45) < swsh4-24 (0.60) < xy12-10 (0.90); A1-034 is digital-only.
    expect(alt.chosenCatalogCardId).toBe("sv03-027");
    expect(alt.alternateCatalogCardIds).toEqual(["sv03.5-005", "swsh4-24", "xy12-10"]);
    expect([alt.chosenCatalogCardId, ...alt.alternateCatalogCardIds]).not.toContain("A1-034");
  });

  it("supports excluding a specific printing (used by the collection-claim path)", () => {
    const alt = rankAlternates(5, "Red", CHARMANDER_CATALOG, MAP, undefined, ["xy12-10"]);
    expect(alt.chosenCatalogCardId).toBe("sv03-027");
    expect(alt.alternateCatalogCardIds).toEqual(["sv03.5-005", "swsh4-24"]);
  });

  it("uses specialty printings only when no standard printing exists (ex-only cap)", () => {
    const alt = rankAlternates(6, "Red", CHARMANDER_CATALOG, MAP);
    expect(alt.willLiveInSpecialty).toBe(true);
    expect(alt.chosenCatalogCardId).toBe("sv03.5-006"); // 8.0 < 25.0
    expect(alt.alternateCatalogCardIds).toEqual(["sv03.5-183"]);
  });
});
