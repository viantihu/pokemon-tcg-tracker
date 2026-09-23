// @vitest-environment jsdom
/**
 * UIL-084, the sheet — "start a new line" names the binder it would start it in, and the panel refuses
 * exactly what the server refuses: a second line for one species, in one band, in ONE binder.
 *
 * Her report: the only offer the sheet could make for a second Toedscruel was "+ Start a new line", the
 * note under it said "this one starts its own line instead", and the write refused it every time —
 * because line uniqueness ignored the binder and its remedy ("join it instead") named a slot that did
 * not exist. The panel now asks the same question the write answers, keyed by BINDER AND BAND.
 *
 * Driven through the real `MovePanel` in a DOM (QA's rule for a click path): chips are clicked, and what
 * she can confirm, what the note says, and what the host receives are all asserted.
 */
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lineKey } from "@/lib/line/join-options";
import type { ExistingLineBlock, MoveOptions } from "@/lib/line/types";
import { MovePanel } from "@/app/(ui)/_components/MovePanel";

/** Two general binders: KB-001 holds the family's Orange line, KB-002 is the one she is filling. */
const OPTIONS: MoveOptions = {
  binders: [
    { id: "kb1", name: "KB-001", type: "general" },
    { id: "kb2", name: "KB-002", type: "general" },
  ],
  collectionsByBinder: {},
  bands: [
    { key: "orange", display: "Orange" },
    { key: "red", display: "Red fire" },
  ],
};

/** The Orange TOEDSCOOL line, in KB-001, every stage filled — so there is no slot to join. */
const IN_KB1: ExistingLineBlock = {
  speciesLabel: "TOEDSCOOL LINE",
  filledCount: 2,
  totalCount: 2,
  binderId: "kb1",
  bandKey: "orange",
  // UIL-090: a line belongs to one regional variant; these fixtures are English.
  locale: "en",
};

function mount(over: Partial<Parameters<typeof MovePanel>[0]> = {}) {
  const onConfirm = vi.fn();
  const user = userEvent.setup();
  render(
    createElement(MovePanel, {
      options: OPTIONS,
      naturalBandKey: "orange",
      allowLineJoin: true,
      joinCandidates: [], // her case: the line's matching stage is filled, so nothing to join
      existingLineByBinderBand: { [lineKey("kb1", "orange", "en")]: IN_KB1 },
      onConfirm,
      ...over,
    }),
  );
  return { onConfirm, user };
}

const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const newLine = () => button(/^\+ Start a new line/);
const confirm = () => button("Place it here ▶");
/**
 * With nothing to join, the manual controls render FIRST and the line picker second, so both sections
 * offer band chips — the picker's is the last one. Scoped rather than `getByRole`, which would match two.
 */
const pickerBand = (name: RegExp) => {
  const all = screen.getAllByRole("button", { name }) as HTMLButtonElement[];
  return all[all.length - 1];
};
const note = () => screen.queryByText(/already has TOEDSCOOL LINE in this band/);

afterEach(cleanup);

describe("UIL-084 · the new-line chip names the binder it would start the line in", () => {
  it("reads 'in KB-001' on the binder that is selected, and follows her to KB-002", async () => {
    const { user } = mount();
    expect(newLine().textContent).toContain("in KB-001");
    await user.click(button("KB-002"));
    expect(newLine().textContent).toContain("in KB-002");
  });
});

describe("UIL-084 · a second line in the binder that already has one is refused, with remedies that exist", () => {
  it("explains the block and disables Confirm, instead of recommending the one action that cannot succeed", async () => {
    const { user } = mount();
    await user.click(newLine());
    // The band defaults to her natural Orange, which is the band KB-001's line holds.
    expect(note()).toBeTruthy();
    expect(note()!.textContent).toContain("one binder tracks a species once per band");
    expect(note()!.textContent).toContain("pick a different binder");
    expect(confirm().disabled).toBe(true);
  });

  it("the SAME pick in KB-002 is allowed, says nothing about a block, and confirms a new line there", async () => {
    const { onConfirm, user } = mount();
    // Binder first: forcing a binder by hand deliberately clears a line choice (UIL-073), so this is
    // the order she actually works in — choose where it goes, then choose to start a line there.
    await user.click(button("KB-002"));
    await user.click(newLine());
    expect(note()).toBeNull();
    expect(confirm().disabled).toBe(false);

    await user.click(confirm());
    expect(onConfirm).toHaveBeenCalledWith({
      kind: "shelf",
      binderId: "kb2",
      half: "back",
      band: "orange",
      lineJoin: { mode: "new" },
    });
  });

  it("a DIFFERENT band in the blocked binder is allowed too — the key is binder AND band", async () => {
    const { onConfirm, user } = mount();
    await user.click(newLine());
    await user.click(pickerBand(/Red fire/));
    expect(note()).toBeNull();
    expect(confirm().disabled).toBe(false);
    await user.click(confirm());
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ binderId: "kb1", band: "red", lineJoin: { mode: "new" } }),
    );
  });

  it("the front half is unaffected: no line is involved, so no block and no refusal", async () => {
    const { onConfirm, user } = mount();
    await user.click(button("FRONT HALF"));
    expect(note()).toBeNull();
    expect(confirm().disabled).toBe(false);
    await user.click(confirm());
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ binderId: "kb1", half: "front", band: "orange" }),
    );
  });

  it("with NO existing line anywhere, the chip still names its binder and nothing is blocked", async () => {
    const { user } = mount({ existingLineByBinderBand: {} });
    await user.click(newLine());
    expect(newLine().textContent).toContain("in KB-001");
    expect(note()).toBeNull();
    expect(confirm().disabled).toBe(false);
  });
});
