// @vitest-environment jsdom
/**
 * A binder section at its limit takes no more cards, as a bulk box does not. The Move panel greys what it cannot take:
 * a full half's chip is disabled with the reason, a full specialty binder says so, and Confirm stays off if the
 * destination is a full section. A card already in that section is not entering it (`homeSection`), and the back half
 * still takes a card into a line it holds a slot for. The real panel in a DOM.
 */
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LineJoinCandidate, MoveOptions } from "@/lib/line/types";
import { MovePanel } from "@/app/(ui)/_components/MovePanel";

const OPTIONS: MoveOptions = {
  binders: [
    { id: "b1", name: "KB-001", type: "general" },
    { id: "sp", name: "Specialty A", type: "specialty" },
  ],
  collectionsByBinder: { sp: [{ id: "col", name: "Starters" }] },
  bands: [{ key: "red", display: "Red" }],
  sections: [
    { binderId: "b1", half: "front", free: 0 },
    { binderId: "b1", half: "back", free: 0 },
    { binderId: "sp", half: "single", free: 0 },
  ],
};
const confirm = () => screen.getByRole("button", { name: "Place it here ▶" }) as HTMLButtonElement;
const half = (h: "FRONT HALF" | "BACK HALF") =>
  screen.getByRole("button", { name: h }) as HTMLButtonElement;

function mount(props: Partial<Parameters<typeof MovePanel>[0]> = {}) {
  const onConfirm = vi.fn();
  const user = userEvent.setup();
  render(createElement(MovePanel, { options: OPTIONS, onConfirm, ...props }));
  return { user, onConfirm };
}
afterEach(cleanup);

describe("a full binder section in the Move panel", () => {
  it("the front half is greyed with the reason, and Confirm stays off", async () => {
    const { user, onConfirm } = mount({
      initial: { kind: "shelf", binderId: "b1", half: "front", band: "red" },
    });
    expect(half("FRONT HALF").disabled).toBe(true);
    expect(half("FRONT HALF").title).toBe(
      "KB-001's front half is full. Pick another place, or add pages in Settings.",
    );
    expect(screen.getByRole("alert").textContent).toBe(
      "KB-001's front half is full. Pick another place, or add pages in Settings.",
    );
    expect(confirm().disabled).toBe(true);
    await user.click(confirm());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("a half with room is not greyed", () => {
    mount({
      options: {
        ...OPTIONS,
        sections: [
          { binderId: "b1", half: "front", free: 2 },
          { binderId: "b1", half: "back", free: 0 },
        ],
      },
      initial: { kind: "shelf", binderId: "b1", half: "front", band: "red" },
    });
    expect(half("FRONT HALF").disabled).toBe(false);
    expect(confirm().disabled).toBe(false);
  });

  it("joining a line whose slot is reserved in a full back half is allowed; a NEW line there is not", async () => {
    const join = {
      lineId: "L",
      slotId: "S",
      binderId: "b1",
      bandKey: "red",
      speciesLabel: "Emberling",
      stage: "Stage1",
      filledCount: 1,
      totalCount: 2,
    } as LineJoinCandidate;
    const { user } = mount({ allowLineJoin: true, joinCandidates: [join] });
    await user.click(screen.getByRole("button", { name: /Emberling · .* · 1\/2 FILLED/ }));
    expect(half("BACK HALF").getAttribute("aria-pressed")).toBe("true");
    expect(half("BACK HALF").disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(confirm().disabled).toBe(false);
    // Starting a NEW line there takes pockets of its own: refused.
    await user.click(screen.getByRole("button", { name: /Start a new line/ }));
    expect(screen.getByRole("alert").textContent).toBe(
      "KB-001's back half is full. Pick another place, or add pages in Settings.",
    );
    expect(confirm().disabled).toBe(true);
  });

  it("a card already in that section is not entering it: the half is open for it", () => {
    mount({
      initial: { kind: "shelf", binderId: "b1", half: "front", band: "red" },
      homeSection: { binderId: "b1", half: "front" },
    });
    expect(half("FRONT HALF").disabled).toBe(false);
    expect(confirm().disabled).toBe(false);
  });

  it("a specialty binder at its limit says so on its chip, and its collection cannot be confirmed", async () => {
    const { user } = mount({
      initial: { kind: "collection", binderId: "sp", collectionId: "col" },
    });
    expect(screen.getByRole("button", { name: "Specialty A · full" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(
      "Specialty A is full. Pick another place, or add pages in Settings.",
    );
    expect(confirm().disabled).toBe(true);
    // A binder with room still works: bulk is never a binder section.
    await user.click(screen.getByRole("button", { name: /Bulk box/ }));
    expect(confirm().disabled).toBe(false);
  });

  it("an older caller whose options carry no rooms greys nothing", () => {
    const { sections: _none, ...older } = OPTIONS;
    void _none;
    mount({
      options: older,
      initial: { kind: "shelf", binderId: "b1", half: "front", band: "red" },
    });
    expect(half("FRONT HALF").disabled).toBe(false);
  });
});
