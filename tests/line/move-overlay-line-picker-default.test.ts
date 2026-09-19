/**
 * UIL-070 part 1 follow-up (QA's debt item on #222): the Plan's call site could hard-code
 * `allowLineJoin={false}` with every test still green, because the picker's wiring lived in a prop no
 * test could see. MoveOverlay now derives it from its own card when the prop is omitted, so the picker
 * follows the data and a call site cannot drop it. These pin that default — and that an explicit prop
 * still wins, since the Line screen passes one.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LineJoinCandidate, MoveOptions } from "@/lib/line/types";
import { MoveOverlay, type MoveTargetCard } from "@/app/(ui)/_components/MoveOverlay";

const OPTIONS: MoveOptions = {
  binders: [{ id: "b1", name: "Binder 1", type: "general" }],
  collectionsByBinder: {},
  bands: [{ key: "red", display: "Red fire" }],
};
const CANDIDATE: LineJoinCandidate = {
  lineId: "L1",
  slotId: "S1",
  binderId: "b1",
  bandKey: "red",
  speciesLabel: "CHARMANDER LINE",
  stage: "Stage1",
  filledCount: 1,
  totalCount: 3,
};

function render(card: Partial<MoveTargetCard>, allowLineJoin?: boolean): string {
  return renderToStaticMarkup(
    createElement(MoveOverlay, {
      card: {
        copyId: "d1",
        name: "Charmeleon",
        localId: "099",
        imageUrl: null,
        bandKey: "red",
        currentLabel: "Binder 1 · Front · Red",
        initial: { kind: "shelf", binderId: "b1", half: "front", band: "red" },
        ...card,
      },
      options: OPTIONS,
      ...(allowLineJoin === undefined ? {} : { allowLineJoin }),
      onConfirm: () => {},
      onClose: () => {},
    }),
  );
}

const PICKER = "+ Start a new line";
const NO_PICKER_REASON = "Move it from the Lines page to pick one.";

describe("UIL-070 · MoveOverlay turns the line picker on from its own card when no prop is passed", () => {
  it("candidates present → the picker renders and the back-half reason points at it", () => {
    const html = render({ joinCandidates: [CANDIDATE], naturalBandKey: "red" });
    expect(html).toContain(PICKER);
    expect(html).toContain("CHARMANDER LINE");
    expect(html).toContain("Pick a line above to enable.");
    expect(html).not.toContain(NO_PICKER_REASON);
  });

  it("an EMPTY candidate list still turns it on (the Plan's common case) — 'start a new line' is the offer", () => {
    const html = render({ joinCandidates: [], naturalBandKey: "red" });
    expect(html).toContain(PICKER);
    expect(html).toContain("Pick a line below to enable.");
    expect(html).not.toContain(NO_PICKER_REASON);
  });

  it("no candidates at all (a Trainer, a failed lookup, Collections, Lookup) → the plain move", () => {
    const html = render({});
    expect(html).not.toContain(PICKER);
    expect(html).toContain(NO_PICKER_REASON);
  });

  it("an explicit prop still wins over the default, both ways", () => {
    expect(render({ joinCandidates: [CANDIDATE] }, false)).not.toContain(PICKER);
    expect(render({}, true)).toContain(PICKER);
  });
});
