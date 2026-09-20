// @vitest-environment jsdom
/**
 * UIL-030 PR B — the offer finally has an action. When the Plan hands the move sheet the open
 * binder-block needs (only for a card the engine offered as a repurposed block), the panel LEADS with
 * "USE AS A BINDER BLOCK": one chip per open need. Picking one makes the destination a block in that
 * line's binder back half; a manual binder or bulk pick clears it again. With no candidates the section
 * does not exist — Lines and Lookup never pass any, so they are unchanged.
 *
 * Driven through the REAL panel in a DOM, same harness as move-panel-picker.dom.test.ts.
 */
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BlockNeedCandidate, MoveOptions } from "@/lib/line/types";
import { MovePanel } from "@/app/(ui)/_components/MovePanel";

const OPTIONS: MoveOptions = {
  binders: [
    { id: "b1", name: "Binder 1", type: "general" },
    { id: "spec", name: "Specialty A", type: "specialty" },
  ],
  collectionsByBinder: { spec: [{ id: "coll", name: "Starters" }] },
  bands: [{ key: "red", display: "Red fire" }],
};
const NEEDS: BlockNeedCandidate[] = [
  {
    lineId: "L1",
    slotId: "S2",
    binderId: "b1",
    binderName: "Binder 1",
    speciesLabel: "CHARMANDER LINE",
    stage: "Stage2",
    bandKey: "red",
  },
  {
    lineId: "L7",
    slotId: "S9",
    binderId: "b1",
    binderName: "Binder 1",
    speciesLabel: "PONYTA LINE",
    stage: "Stage1",
    bandKey: "red",
  },
];

function mount(over: Partial<Parameters<typeof MovePanel>[0]> = {}) {
  const onConfirm = vi.fn();
  const user = userEvent.setup();
  render(
    createElement(MovePanel, { options: OPTIONS, initial: { kind: "bulk" }, onConfirm, ...over }),
  );
  return { onConfirm, user };
}
const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const pressed = (b: HTMLButtonElement) => b.getAttribute("aria-pressed") === "true";
afterEach(cleanup);

describe("UIL-030 · the block section exists only when candidates are passed", () => {
  it("no candidates → no section (Lines and Lookup unchanged)", () => {
    mount();
    expect(screen.queryByText(/USE AS A BINDER BLOCK/)).toBeNull();
    expect(screen.queryByText(/CHARMANDER LINE/)).toBeNull();
  });

  it("with candidates → the section leads, one chip per open need, none pressed, manual controls follow", () => {
    mount({ blockNeeds: NEEDS });
    expect(screen.getByText(/USE AS A BINDER BLOCK · FILLS A RESERVED POCKET/)).toBeTruthy();
    expect(pressed(button(/CHARMANDER LINE · Stage2 · Binder 1/))).toBe(false);
    expect(pressed(button(/PONYTA LINE · Stage1 · Binder 1/))).toBe(false);
    expect(screen.getByText("OR PLACE IT MANUALLY")).toBeTruthy();
    const all = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    expect(all.findIndex((t) => /CHARMANDER LINE/.test(t))).toBeLessThan(
      all.findIndex((t) => /Bulk box/.test(t)),
    );
  });
});

describe("UIL-030 · pick a need → a block destination; a manual pick clears it", () => {
  it("click the chip: pressed, the summary names the block, Confirm hands the host kind block with line, slot, binder", async () => {
    const { user, onConfirm } = mount({ blockNeeds: NEEDS });
    await user.click(button(/CHARMANDER LINE/));
    expect(pressed(button(/CHARMANDER LINE/))).toBe(true);
    expect(screen.getByText(/BINDER BLOCK · CHARMANDER LINE · BINDER 1 BACK/)).toBeTruthy();
    await user.click(button("Place it here ▶"));
    expect(onConfirm).toHaveBeenCalledWith({
      kind: "block",
      lineId: "L1",
      slotId: "S2",
      binderId: "b1",
    });
  });

  it("then picking Bulk box clears the block and confirms bulk; picking a binder clears it too", async () => {
    const { user, onConfirm } = mount({ blockNeeds: NEEDS });
    await user.click(button(/PONYTA LINE/));
    await user.click(button(/Bulk box/));
    expect(pressed(button(/PONYTA LINE/))).toBe(false);
    expect(screen.getByText(/BULK BOX · NOT SHELVED/)).toBeTruthy();
    await user.click(button("Place it here ▶"));
    expect(onConfirm).toHaveBeenLastCalledWith({ kind: "bulk" });
    await user.click(button(/PONYTA LINE/));
    await user.click(button("Specialty A"));
    expect(pressed(button(/PONYTA LINE/))).toBe(false);
  });
});
