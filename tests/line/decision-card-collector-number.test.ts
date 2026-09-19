/**
 * UIL-077, the decision card — the last surface whose collector numbers were bare. Three places on it
 * name a printing: the card header (`d.card`, a CardIdentity), the "WISHLISTING · …" line, and each
 * wishlist alternate tile (`WishlistOption`). All three now render `formatCollectorNumber` with the same
 * fallback as everywhere else: "010/182" when the set total is known, "025" when TCGdex has none.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DecisionCard as DecisionCardModel, WishlistOption } from "@/lib/line/types";
import { DecisionCard } from "@/app/(ui)/_components/DecisionCard";

const alt = (
  localId: string,
  setCardCountOfficial: number | null,
  badge: string,
): WishlistOption => ({
  tcgdexId: `sv03-${localId}`,
  name: "Charizard ex",
  localId,
  setCardCountOfficial,
  setId: "sv03",
  imageUrl: null,
  bandKey: "red",
  priceMarket: 12.5,
  badge,
  willLiveInSpecialty: true,
});

const DECISION: DecisionCardModel = {
  id: "L1:ex-only-cap:2",
  kind: "ex-only-cap",
  lineId: "L1",
  slotStageIndex: 2,
  title: "LINE CAP · EX-ONLY COMPLETION",
  question: "NO STANDARD RED CHARIZARD EXISTS. CAP THE LINE?",
  card: {
    tcgdexId: "sv03-099",
    name: "Charizard ex",
    setId: "sv03",
    setName: "Obsidian Flames",
    localId: "099",
    setCardCountOfficial: 182,
    imageUrl: null,
    bandKey: "red",
  },
  catalog: [],
  owned: [],
  why: ["A specialty-class next stage means CAP, not COMPLETE."],
  proposal: "PLACEHOLDER + WISHLIST CHARIZARD · TAG SPECIALTY · LINE CAPPED",
  wishlist: [alt("010", 182, "CHEAPEST"), alt("025", null, "SPECIALTY")],
  choices: [
    { id: "confirm-cap", label: "Confirm the cap", description: "Cap it.", recommended: true },
    { id: "leave-it", label: "Leave it", description: "Nothing written." },
  ],
};

function render(decision: DecisionCardModel = DECISION): string {
  return renderToStaticMarkup(
    createElement(DecisionCard, {
      decision,
      onChoose: () => {},
      onReopen: () => {},
      onClose: () => {},
    }),
  );
}

describe("UIL-077 · the decision card shows full printed collector numbers", () => {
  it("the card header: 099/182", () => {
    expect(render()).toContain('<span class="no">099/182</span>');
  });

  it("each wishlist alternate tile: 010/182 for a set with a total, 025 (bare) for one without", () => {
    const html = render();
    const tiles = [...html.matchAll(/<div class="wno">([^<]*)<\/div>/g)].map((m) => m[1].trim());
    expect(tiles).toEqual(["010/182", "025"]);
  });

  it("the WISHLISTING line names the picked (default: cheapest) alternate with its full number", () => {
    expect(render()).toMatch(/WISHLISTING ·[^<]*Charizard ex 010\/182/);
  });

  it("a header with no total falls back to the bare number", () => {
    const html = render({ ...DECISION, card: { ...DECISION.card!, setCardCountOfficial: null } });
    expect(html).toContain('<span class="no">099</span>');
    expect(html).not.toContain("099/");
  });
});
