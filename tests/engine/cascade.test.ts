import { describe, expect, it } from "vitest";

import { placeCard, type EngineContext } from "@/lib/engine/cascade";
import type {
  Binder,
  Collection,
  EvolutionLine,
  IncomingCard,
  OwnedCopy,
  Variant,
} from "@/lib/engine/types";
import {
  CHARIZARD_EX_SV035_006,
  CHARIZARD_EX_SV035_183,
  CHARIZARD_EX_SV03_125_DARK,
  CHARMANDER_SV03_026,
  CHARMELEON_A1_034_DIGITAL,
  CHARMELEON_SV035_005,
  CHARMELEON_SV03_027,
  CHARMELEON_SWSH4_24,
  CHARMELEON_XY12_10,
  EEVEE_SV035_133,
  FLYGON_XY3_76,
  FLYGON_XY5_110,
  NEST_BALL_SV01_181,
  SCIZOR_SV03_141,
  SCYTHER_SV035_123,
  TRAPINCH_XY5_82,
  VAPOREON_SV035_134,
  VIBRAVA_XY3_75,
  VIBRAVA_XY5_109,
  KEY_FORM_TYPE_COLOR_MAP,
} from "./fixtures";

// Key-form, as production feeds it (UIL-013) — see fixtures.ts.
const MAP = KEY_FORM_TYPE_COLOR_MAP;

const B1: Binder = {
  id: "B1",
  name: "Binder 1",
  type: "general",
  isActive: true,
  freeBackHalf: 20,
};
const SPEC: Binder = { id: "SPEC", name: "Specialty", type: "specialty", isActive: false };

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

function ctx(over: Partial<EngineContext> = {}): EngineContext {
  return {
    typeColorMap: MAP,
    catalog: CHARMANDER_CATALOG,
    owned: [],
    binders: [B1, SPEC],
    lines: [],
    collections: [],
    now: "2026-09-07T00:00:00.000Z",
    ...over,
  };
}

const incoming = (
  card: IncomingCard["card"],
  variant: Variant = "normal",
  id = "inc",
): IncomingCard => ({ id, card, variant });

const ownedCharmanderFront: OwnedCopy = {
  id: "own-charmander",
  card: CHARMANDER_SV03_026,
  variant: "normal",
  role: "shelved",
  binderId: "B1",
  binderHalf: "front",
  colorBand: "red",
  lineSlotId: null,
};

// ------------------------------------------------------------------------------------------------
// system-design §5 — the four worked examples, tested EXACTLY.
// ------------------------------------------------------------------------------------------------

describe("cascade worked example 1: Charmeleon OBF-027 → capped Fire line", () => {
  const res = placeCard(
    incoming(CHARMELEON_SV03_027, "normal", "inc-charmeleon"),
    ctx({ owned: [ownedCharmanderFront] }),
  );

  it("creates a new Fire line in the back half of the active binder", () => {
    expect(res.step).toBe("line-new");
    expect(res.target).toMatchObject({
      kind: "back-half-line",
      band: "red",
      binderId: "B1",
      lineId: "new",
    });
  });

  it("caps the line on the ex-only Charizard and wishlists it to the specialty binder", () => {
    expect(res.newLine?.status).toBe("capped");
    expect(res.newLine?.slots).toHaveLength(3);
    const cap = res.wishlist?.find((w) => w.requiredDexId === 6);
    expect(cap?.willLiveInSpecialty).toBe(true);
    expect(cap?.chosenCatalogCardId).toBe("sv03.5-006");
    expect(cap?.alternateCatalogCardIds).toEqual(["sv03.5-183"]);
    expect(res.proposals?.some((p) => p.kind === "ex-only-cap")).toBe(true);
  });

  it("emits a pull action for the owned Charmander sitting in the front half", () => {
    expect(res.pullActions).toEqual([{ copyId: "own-charmander", binderId: "B1", half: "front" }]);
  });
});

describe("cascade worked example 2: a second, different-art Charmeleon → front half", () => {
  const fireLine: EvolutionLine = {
    id: "line-fire-charmander",
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
        copyId: "own-charmander",
        dexId: 4,
        targetCatalogCardId: "sv03-026",
      },
      {
        id: "s1",
        stageIndex: 1,
        stage: "Stage1",
        state: "filled",
        copyId: "c-charmeleon",
        dexId: 5,
        targetCatalogCardId: "sv03-027",
      },
      {
        id: "s2",
        stageIndex: 2,
        stage: "Stage2",
        state: "placeholder",
        copyId: null,
        dexId: 6,
        targetCatalogCardId: "sv03.5-006",
      },
    ],
  };

  it("routes the extra copy to the front half because the Stage-1 slot is already filled", () => {
    const res = placeCard(incoming(CHARMELEON_SV035_005), ctx({ lines: [fireLine] }));
    expect(res.step).toBe("line-existing");
    expect(res.target).toMatchObject({ kind: "front-half", band: "red" });
    expect(res.newLine ?? null).toBeNull();
  });
});

describe("cascade worked example 3: Vaporeon non-viable → Light blue front half", () => {
  const res = placeCard(
    incoming(VAPOREON_SV035_134),
    ctx({ catalog: [EEVEE_SV035_133, VAPOREON_SV035_134] }),
  );

  it("goes to the front half in the Light blue (Water) band, with no line created", () => {
    expect(res.step).toBe("line-nonviable");
    expect(res.target).toMatchObject({ kind: "front-half", band: "light_blue" });
    expect(res.newLine ?? null).toBeNull();
  });
});

describe("cascade worked example 4: collection-claimed Charmeleon → specialty, line slot stays open", () => {
  // TCGdex has NO OKUBO-illustrated Charmeleon (OKUBO illustrated 31 cards, none in the Charmander
  // line — verified 2026-09-07). A real Fire Charmeleon (xy12-10) stands in as the collection member;
  // the cascade behaviour under test — collection claim beats line participation — is identical.
  const okuboCollection: Collection = {
    id: "coll-okubo",
    name: "Illustrator: OKUBO (real Charmeleon stand-in)",
    currentBinderIds: ["SPEC"],
    targetCatalogCardIds: ["xy12-10"],
  };
  const openFireLine: EvolutionLine = {
    id: "line-fire-charmander",
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
        copyId: "own-charmander",
        dexId: 4,
        targetCatalogCardId: "sv03-026",
      },
      {
        id: "s1",
        stageIndex: 1,
        stage: "Stage1",
        state: "placeholder",
        copyId: null,
        dexId: 5,
        targetCatalogCardId: null,
      },
      {
        id: "s2",
        stageIndex: 2,
        stage: "Stage2",
        state: "placeholder",
        copyId: null,
        dexId: 6,
        targetCatalogCardId: "sv03.5-006",
      },
    ],
  };
  const res = placeCard(
    incoming(CHARMELEON_XY12_10),
    ctx({ lines: [openFireLine], collections: [okuboCollection] }),
  );

  it("collection claim fires first → specialty binder holding that collection", () => {
    expect(res.step).toBe("collection-claim");
    expect(res.target).toMatchObject({
      kind: "specialty",
      binderId: "SPEC",
      collectionId: "coll-okubo",
    });
  });

  it("the line's Stage-1 slot stays a placeholder and lists other Fire Charmeleons cheapest-first", () => {
    expect(res.proposals?.some((p) => p.kind === "collection-vs-line")).toBe(true);
    const w = res.wishlist?.find((x) => x.requiredDexId === 5);
    expect(w?.chosenCatalogCardId).toBe("sv03-027"); // cheapest OTHER Fire Charmeleon
    expect(w?.alternateCatalogCardIds).toEqual(["sv03.5-005", "swsh4-24"]); // excludes xy12-10 + digital
  });
});

// ------------------------------------------------------------------------------------------------
// Structural invariants (dev-spec §5 M3 acceptance).
// ------------------------------------------------------------------------------------------------

describe("cascade invariants", () => {
  it("a 2-stage chain dies on a root block (Scizor) → front half, no line, no back-half page", () => {
    const res = placeCard(
      incoming(SCIZOR_SV03_141),
      ctx({ catalog: [SCYTHER_SV035_123, SCIZOR_SV03_141] }),
    );
    expect(res.step).toBe("line-nonviable");
    expect(res.target).toMatchObject({ kind: "front-half", band: "white" }); // Metal → White
    expect(res.newLine ?? null).toBeNull(); // terminated line has no page → nothing in the back half
  });

  it("a 3-stage chain survives the SAME root block (Trapinch/Vibrava/Flygon Dragon)", () => {
    const cat = [TRAPINCH_XY5_82, VIBRAVA_XY5_109, FLYGON_XY5_110, VIBRAVA_XY3_75, FLYGON_XY3_76];
    const res = placeCard(incoming(FLYGON_XY5_110, "normal", "inc-flygon"), ctx({ catalog: cat }));
    expect(res.step).toBe("line-new");
    expect(res.newLine?.colorBand).toBe("olive");
    expect(res.newLine?.slots).toHaveLength(3); // no invented Stage-3 (Flygon is the top)
    expect(res.newLine?.slots.map((s) => s.state)).toEqual(["block", "placeholder", "filled"]);
    expect(res.proposals?.some((p) => p.kind === "root-block")).toBe(true);
  });

  it("card class beats the line engine: a Fire Charizard ex → specialty binder", () => {
    const res = placeCard(incoming(CHARIZARD_EX_SV035_006), ctx());
    expect(res.step).toBe("card-class");
    expect(res.target).toMatchObject({ kind: "specialty", binderId: "SPEC" });
  });

  it("a duplicate holo of a shelved normal swaps in and displaces the normal to bulk", () => {
    const owned: OwnedCopy = {
      id: "shelved-normal",
      card: CHARMANDER_SV03_026,
      variant: "normal",
      role: "shelved",
      binderId: "B1",
      binderHalf: "back",
      colorBand: "red",
      lineSlotId: "slot-root",
    };
    const res = placeCard(incoming(CHARMANDER_SV03_026, "holo"), ctx({ owned: [owned] }));
    expect(res.step).toBe("duplicate");
    expect(res.displacedToBulkCopyId).toBe("shelved-normal");
    expect(res.swap?.incomingInherits.lineSlotId).toBe("slot-root");
    expect(res.proposals?.some((p) => p.kind === "holo-swap")).toBe(true);
  });

  it("a Trainer routes to the front-half White band (step 6)", () => {
    const res = placeCard(incoming(NEST_BALL_SV01_181), ctx({ catalog: [NEST_BALL_SV01_181] }));
    expect(res.step).toBe("trainer");
    expect(res.target).toMatchObject({ kind: "front-half", band: "white" });
  });

  it("every card gets a destination — the cascade is total", () => {
    const cards = [
      incoming(CHARMELEON_SV03_027, "normal", "a"),
      incoming(VAPOREON_SV035_134, "normal", "b"),
      incoming(CHARIZARD_EX_SV035_183, "normal", "c"),
      incoming(NEST_BALL_SV01_181, "normal", "d"),
    ];
    for (const c of cards) {
      const res = placeCard(
        c,
        ctx({
          catalog: [...CHARMANDER_CATALOG, EEVEE_SV035_133, VAPOREON_SV035_134, NEST_BALL_SV01_181],
        }),
      );
      expect(res.target.kind).toBeTruthy();
      expect(res.reason.length).toBeGreaterThan(0);
      expect(res.resolvedBy).toBe("auto");
    }
  });
});
