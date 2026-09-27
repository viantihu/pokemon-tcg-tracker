/**
 * UIL-126 — what counts as an UPGRADE of a card she has shelved. Karvi: "Yes, any holo or reverse holo counts" (a
 * card in a line), and for a front half "Yes, same as a holo". An upgrade is a holo or a reverse holo over a plain
 * NORMAL (not a 1st Edition or a W Promo), and in a line only in the line's own colour; it swaps in and the card it
 * replaces goes to the bulk box, as her call. Anything else stays a
 * duplicate (to the bulk box) or, for a line's filled stage, a plain extra copy (to the front half).
 *
 * ONE predicate (`isUpgradeOver`) decides it for both places it can happen: the duplicate step (the same art or
 * printing, a front half or a line slot) and the line step (ANY printing of that species over the card in a line).
 */
import { describe, expect, it } from "vitest";
import { isUpgradeOver, isUpgradeVariant, resolveDuplicate } from "@/lib/engine/duplicate";
import { placeCard } from "@/lib/engine/cascade";
import type { EngineContext } from "@/lib/engine/cascade";
import type { OwnedCopy, Variant } from "@/lib/engine/types";
import {
  CHARMANDER_SV03_026,
  CHARMELEON_SV03_027,
  CHARMELEON_SV035_005,
  KEY_FORM_TYPE_COLOR_MAP,
} from "./fixtures";

const copy = (over: Partial<OwnedCopy> & Pick<OwnedCopy, "id" | "card">): OwnedCopy => ({
  variant: "normal",
  role: "shelved",
  binderId: "B1",
  binderHalf: "front",
  colorBand: "red",
  lineSlotId: null,
  ...over,
});

describe("isUpgradeOver, the one rule", () => {
  it("a holo or a reverse holo over a plain normal", () => {
    expect(isUpgradeVariant("holo")).toBe(true);
    expect(isUpgradeVariant("reverse")).toBe(true);
    expect(isUpgradeVariant("normal")).toBe(false);
    expect(isUpgradeOver("holo", "normal")).toBe(true);
    expect(isUpgradeOver("reverse", "normal")).toBe(true);
  });

  it.each([
    ["normal", "reverse"],
    ["reverse", "holo"],
    ["holo", "holo"],
    ["holo", "reverse"],
    ["reverse", "reverse"],
    ["normal", "normal"],
    // Only a NORMAL is upgraded: a 1st Edition or a W Promo is not swapped out to bulk (TL review).
    ["holo", "firstEdition"],
    ["reverse", "firstEdition"],
    ["holo", "wPromo"],
    ["reverse", "wPromo"],
    ["firstEdition", "normal"],
    ["wPromo", "normal"],
  ] as [Variant, Variant][])("%s over %s is not an upgrade", (incoming, held) => {
    expect(isUpgradeOver(incoming, held)).toBe(false);
  });
});

describe("the duplicate step: the same art or printing", () => {
  it("a reverse holo over a front-half normal swaps in (her 'same as a holo'), and the normal goes to bulk", () => {
    const owned = [copy({ id: "n", card: CHARMANDER_SV03_026 })];
    const out = resolveDuplicate(CHARMANDER_SV03_026, "reverse", owned);
    // PRE-FIX: "bulk".
    expect(out).toMatchObject({
      kind: "holo-swap",
      swap: { displacedCopyId: "n", incomingInherits: { binderHalf: "front", lineSlotId: null } },
    });
  });

  it("a reverse holo over the normal in a line slot swaps in, taking the slot", () => {
    const owned = [
      copy({ id: "n", card: CHARMANDER_SV03_026, binderHalf: "back", lineSlotId: "slot-1" }),
    ];
    expect(resolveDuplicate(CHARMANDER_SV03_026, "reverse", owned)).toMatchObject({
      kind: "holo-swap",
      swap: { incomingInherits: { lineSlotId: "slot-1" } },
    });
  });

  it.each([
    ["normal", "reverse"],
    ["reverse", "holo"],
    ["holo", "holo"],
    ["holo", "firstEdition"],
    ["reverse", "wPromo"],
    ["firstEdition", "normal"],
  ] as [Variant, Variant][])("%s over a shelved %s goes to bulk", (incoming, held) => {
    const owned = [copy({ id: "c", card: CHARMANDER_SV03_026, variant: held })];
    expect(resolveDuplicate(CHARMANDER_SV03_026, incoming, owned).kind).toBe("bulk");
  });
});

describe("the line step: ANY printing of the species over the card in a line", () => {
  // Her Charmander line: Basic filled; Stage 1 filled by a Charmeleon of ANOTHER printing (sv03-027), so the incoming
  // sv035-005 is not a same-art duplicate and reaches the line step.
  const ctxWith = (heldVariant: Variant): EngineContext => ({
    typeColorMap: KEY_FORM_TYPE_COLOR_MAP,
    catalog: [CHARMANDER_SV03_026, CHARMELEON_SV03_027, CHARMELEON_SV035_005],
    owned: [
      copy({ id: "cmd", card: CHARMANDER_SV03_026, binderHalf: "back", lineSlotId: "s0" }),
      copy({
        id: "cml",
        card: CHARMELEON_SV03_027,
        variant: heldVariant,
        binderHalf: "back",
        lineSlotId: "s1",
      }),
    ],
    binders: [{ id: "B1", type: "general", name: "KB-001", isActive: true }],
    lines: [
      {
        id: "L1",
        rootDexId: 4,
        colorBand: "red",
        binderId: "B1",
        status: "complete",
        slots: [
          {
            id: "s0",
            stageIndex: 0,
            stage: "Basic",
            state: "filled",
            copyId: "cmd",
            dexId: 4,
            targetCatalogCardId: null,
          },
          {
            id: "s1",
            stageIndex: 1,
            stage: "Stage1",
            state: "filled",
            copyId: "cml",
            dexId: 5,
            targetCatalogCardId: null,
          },
        ],
      },
    ],
    collections: [],
    now: "2026-09-27T00:00:00Z",
  });
  const route = (variant: Variant, held: Variant) =>
    placeCard({ id: "in", card: CHARMELEON_SV035_005, variant }, ctxWith(held));

  it.each(["holo", "reverse"] as Variant[])(
    "a %s of another printing over the line's normal is an UPGRADE: it can take the slot, the normal to bulk",
    (variant) => {
      const r = route(variant, "normal");
      // PRE-FIX: a plain extra copy (filledStage, front half) for both.
      expect(r.step).toBe("duplicate");
      expect(r.target).toMatchObject({ kind: "back-half-line", lineId: "inherited" });
      expect(r.swap).toMatchObject({
        displacedCopyId: "cml",
        incomingInherits: { lineSlotId: "s1", binderHalf: "back" },
      });
    },
  );

  it.each([
    ["holo", "reverse"],
    ["reverse", "holo"],
    ["holo", "holo"],
    ["normal", "normal"],
    ["normal", "reverse"],
    ["holo", "firstEdition"],
    ["reverse", "wPromo"],
    ["wPromo", "normal"],
  ] as [Variant, Variant][])(
    "a %s over the line's %s is a PLAIN extra copy: the front half, no swap",
    (variant, held) => {
      const r = route(variant, held);
      expect(r.step).toBe("line-existing");
      expect(r.swap).toBeUndefined();
      expect(r.target.kind).toBe("front-half");
      expect(r.filledStage).toEqual({ lineId: "L1", stageIndex: 1 });
    },
  );

  it("a holo of a printing in ANOTHER colour is no silent upgrade: a plain extra copy, whose swap asks (UIL-069)", () => {
    // A Charmeleon printing of another type is another band; her line is Red.
    const otherColour = {
      ...CHARMELEON_SV035_005,
      tcgdexId: "x-cml-dark",
      types: ["Darkness"],
      artworkGroupId: "art-x-cml-dark",
    };
    const ctx = ctxWith("normal");
    const r = placeCard(
      { id: "in", card: otherColour, variant: "holo" },
      { ...ctx, catalog: [...ctx.catalog, otherColour] },
    );
    expect(r.step).toBe("line-existing");
    expect(r.swap).toBeUndefined();
    expect(r.filledStage).toEqual({ lineId: "L1", stageIndex: 1 });
  });
});
