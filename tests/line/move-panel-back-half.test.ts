/**
 * The BACK HALF chip is greyed while no line is picked (UIL-072, Karvi's ruling 2026-09-18).
 *
 * Her objection was to "a dead end that looks alive": back half sat alongside front half, collection
 * and bulk as an enabled peer, yet it is the one of the four `applyMove` refuses unless a line is
 * chosen (UIL-056's invariant, which stays). Put to her as three options she chose: keep refusing,
 * remove the false affordance, state the reason inline — "The back half holds lines. Pick a line
 * above to enable."
 *
 * Two things are pinned here, because they fail differently:
 *
 *   1. the chip is DISABLED (the native attribute, not a class) exactly when no line is picked, in
 *      every mode the panel is used in, and the reason names the condition and the remedy; and
 *   2. that disabled state is DERIVED from `isMoveDestinationComplete` — the predicate `applyMove`
 *      throws on — rather than restated. The last test pins the predicate's own answer for the shape
 *      the chip probes, so if lib/line ever relaxes the invariant, this file and the chip move together
 *      and a chip that stayed grey against an accepting server would be caught.
 *
 * Rendered with `react-dom/server`; `useState` initialisers run, effects do not, which is all the
 * initial disabled state needs. Pre-fix failure verified by mutation (forcing `backHalfNeedsLine` to
 * false), not asserted.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LineJoinCandidate, MoveDestination, MoveOptions } from "@/lib/line/types";
import { isMoveDestinationComplete } from "@/lib/line/move";
import { MovePanel } from "@/app/(ui)/_components/MovePanel";

const OPTIONS: MoveOptions = {
  binders: [
    { id: "b1", name: "Binder 1", type: "general" },
    { id: "spec", name: "Specialty A", type: "specialty" },
  ],
  collectionsByBinder: { spec: [{ id: "coll", name: "Starters" }] },
  bands: [
    { key: "red", display: "Red fire" },
    { key: "green", display: "Green grass" },
  ],
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

function render(props: {
  allowLineJoin?: boolean;
  joinCandidates?: LineJoinCandidate[];
  initial?: MoveDestination;
}): string {
  return renderToStaticMarkup(
    createElement(MovePanel, {
      options: OPTIONS,
      naturalBandKey: "red",
      onConfirm: () => {},
      ...props,
    }),
  );
}

/** The opening tag of the chip whose visible label is `label`, or null if it is not rendered. */
function chipTag(html: string, label: string): string | null {
  const m = new RegExp(`<button([^>]*)>${label}</button>`).exec(html);
  return m ? m[1] : null;
}
const isDisabled = (tag: string | null) => tag !== null && /\sdisabled(=""|\s|$)/.test(tag);

const HER_WORDS = "The back half holds lines.";

describe("UIL-072 · BACK HALF is greyed while no line is picked (Line screen, line-first flow)", () => {
  it("opens with BACK HALF disabled and FRONT HALF enabled when candidates exist and none is picked", () => {
    const html = render({ allowLineJoin: true, joinCandidates: [CANDIDATE] });
    const back = chipTag(html, "BACK HALF");
    const front = chipTag(html, "FRONT HALF");
    expect(back).not.toBeNull();
    expect(front).not.toBeNull();
    expect(isDisabled(back)).toBe(true); // the assertion the fix is pinned on
    expect(isDisabled(front)).toBe(false);
    // The reason is inline, in her words, and the remedy points at the picker (above, since the
    // line section leads when there is something to join) AND at the three live alternatives.
    expect(html).toContain(`${HER_WORDS} Pick a line above to enable.`);
    expect(html).toContain("Or choose the front half, a collection, or bulk.");
    // Confirm stays disabled too — the chip is the new signal, not a replacement for the gate.
    expect(chipTag(html, "Place it here ▶")).toMatch(/\sdisabled/);
    // The old free-floating hint is gone: one message, on the control it is about.
    expect(html).not.toContain("Back-half moves need a line");
  });

  it("points at the picker BELOW when there is nothing to join (the section order flips, UIL-068)", () => {
    const html = render({ allowLineJoin: true, joinCandidates: [] });
    expect(isDisabled(chipTag(html, "BACK HALF"))).toBe(true);
    expect(html).toContain(`${HER_WORDS} Pick a line below to enable.`);
    expect(html).not.toContain("Pick a line above");
  });

  it("enables BACK HALF once a line is picked — an existing line's slot", () => {
    const html = render({
      allowLineJoin: true,
      joinCandidates: [CANDIDATE],
      initial: {
        kind: "shelf",
        binderId: "b1",
        half: "back",
        band: "red",
        lineJoin: { mode: "existing", lineId: "L1", slotId: "S1" },
      },
    });
    const back = chipTag(html, "BACK HALF");
    expect(back).not.toBeNull();
    expect(isDisabled(back)).toBe(false);
    expect(html).not.toContain(HER_WORDS);
    expect(html).toContain("Line picked above");
    expect(chipTag(html, "Place it here ▶")).not.toMatch(/\sdisabled/);
  });

  it("enables BACK HALF once a line is picked — start a new line", () => {
    const html = render({
      allowLineJoin: true,
      joinCandidates: [],
      initial: {
        kind: "shelf",
        binderId: "b1",
        half: "back",
        band: "red",
        lineJoin: { mode: "new" },
      },
    });
    expect(isDisabled(chipTag(html, "BACK HALF"))).toBe(false);
    expect(html).not.toContain(HER_WORDS);
    expect(html).toContain("Line picked below");
  });

  it("still lets her leave a dead back-half default: FRONT HALF, the collection binder and bulk are live", () => {
    // The Line screen opens on the back half (defaultMoveHalf) — so the selected chip is the dead
    // one. Her way out must be visibly open, not just described.
    const html = render({ allowLineJoin: true, joinCandidates: [CANDIDATE] });
    expect(isDisabled(chipTag(html, "FRONT HALF"))).toBe(false);
    expect(isDisabled(chipTag(html, "Specialty A"))).toBe(false);
    expect(
      chipTag(html, "▤ Bulk box · don&#x27;t shelf") ?? chipTag(html, "▤ Bulk box · don't shelf"),
    ).not.toBeNull();
  });
});

describe("UIL-072 · panels with no line picker at all (plan spotlight, Collections)", () => {
  it("greys BACK HALF and names the screen that has the picker, instead of the old dead end", () => {
    // `allowLineJoin` off: no line can ever be chosen here, so back half can never be confirmed.
    // Pre-fix the chip was enabled and clicking it produced a hint plus a disabled Confirm.
    const html = render({ allowLineJoin: false });
    expect(isDisabled(chipTag(html, "BACK HALF"))).toBe(true);
    expect(isDisabled(chipTag(html, "FRONT HALF"))).toBe(false);
    expect(html).toContain(`${HER_WORDS} Move it from the Lines page to pick one.`);
    expect(html).not.toContain("Back-half moves choose a line. Do this from the Lines page.");
  });
});

describe("UIL-070 part 1 · once the Plan spotlight HAS a picker, the reason flips by the same signal", () => {
  it("with the picker on and nothing to join (the Plan's common case), names the picker below — not the Lines page", () => {
    // Exactly what PlanScreen.openMove now passes: candidates present (possibly empty), the cascade's
    // own front-half suggestion as `initial`. No per-screen branch exists in MovePanel — `allowLineJoin`
    // is the one hasPicker signal — so this pins that the Plan lands on the right side of it.
    const html = render({
      allowLineJoin: true,
      joinCandidates: [],
      initial: { kind: "shelf", binderId: "b1", half: "front", band: "red" },
    });
    expect(isDisabled(chipTag(html, "BACK HALF"))).toBe(true);
    expect(isDisabled(chipTag(html, "FRONT HALF"))).toBe(false);
    expect(html).toContain(`${HER_WORDS} Pick a line below to enable.`);
    expect(html).not.toContain("Lines page");
    // The picker really is there to pick from.
    expect(html).toContain("+ Start a new line");
  });
});

describe("UIL-072 · the chip derives from the invariant it mirrors, it does not restate it", () => {
  it("isMoveDestinationComplete refuses a back-half shelf without a line and accepts one with", () => {
    // This is the exact probe MovePanel makes. If lib/line ever relaxes UIL-056 so a bare back-half
    // shelf is complete, this fails — and so would the chip tests above, in the opposite direction —
    // which is the point: one rule, one place, and this file notices when it moves.
    expect(
      isMoveDestinationComplete({ kind: "shelf", binderId: "probe", half: "back", band: "probe" }),
    ).toBe(false);
    expect(
      isMoveDestinationComplete({
        kind: "shelf",
        binderId: "probe",
        half: "back",
        band: "probe",
        lineJoin: { mode: "new" },
      }),
    ).toBe(true);
    // And the front half never needed one — which is why only BACK HALF is ever greyed.
    expect(
      isMoveDestinationComplete({ kind: "shelf", binderId: "probe", half: "front", band: "probe" }),
    ).toBe(true);
  });
});
