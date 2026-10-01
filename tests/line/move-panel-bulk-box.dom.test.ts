// @vitest-environment jsdom
/**
 * UIL-130 — the Move panel picks a bulk box. Karvi, 2026-09-29: several boxes; a box with a card limit that is full
 * takes no more ("Stop it, ask for another"); an untracked box is never full. Her default box is pre-selected when it
 * has room; a full box is shown disabled with the reason; with every box full, nothing can be confirmed into bulk.
 * Driven through the real panel in a DOM.
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

  it("a full box is shown disabled with the reason; her default full, her next box with room is pre-selected", async () => {
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
    await user.click(confirm());
    expect(onConfirm).toHaveBeenCalledWith({ kind: "bulk", unitId: "s" });
  });

  it("every box full: it says so, and nothing can be confirmed into bulk", async () => {
    const { onConfirm } = mount({
      ...base,
      bulkUnits: [box("d", "Bulk box", 1, 1, true)],
    });
    expect(screen.getByRole("alert").textContent).toMatch(/Every bulk box is full/);
    expect(confirm().disabled).toBe(true);
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
});
