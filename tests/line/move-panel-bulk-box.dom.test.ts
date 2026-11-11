// @vitest-environment jsdom
/**
 * UIL-130 — the Move panel picks a bulk box. Karvi, 2026-09-29: several boxes; a box with a card limit that is full
 * takes no more ("Stop it, ask for another"); an untracked box is never full. Her default box is pre-selected when it
 * has room.
 *
 * A full box takes no more cards, however she got there (no "add anyway"): it is shown greyed with the reason, cannot
 * be picked, and Confirm stays off if it is the one the sheet opened on. With every box full she is told how to make
 * room. Driven through the real panel in a DOM.
 */
import { createElement } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MoveOptions } from "@/lib/line/types";
import { MovePanel } from "@/app/(ui)/_components/MovePanel";

const base: MoveOptions = {
  binders: [{ id: "b1", name: "Binder 1", type: "general" }],
  collectionsByBinder: {},
  bands: [{ key: "red", display: "Red" }],
};
const box = (
  id: string,
  name: string,
  held: number,
  capacity: number | null,
  isDefault = false,
) => ({
  id,
  name,
  held,
  capacity,
  isDefault,
});

function mount(options: MoveOptions, initial?: Parameters<typeof MovePanel>[0]["initial"]) {
  const onConfirm = vi.fn();
  const user = userEvent.setup();
  render(createElement(MovePanel, { options, initial: initial ?? { kind: "bulk" }, onConfirm }));
  return { onConfirm, user };
}
const confirm = () => screen.getByRole("button", { name: "Place it here ▶" }) as HTMLButtonElement;
const boxes = () => within(screen.getByRole("group", { name: "Which bulk box" }));
afterEach(cleanup);

describe("UIL-130 · the Move panel's bulk box", () => {
  it("her default box with room is pre-selected, and the Move names it", async () => {
    const { user, onConfirm } = mount({
      ...base,
      bulkUnits: [box("d", "Bulk box", 54, null, true), box("s", "Shoebox", 10, 60)],
    });
    expect(
      boxes()
        .getByRole("button", { name: "Bulk box · 54 cards · no limit" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await user.click(confirm());
    expect(onConfirm).toHaveBeenCalledWith({ kind: "bulk", unitId: "d" });
  });

  it("she picks another box, and the Move names it", async () => {
    const { user, onConfirm } = mount({
      ...base,
      bulkUnits: [box("d", "Bulk box", 54, null, true), box("s", "Shoebox", 10, 60)],
    });
    await user.click(boxes().getByRole("button", { name: "Shoebox · 10 of 60 cards" }));
    await user.click(confirm());
    expect(onConfirm).toHaveBeenCalledWith({ kind: "bulk", unitId: "s" });
  });

  it("her default full: her next box with room is pre-selected; the full box is greyed, with the reason", async () => {
    const { user, onConfirm } = mount({
      ...base,
      bulkUnits: [box("d", "Bulk box", 60, 60, true), box("s", "Shoebox", 10, 60)],
    });
    const full = boxes().getByRole("button", {
      name: "Bulk box · 60 of 60 cards · full",
    }) as HTMLButtonElement;
    expect(full.disabled).toBe(true);
    expect(full.title).toBe("Bulk box is full (60 of 60 cards). Pick another box.");
    expect(
      boxes()
        .getByRole("button", { name: /Shoebox/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await user.click(full);
    await user.click(confirm());
    expect(onConfirm).toHaveBeenCalledWith({ kind: "bulk", unitId: "s" });
  });

  it("a full box cannot be picked: it stays off, and the box she is on is unchanged", async () => {
    const { user, onConfirm } = mount({
      ...base,
      bulkUnits: [box("d", "Bulk box", 54, null, true), box("s", "Shoebox", 60, 60)],
    });
    await user.click(boxes().getByRole("button", { name: /Shoebox/ }));
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(confirm());
    expect(onConfirm).toHaveBeenCalledWith({ kind: "bulk", unitId: "d" });
  });

  it("every box full: nothing can be picked, Confirm stays off, and she is told how to make room", async () => {
    const { user, onConfirm } = mount({
      ...base,
      bulkUnits: [box("d", "Bulk box", 1, 1, true), box("s", "Shoebox", 2, 2)],
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "Every bulk box is full. Raise a box's limit or add a box in Settings, or pick another place.",
    );
    for (const name of [/Bulk box/, /Shoebox/]) {
      expect((boxes().getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(confirm().disabled).toBe(true);
    await user.click(confirm());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("a Move opened on a named box starts there", () => {
    mount(
      { ...base, bulkUnits: [box("d", "Bulk box", 1, null, true), box("s", "Shoebox", 0, null)] },
      { kind: "bulk", unitId: "s" },
    );
    expect(
      boxes()
        .getByRole("button", { name: /Shoebox/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("an older caller with no boxes: the bulk box is one place, and the Move names none", async () => {
    const { user, onConfirm } = mount(base);
    await user.click(confirm());
    expect(onConfirm).toHaveBeenCalledWith({ kind: "bulk" });
  });

  it("every box full: the front half and a collection still confirm, as before (Karvi: always movable)", async () => {
    const options: MoveOptions = {
      binders: [
        { id: "b1", name: "Binder 1", type: "general" },
        { id: "sp", name: "Specialty A", type: "specialty" },
      ],
      collectionsByBinder: { sp: [{ id: "col", name: "Starters" }] },
      bands: [{ key: "red", display: "Red" }],
      bulkUnits: [box("d", "Bulk box", 1, 1, true)],
    };
    const { user, onConfirm } = mount(options);
    // Bulk cannot be confirmed (every box is full); the shelf and the collection still can.
    expect(confirm().disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Binder 1" }));
    await user.click(screen.getByRole("button", { name: /Red/ }));
    expect(confirm().disabled).toBe(false);
    await user.click(confirm());
    expect(onConfirm).toHaveBeenLastCalledWith({
      kind: "shelf",
      binderId: "b1",
      half: "front",
      band: "red",
    });
    await user.click(screen.getByRole("button", { name: "Specialty A" }));
    await user.click(screen.getByRole("button", { name: "Starters" }));
    expect(confirm().disabled).toBe(false);
    await user.click(confirm());
    expect(onConfirm).toHaveBeenLastCalledWith({
      kind: "collection",
      binderId: "sp",
      collectionId: "col",
    });
  });

  it("a Move opened on a FULL box that is not the card's own: the reason, Confirm off, and a box with room still works", async () => {
    const { user, onConfirm } = mount(
      { ...base, bulkUnits: [box("d", "Bulk box", 5, null, true), box("s", "Shoebox", 2, 2)] },
      { kind: "bulk", unitId: "s" },
    );
    expect(screen.getByRole("alert").textContent).toBe(
      "Shoebox is full (2 of 2 cards). Pick another box.",
    );
    expect(confirm().disabled).toBe(true);
    await user.click(boxes().getByRole("button", { name: /Bulk box/ }));
    expect(confirm().disabled).toBe(false);
    await user.click(confirm());
    expect(onConfirm).toHaveBeenCalledWith({ kind: "bulk", unitId: "d" });
  });

  it("0037 · the card's own box (homeBoxId) is shown without the card: not full for it", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      createElement(MovePanel, {
        options: {
          ...base,
          bulkUnits: [box("d", "Bulk box", 5, null, true), box("s", "Shoebox", 2, 2)],
        },
        initial: { kind: "bulk", unitId: "s" },
        homeBoxId: "s",
        onConfirm,
      }),
    );
    expect(boxes().getByRole("button", { name: "Shoebox · 1 of 2 cards" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(confirm());
    expect(onConfirm).toHaveBeenCalledWith({ kind: "bulk", unitId: "s" });
  });
});
