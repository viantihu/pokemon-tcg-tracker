/**
 * UIL-067 — Karvi: "This UX is too crowded, and a lot of the information here is not helpful. I need
 * something simpler." The shape she approved (2026-09-20): the proposal; ONE line saying what physically
 * happens to this copy (which of the collection or the line ends up with it); one sentence of why; the
 * choice buttons. The CATALOG statistics, the you-own list, the rest of the reasoning and the alternates
 * grid move behind a Details disclosure — still there, closed by default.
 *
 * Static render of the real component: what is ABOVE the fold and what is INSIDE <details> are both
 * pinned, so the evidence cannot creep back up and the outcome line cannot quietly vanish.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DecisionCard as DecisionCardModel } from "@/lib/line/types";
import { DecisionCard } from "@/app/(ui)/_components/DecisionCard";

const DECISION: DecisionCardModel = {
  id: "L1:collection-vs-line:2",
  kind: "collection-vs-line",
  lineId: "L1",
  slotStageIndex: 2,
  title: "COLLECTION CLAIM vs LINE SLOT",
  question: "THIS IS THE CARD THE LINE NEEDS. COLLECTION STILL WINS?",
  card: {
    tcgdexId: "sv03-125",
    name: "Charizard",
    setId: "sv03",
    setName: "Obsidian Flames",
    localId: "125",
    setCardCountOfficial: 197,
    imageUrl: null,
    bandKey: "red",
  },
  catalog: [
    { mark: "y", text: "30 printings of Charizard in the catalog" },
    { mark: "s", text: "3 red, all specialty" },
  ],
  owned: [
    { mark: "s", text: "Claimed copy lives in a running collection" },
    { mark: "y", text: "Basic · Charmander · owned" },
  ],
  why: [
    "Collection claim is the first rule in the cascade. It beats a line on purpose.",
    "The collection needs one copy; a second printing fills the line for cheap.",
  ],
  proposal: "TO THE SPECIALTY BINDER · SLOT STAYS A PLACEHOLDER · WISHLIST CHARIZARD",
  outcome:
    "The COLLECTION keeps this copy, in the specialty binder. The LINE does not get it: this slot stays open for a second printing.",
  wishlist: [
    {
      tcgdexId: "sv03-010",
      name: "Charizard",
      localId: "010",
      setCardCountOfficial: 197,
      setId: "sv03",
      imageUrl: null,
      bandKey: "red",
      priceMarket: 4.25,
      badge: "CHEAPEST",
      willLiveInSpecialty: false,
    },
    {
      tcgdexId: "sv03-223",
      name: "Charizard ex",
      localId: "223",
      setCardCountOfficial: 197,
      setId: "sv03",
      imageUrl: null,
      bandKey: "red",
      priceMarket: 41,
      badge: "SPECIALTY",
      willLiveInSpecialty: true,
    },
  ],
  choices: [
    {
      id: "collection-wins",
      label: "Collection wins",
      description: "Slot stays a hunt.",
      recommended: true,
    },
    {
      id: "collection-wins-no-target",
      label: "Collection wins, no target",
      description: "Nothing wishlisted.",
    },
  ],
};

const render = (over: Partial<DecisionCardModel> = {}, resolvedLabel?: string) =>
  renderToStaticMarkup(
    createElement(DecisionCard, {
      decision: { ...DECISION, ...over },
      resolvedLabel,
      onChoose: () => {},
      onReopen: () => {},
      onClose: () => {},
    }),
  );
/** Split the markup at the disclosure so "above" and "inside" can be asserted separately. */
const split = (html: string) => {
  const at = html.indexOf("<details");
  expect(at).toBeGreaterThan(0);
  return { above: html.slice(0, at), inside: html.slice(at) };
};

describe("UIL-067 · above the fold: proposal, what happens to this copy, one why, the buttons", () => {
  it("shows the proposal, the outcome line under its own heading, and exactly the first why sentence", () => {
    const { above } = split(render());
    expect(above).toContain("PROPOSED");
    expect(above).toContain("TO THE SPECIALTY BINDER · SLOT STAYS A PLACEHOLDER");
    expect(above).toContain("WHAT HAPPENS TO THIS COPY");
    expect(above).toContain("The COLLECTION keeps this copy");
    expect(above).toContain("Collection claim is the first rule in the cascade.");
    expect(above).not.toContain("a second printing fills the line for cheap"); // why[1] lives in Details
    expect(above).toContain("Collection wins");
    expect(above).toContain("Pick a proposal above.");
  });

  it("keeps the wishlisting choice visible in one line and points at Details to change it", () => {
    const { above } = split(render());
    expect(above).toContain("WISHLISTING · Charizard 010/197 $4.25");
    expect(above).toContain("CHANGE UNDER DETAILS");
    expect(render({ wishlist: DECISION.wishlist.slice(0, 1) })).not.toContain(
      "CHANGE UNDER DETAILS",
    );
  });

  it("no catalog statistics, you-own list or alternates grid above the fold", () => {
    const { above } = split(render());
    expect(above).not.toContain(">CATALOG<");
    expect(above).not.toContain(">YOU OWN<");
    expect(above).not.toContain("30 printings of Charizard");
    expect(above).not.toContain('class="wcards"');
  });

  it("a decision without an outcome line (older fixtures) still renders, without the heading", () => {
    const html = render({ outcome: undefined });
    expect(html).not.toContain("WHAT HAPPENS TO THIS COPY");
    expect(html).toContain("PROPOSED");
  });
});

describe("UIL-067 · Details holds everything else, closed by default", () => {
  it("catalog, you own, the rest of the why, and the priced alternates grid, inside a closed <details>", () => {
    const { inside } = split(render());
    expect(inside.startsWith('<details class="dmore">')).toBe(true); // not `open`
    expect(inside).toContain("Details · catalog, what you own, alternates");
    expect(inside).toContain(">CATALOG<");
    expect(inside).toContain("30 printings of Charizard");
    expect(inside).toContain(">YOU OWN<");
    expect(inside).toContain("Claimed copy lives in a running collection");
    expect(inside).toContain("a second printing fills the line for cheap");
    expect(inside).toContain('class="wcards"');
    expect(inside).toContain("CHEAPEST");
    expect(inside).toContain("$41.00");
  });

  it("the resolved state keeps the same shape: YOU CHOSE above, evidence still behind Details", () => {
    const html = render({}, "Collection wins");
    const { above, inside } = split(html);
    expect(above).toContain("YOU CHOSE");
    expect(above).toContain("WHAT HAPPENS TO THIS COPY");
    expect(inside).toContain(">CATALOG<");
    expect(inside).not.toContain('role="button"'); // alternates are not pickable once resolved
  });
});
