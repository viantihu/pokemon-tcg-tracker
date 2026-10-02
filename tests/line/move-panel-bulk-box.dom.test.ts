// @vitest-environment jsdom
/**
 * UIL-130 — the Move panel picks a bulk box. Karvi, 2026-09-29: several boxes; a box with a card limit that is full
 * takes no more ("Stop it, ask for another"); an untracked box is never full. Her default box is pre-selected when it
 * has room.
 *
 * 0037 — Karvi, 2026-10-01/02: "The rules should exist only for the recommendation engine. Users should always be able
 * to override all rules." So a full box is the recommendation's "no", not a wall: it can be picked, the panel warns in
 * her words, and Confirm says "Add anyway · N over" and sends the box with `overFull`. With every box full, each box
 * offers Add anyway. Driven through the real panel in a DOM.
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
const addAnyway = (n: number) =>
  screen.getByRole("button", { name: `Add anyway · ${n} over` }) as HTMLButtonElement;
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

  it("her default full: her next box with room is pre-selected; the full box is shown with the reason, and can be picked", async () => {
    const { user, onConfirm } = mount({
      ...base,
      bulkUnits: [box("d", "Bulk box", 60, 60, true), box("s", "Shoebox", 10, 60)],
    });
    const full = boxes().getByRole("button", {
      name: "Bulk box · 60 of 60 cards · full",
    }) as HTMLButtonElement;
    // 0037: no longer disabled. The recommendation still starts on a box with room (below).
    expect(full.disabled).toBe(false);
    expect(full.title).toBe("Bulk box is full (60 of 60 cards). Pick another box.");
    expect(
      boxes()
        .getByRole("button", { name: /Shoebox/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await user.click(confirm());
    expect(onConfirm).toHaveBeenCalledWith({ kind: "bulk", unitId: "s" });
  });

  it("she picks a FULL box: the warning in her words, Confirm says Add anyway · 1 over, and sends it with overFull", async () => {
    const { user, onConfirm } = mount({
      ...base,
      bulkUnits: [box("d", "Bulk box", 54, null, true), box("s", "Shoebox", 60, 60)],
    });
    // Before: no warning, the plain Confirm.
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(boxes().getByRole("button", { name: "Shoebox · 60 of 60 cards · full" }));
    expect(screen.getByRole("alert").textContent).toBe(
      "Shoebox is full (60 of 60 cards). Pick another box. Or add it anyway: it will be 1 over.",
    );
    expect(screen.queryByRole("button", { name: "Place it here ▶" })).toBeNull();
    expect(addAnyway(1).disabled).toBe(false);
    await user.click(addAnyway(1));
    expect(onConfirm).toHaveBeenCalledWith({ kind: "bulk", unitId: "s", overFull: true });
  });

  it("a box already over its limit: Add anyway says how far over it will be", async () => {
    const { user, onConfirm } = mount({
      ...base,
      bulkUnits: [box("d", "Bulk box", 0, null, true), box("s", "Shoebox", 3, 2)],
    });
    await user.click(boxes().getByRole("button", { name: "Shoebox · 3 of 2 cards · 1 over" }));
    expect(screen.getByRole("alert").textContent).toBe(
      "Shoebox is full (3 of 2 cards). Pick another box. Or add it anyway: it will be 2 over.",
    );
    await user.click(addAnyway(2));
    expect(onConfirm).toHaveBeenCalledWith({ kind: "bulk", unitId: "s", overFull: true });
  });

  it("back to a box with room: the plain Confirm, and no overFull", async () => {
    const { user, onConfirm } = mount({
      ...base,
      bulkUnits: [box("d", "Bulk box", 54, null, true), box("s", "Shoebox", 60, 60)],
    });
    await user.click(boxes().getByRole("button", { name: /Shoebox/ }));
    await user.click(boxes().getByRole("button", { name: /Bulk box/ }));
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(confirm());
    expect(onConfirm).toHaveBeenCalledWith({ kind: "bulk", unitId: "d" });
  });

  it("every box full: bulk is not off; her default is picked, with the warning and Add anyway", async () => {
    const { user, onConfirm } = mount({
      ...base,
      bulkUnits: [box("d", "Bulk box", 1, 1, true), box("s", "Shoebox", 2, 2)],
    });
    expect(
      boxes()
        .getByRole("button", { name: /Bulk box/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe(
      "Bulk box is full (1 of 1 cards). Pick another box. Or add it anyway: it will be 1 over.",
    );
    // Each box offers it: the other full box too.
    await user.click(boxes().getByRole("button", { name: /Shoebox/ }));
    await user.click(addAnyway(1));
    expect(onConfirm).toHaveBeenCalledWith({ kind: "bulk", unitId: "s", overFull: true });
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
    // 0037: bulk is not off either; it is the knowing Add anyway.
    expect(addAnyway(1).disabled).toBe(false);
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

  it("a Move opened on a FULL box that is not the card's own: the warning and Add anyway, or a box with room", async () => {
    const { user, onConfirm } = mount(
      { ...base, bulkUnits: [box("d", "Bulk box", 5, null, true), box("s", "Shoebox", 2, 2)] },
      { kind: "bulk", unitId: "s" },
    );
    // 0037: the old reason stays the warning's first sentence; Confirm is the knowing Add anyway.
    expect(screen.getByRole("alert").textContent).toBe(
      "Shoebox is full (2 of 2 cards). Pick another box. Or add it anyway: it will be 1 over.",
    );
    expect(addAnyway(1).disabled).toBe(false);
    await user.click(boxes().getByRole("button", { name: /Bulk box/ }));
    expect(confirm().disabled).toBe(false);
    await user.click(confirm());
    expect(onConfirm).toHaveBeenCalledWith({ kind: "bulk", unitId: "d" });
  });

  it("0037 · the card's own box (homeBoxId) is shown without the card: not full for it, no Add anyway", async () => {
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
