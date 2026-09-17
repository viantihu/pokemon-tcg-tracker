/**
 * Decision derivation + resolution (dev-spec §5 M7 acceptance):
 *   • every block / termination routes through a decision card;
 *   • a confirmed cap sets the line `capped` and wishlists the ex with `willLiveInSpecialty`;
 *   • the system PROPOSES (one recommended choice) and never auto-blocks.
 *
 * Pure: derivation reads persisted line state + catalog facts; resolution turns a chosen option into
 * the exact repo writes (line status, slot state, wishlist, audit reason).
 */

import { describe, expect, it } from "vitest";
import {
  deriveDecisions,
  resolveDecisionWrites,
  type DecisionLineInput,
  type DecisionSlotInput,
  type StageFacts,
} from "@/lib/line/decisions";
import type { CardIdentity, WishlistOption } from "@/lib/line/types";

const facts = (over: Partial<StageFacts> = {}): StageFacts => ({
  totalPrintings: 30,
  sameBandTotal: 3,
  sameBandStandard: 0,
  sameBandSpecialty: 3,
  otherBandExample: null,
  cheapestSameBand: 24.1,
  chosenLocalId: "006",
  ...over,
});

const ident = (name: string, localId: string): CardIdentity => ({
  tcgdexId: `${name}-${localId}`,
  name,
  setId: "mew",
  setName: "151",
  localId,
  imageUrl: null,
  bandKey: "red",
});

const alt = (name: string, localId: string, price: number, willSpec = false): WishlistOption => ({
  tcgdexId: `${name}-${localId}`,
  name,
  localId,
  setId: "mew",
  imageUrl: null,
  bandKey: "red",
  priceMarket: price,
  willLiveInSpecialty: willSpec,
});

const slot = (
  over: Partial<DecisionSlotInput> & { stageIndex: number; state: DecisionSlotInput["state"] },
): DecisionSlotInput => ({
  slotId: `s${over.stageIndex}`,
  stage: over.stageIndex === 0 ? "Basic" : over.stageIndex === 1 ? "Stage1" : "Stage2",
  dexId: 4 + over.stageIndex,
  speciesName: null,
  card: null,
  priceMarket: null,
  willLiveInSpecialty: false,
  alternates: [],
  facts: facts(),
  requiredType: "Fire",
  ...over,
});

const line = (
  over: Partial<DecisionLineInput> & { slots: DecisionSlotInput[] },
): DecisionLineInput => ({
  lineId: "L1",
  rootDexId: 4,
  bandKey: "red",
  bandDisplay: "Red",
  status: "open",
  binderLabel: "Binder 1 · BACK",
  claimedDexIds: new Set<number>(),
  ...over,
});

describe("deriveDecisions", () => {
  it("surfaces an ex-only cap with a recommended confirm choice and evidence", () => {
    const derived = deriveDecisions(
      line({
        status: "capped",
        slots: [
          slot({
            stageIndex: 0,
            state: "filled",
            speciesName: "Charmander",
            card: ident("Charmander", "026"),
          }),
          slot({
            stageIndex: 1,
            state: "filled",
            speciesName: "Charmeleon",
            card: ident("Charmeleon", "027"),
          }),
          slot({
            stageIndex: 2,
            state: "placeholder",
            speciesName: "Charizard ex",
            card: ident("Charizard ex", "006"),
            priceMarket: 24.1,
            willLiveInSpecialty: true,
            alternates: [alt("Charizard ex", "006", 24.1, true)],
          }),
        ],
      }),
    );
    expect(derived).toHaveLength(1);
    const d = derived[0].card;
    expect(d.kind).toBe("ex-only-cap");
    expect(d.choices.find((c) => c.recommended)?.id).toBe("confirm-cap");
    expect(d.catalog.length).toBeGreaterThan(0);
    expect(d.owned.length).toBe(3);
    expect(d.wishlist).toHaveLength(1);
  });

  it("surfaces a root block on a surviving line and a termination on a dead one", () => {
    const rootBlock = deriveDecisions(
      line({
        slots: [
          slot({
            stageIndex: 0,
            state: "block",
            speciesName: "Trapinch",
            facts: facts({ sameBandTotal: 0 }),
          }),
          slot({
            stageIndex: 1,
            state: "filled",
            speciesName: "Vibrava",
            card: ident("Vibrava", "109"),
          }),
          slot({
            stageIndex: 2,
            state: "placeholder",
            speciesName: "Flygon",
            card: ident("Flygon", "110"),
            priceMarket: 0.6,
          }),
        ],
      }),
    );
    expect(rootBlock.map((d) => d.card.kind)).toContain("root-block");

    const terminated = deriveDecisions(
      line({
        status: "terminated",
        slots: [
          slot({
            stageIndex: 0,
            state: "block",
            speciesName: "Scyther",
            facts: facts({ sameBandTotal: 0 }),
          }),
          slot({
            stageIndex: 1,
            state: "filled",
            speciesName: "Scizor",
            card: ident("Scizor", "141"),
          }),
        ],
      }),
    );
    expect(terminated).toHaveLength(1);
    expect(terminated[0].card.kind).toBe("termination");
  });

  it("surfaces a collection-vs-line conflict when a placeholder species is claimed", () => {
    const derived = deriveDecisions(
      line({
        rootDexId: 280,
        bandKey: "purple",
        bandDisplay: "Purple",
        claimedDexIds: new Set([280]),
        slots: [
          slot({
            stageIndex: 0,
            state: "placeholder",
            dexId: 280,
            speciesName: "Ralts",
            card: ident("Ralts", "084"),
            priceMarket: 0.09,
            facts: facts({ sameBandStandard: 30, sameBandSpecialty: 0 }),
          }),
        ],
      }),
    );
    expect(derived.map((d) => d.card.kind)).toContain("collection-vs-line");
  });
});

describe("resolveDecisionWrites", () => {
  const capRes = {
    kind: "ex-only-cap" as const,
    lineId: "L1",
    status: "capped" as const,
    slotId: "s2",
    stageIndex: 2,
    requiredDexId: 6,
    requiredType: "Fire",
    requiredStage: "Stage2",
    chosenCatalogCardId: "Charizard ex-006",
    alternateCatalogCardIds: ["Charizard ex-183"],
    willLiveInSpecialty: true,
    otherOpenSlotId: null,
  };

  it("a confirmed cap sets the line capped and wishlists the ex with willLiveInSpecialty", () => {
    const w = resolveDecisionWrites(capRes, "confirm-cap");
    expect(w.linePatch?.status).toBe("capped");
    expect(w.wishlistUpserts).toHaveLength(1);
    expect(w.wishlistUpserts[0].willLiveInSpecialty).toBe(true);
    expect(w.wishlistUpserts[0].chosenCatalogCardId).toBe("Charizard ex-006");
    expect(w.decision.reason).toMatch(/cap/i);
  });

  it("overriding the cap to a block keeps the line open, blocks the slot, drops the wishlist", () => {
    const w = resolveDecisionWrites(capRes, "block-instead");
    expect(w.linePatch?.status).toBe("open");
    expect(w.slotPatches[0]).toMatchObject({
      slotId: "s2",
      state: "block",
      targetCatalogCardId: null,
    });
    expect(w.wishlistResolveSlotIds).toContain("s2");
  });

  it("confirming a root block keeps the line open and blocks the slot", () => {
    const res = { ...capRes, kind: "root-block" as const, slotId: "s0", stageIndex: 0 };
    const w = resolveDecisionWrites(res, "confirm-root-block");
    expect(w.linePatch?.status).toBe("open");
    expect(w.slotPatches[0]).toMatchObject({ slotId: "s0", state: "block" });
  });

  it("choosing no-line / confirm-termination terminates the line", () => {
    expect(resolveDecisionWrites(capRes, "no-line").linePatch?.status).toBe("terminated");
    expect(resolveDecisionWrites(capRes, "confirm-termination").linePatch?.status).toBe(
      "terminated",
    );
  });

  it("leave-it writes only an audit row, no state change", () => {
    const w = resolveDecisionWrites(capRes, "leave-it");
    expect(w.linePatch).toBeUndefined();
    expect(w.slotPatches).toHaveLength(0);
    expect(w.wishlistUpserts).toHaveLength(0);
    expect(w.decision.decision).toBe("decision-deferred");
  });

  /* UIL-057 — she can pick any wishlist alternate the decision card showed, not just the
   * server-computed cheapest (the pre-fix behavior: chosenCatalogCardId was always capRes's own
   * default, no matter what choosing-a-different-alternate meant). */
  describe("picking a wishlist alternate (UIL-057)", () => {
    it("choosing the second alternative writes THAT catalog id to the wishlist row", () => {
      const w = resolveDecisionWrites(capRes, "confirm-cap", "Charizard ex-183");
      expect(w.wishlistUpserts[0].chosenCatalogCardId).toBe("Charizard ex-183");
      // The one she didn't pick becomes the alternate — never a self-reference.
      expect(w.wishlistUpserts[0].alternateCatalogCardIds).toEqual(["Charizard ex-006"]);
    });

    it("collection-wins ALSO honours a picked alternate, not just confirm-cap", () => {
      const collRes = {
        ...capRes,
        kind: "collection-vs-line" as const,
        willLiveInSpecialty: false,
      };
      const w = resolveDecisionWrites(collRes, "collection-wins", "Charizard ex-183");
      expect(w.wishlistUpserts[0].chosenCatalogCardId).toBe("Charizard ex-183");
      expect(w.wishlistUpserts[0].willLiveInSpecialty).toBe(false);
    });

    it("with no pick, still defaults to the server-computed cheapest (unchanged default)", () => {
      const w = resolveDecisionWrites(capRes, "confirm-cap");
      expect(w.wishlistUpserts[0].chosenCatalogCardId).toBe("Charizard ex-006");
      expect(w.wishlistUpserts[0].alternateCatalogCardIds).toEqual(["Charizard ex-183"]);
    });

    it("REFUSES a catalog id that was never one of this decision's options — never trust the browser", () => {
      const w = resolveDecisionWrites(capRes, "confirm-cap", "some-other-unrelated-card");
      expect(w.wishlistUpserts[0].chosenCatalogCardId).toBe("Charizard ex-006"); // falls back
      expect(w.wishlistUpserts[0].alternateCatalogCardIds).toEqual(["Charizard ex-183"]);
    });

    it("a choice that does not write a wishlist target ignores the pick harmlessly", () => {
      const w = resolveDecisionWrites(capRes, "block-instead", "Charizard ex-183");
      expect(w.wishlistUpserts).toHaveLength(0);
    });
  });

  it("every resolution records exactly one user audit decision", () => {
    for (const choice of [
      "confirm-cap",
      "cap-no-wishlist",
      "block-instead",
      "confirm-root-block",
      "root-block-no-wishlist",
      "no-line",
      "confirm-termination",
      "make-line-anyway",
      "collection-wins",
      "collection-wins-no-target",
      "leave-it",
    ] as const) {
      const w = resolveDecisionWrites(capRes, choice);
      expect(w.decision.decision).toBeTruthy();
      expect(w.decision.reason).toBeTruthy();
    }
  });
});
