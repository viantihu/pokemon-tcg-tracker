/**
 * UIL-061 — the spotlight must NAME the cards a new line would move, not count them.
 *
 * The old copy read "Starts a new red line for Charmeleon (3 same-colour cards so far) — goes to the
 * back half". A count is not disclosure: she cannot check a number against her binder, and the write
 * relocated those cards regardless. These pin that each one is named, says where it is now, and is
 * UNTICKED — a pre-checked box is not the validation she asked for.
 *
 * `react-dom/server`, so it runs in the suite's node environment.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlanItem, ProposedPull } from "@/lib/plan";
import { Spotlight } from "@/app/(ui)/plan/PlanScreen";

const item: PlanItem = {
  incomingId: "d1",
  tcgdexId: "sv03-027",
  name: "Charmeleon",
  setId: "sv03",
  localId: "27",
  imageUrl: null,
  variant: "normal",
  stage: "Stage1",
  isBasic: false,
  bandKey: "red",
  action: "NEWLINE",
  destination: "Binder 1 · Back · Red",
  reason: "Starts a new red line.",
  needsDecision: false,
};

const PULLS: ProposedPull[] = [
  {
    copyId: "c1",
    name: "Charmander",
    fromLabel: "Binder 1 · Front · Red",
    stageIndex: 0,
    fromLine: false,
    // A front-half pull: a card she can see on a page, nothing to dig out (UIL-087/088).
    needsFetching: false,
  },
  {
    copyId: "c2",
    name: "Charizard",
    // The honest either/or production now produces for an ambiguous `role: 'bulk'` (UIL-087).
    fromLabel: "Bulk box or still in the haul",
    stageIndex: 2,
    fromLine: true,
    needsFetching: true,
  },
];

function render(over: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(Spotlight, {
      item,
      done: false,
      busy: false,
      onShelve: () => {},
      onBackCard: () => {},
      onSkip: () => {},
      override: undefined,
      overrideNames: null,
      onMove: () => {},
      proposedPulls: PULLS,
      confirmedPulls: [],
      onTogglePull: () => {},
      ...over,
    }),
  );
}

describe("UIL-061 · the pulls are disclosed by name", () => {
  it("names every card it would move, and where it is now", () => {
    const html = render();
    expect(html).toContain("Charmander");
    expect(html).toContain("Binder 1 · Front · Red");
    expect(html).toContain("Charizard");
    // Honest either/or for an ambiguous `role: 'bulk'`, never a bare "Bulk box" (UIL-087).
    expect(html).toContain("Bulk box or still in the haul");
  });

  it("renders one checkbox per pull, all UNCHECKED", () => {
    const html = render();
    expect(html.split('type="checkbox"').length - 1).toBe(2);
    // The whole point: consent is opt-in. A pre-checked box would be the old behaviour with extra UI.
    expect(html).not.toContain("checked=");
  });

  it("reflects a tick without ticking the others", () => {
    const html = render({ confirmedPulls: ["c1"] });
    expect(html.split('checked=""').length - 1).toBe(1);
    expect(html).toContain("pullrow on");
  });

  it("flags a pull that would leave ANOTHER line short", () => {
    const html = render();
    // Charizard is in a line; Charmander is not. Only one warning.
    expect(html.split("in another line").length - 1).toBe(1);
  });

  it("says nothing at all when there is nothing to move", () => {
    const html = render({ proposedPulls: [] });
    expect(html).not.toContain("Also move your own cards?");
    expect(html).not.toContain('type="checkbox"');
  });

  it("disables the ticks once the card is shelved, since the write already happened", () => {
    const html = render({ done: true });
    expect(html.split("disabled").length - 1).toBeGreaterThanOrEqual(2);
  });
});
