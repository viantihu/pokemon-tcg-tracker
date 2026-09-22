// @vitest-environment jsdom
/**
 * UIL-073 — the MovePanel line picker, driven through the REAL component in a DOM: the candidate chip
 * is clicked, and what she then sees and what the host then receives are both asserted.
 *
 * tests/line/move-panel-back-half.test.ts pins the INITIAL states (static render) and pins the
 * BACK HALF chip's disabled state to `isMoveDestinationComplete`. What it cannot do is click: the
 * picker → derived destination → reason-text flip → confirm payload chain ran only in a browser until
 * now, and QA recorded the `allowLineJoin` wiring on #222 as verified by reading for that reason.
 *
 * Same opt-in harness as tests/components/card-lightbox.dom.test.ts: `@vitest-environment jsdom`
 * pragma, `*.dom.test.ts` name, explicit `cleanup` (no vitest globals, so Testing Library cannot
 * register its own afterEach).
 */
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LineJoinCandidate, MoveOptions } from "@/lib/line/types";
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

const HER_WORDS = /The back half holds lines\./;

function mount(over: Partial<Parameters<typeof MovePanel>[0]> = {}) {
  const onConfirm = vi.fn();
  const user = userEvent.setup();
  render(
    createElement(MovePanel, {
      options: OPTIONS,
      naturalBandKey: "red",
      allowLineJoin: true,
      joinCandidates: [CANDIDATE],
      onConfirm,
      ...over,
    }),
  );
  return { onConfirm, user };
}

const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
/** UIL-084: the chip names the binder the line would be started in, so match its stem. */
const NEW_LINE = /^\+ Start a new line/;
const pressed = (b: HTMLButtonElement) => b.getAttribute("aria-pressed") === "true";
const candidate = () => button(/CHARMANDER LINE/);
const backHalf = () => button("BACK HALF");
const confirm = () => button("Place it here ▶");

afterEach(cleanup);

describe("UIL-073 · before any pick (the Line screen's opening state, line-first)", () => {
  it("BACK HALF is disabled with the reason pointing above, nothing is pressed in the picker, Confirm is off", () => {
    mount();
    expect(backHalf().disabled).toBe(true);
    expect(screen.getByText(/Pick a line above to enable/)).toBeTruthy();
    expect(pressed(candidate())).toBe(false);
    expect(pressed(button(NEW_LINE))).toBe(false);
    expect(confirm().disabled).toBe(true);
    expect(screen.getByText(/PICK A LINE/)).toBeTruthy();
  });
});

describe("UIL-073 · clicking a line-candidate chip selects it and the reason flips", () => {
  it("the chip is pressed, her reason is gone, 'Line picked above' appears, BACK HALF enables and is selected, the band follows the line", async () => {
    const { user } = mount();
    await user.click(candidate());

    expect(pressed(candidate())).toBe(true);
    expect(screen.queryByText(HER_WORDS)).toBeNull();
    expect(screen.getByText(/Line picked above/)).toBeTruthy();
    expect(backHalf().disabled).toBe(false);
    expect(pressed(backHalf())).toBe(true);
    expect(pressed(button(/Red fire/))).toBe(true);
    expect(screen.getByText(/CHARMANDER LINE/, { selector: "b" })).toBeTruthy(); // the PLACING summary
    expect(confirm().disabled).toBe(false);
  });

  it("Confirm then hands the host the destination DERIVED from the pick: its line + slot, its binder, back half, its band", async () => {
    const { onConfirm, user } = mount();
    await user.click(candidate());
    await user.click(confirm());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith({
      kind: "shelf",
      binderId: "b1",
      half: "back",
      band: "red",
      lineJoin: { mode: "existing", lineId: "L1", slotId: "S1" },
    });
  });

  it("'+ Start a new line' selects the new-line choice, flips the reason the same way, and confirms with mode new on her natural band", async () => {
    const { onConfirm, user } = mount();
    await user.click(button(NEW_LINE));
    expect(pressed(button(NEW_LINE))).toBe(true);
    expect(pressed(candidate())).toBe(false);
    expect(screen.queryByText(HER_WORDS)).toBeNull();
    expect(screen.getByText(/Line picked above/)).toBeTruthy();
    await user.click(confirm());
    expect(onConfirm).toHaveBeenCalledWith({
      kind: "shelf",
      binderId: "b1",
      half: "back",
      band: "red",
      lineJoin: { mode: "new" },
    });
  });

  it("forcing a binder by hand after a pick clears the line: the chip unpresses, the reason returns, BACK HALF greys, Confirm is off again", async () => {
    const { onConfirm, user } = mount();
    await user.click(candidate());
    await user.click(button("Binder 1"));

    expect(pressed(candidate())).toBe(false);
    expect(screen.getByText(HER_WORDS)).toBeTruthy();
    expect(screen.queryByText(/Line picked/)).toBeNull();
    expect(backHalf().disabled).toBe(true);
    expect(confirm().disabled).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("with nothing to join the picker sits below the manual controls, and the reason says so — before and after the pick", async () => {
    const { user } = mount({ joinCandidates: [] });
    expect(screen.getByText(/Pick a line below to enable/)).toBeTruthy();
    await user.click(button(NEW_LINE));
    expect(screen.getByText(/Line picked below/)).toBeTruthy();
    expect(backHalf().disabled).toBe(false);
  });
});
