// @vitest-environment jsdom
/**
 * UIL-130 — a spare card coming out of its pocket goes back to its home box, or to a box she picks when that one is
 * full (the Senior BA's condition: asked, never silently). The real Choose popup and line popup in a DOM; only the
 * server actions are stood in for.
 */
import { createElement, useState } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LineChoice, LinePopupModel } from "@/lib/line/popup";
import type { LineStagesModel } from "@/lib/line/stages-load";
import { LineStagesPopup } from "@/app/(ui)/line/LineStagesPopup";
import { LinePopup } from "@/app/(ui)/_components/LinePopup";

vi.mock("@/app/(ui)/_components/line-popup-actions", () => ({
  lineModelAction: vi.fn(),
  stageOptionsAction: vi.fn(async () => ({ ok: true, options: [] })),
  bulkFillerAction: vi.fn(async () => ({ ok: true, options: [] })),
}));

const card = (tcgdexId: string, name: string, localId: string) => ({
  tcgdexId,
  name,
  setId: "sv03",
  setName: "Obsidian Flames",
  localId,
  setCardCountOfficial: 197,
  imageUrl: null,
  bandKey: "red",
});
const BOXES = [
  { id: "d", name: "Bulk box", capacity: null, held: 40, isDefault: true },
  { id: "b", name: "Box B", capacity: 1, held: 1, isDefault: false },
  { id: "c", name: "Box C", capacity: null, held: 0, isDefault: false },
];
afterEach(cleanup);

describe("Choose: a spare card she takes out goes back to a box", () => {
  const model = (homeBoxId: string): LineStagesModel => ({
    line: {
      lineId: "L1",
      name: "Charmander",
      binderName: "KB-001",
      bandKey: "red",
      bandDisplay: "Red",
      locale: "en",
      total: 3,
    },
    stages: [
      { stageIndex: 0, stage: "Basic", state: "here", card: card("sv03-026", "Charmander", "026") },
      { stageIndex: 1, stage: "Stage1", state: "blocked", card: null, choice: "filler", dexId: 5 },
      { stageIndex: 2, stage: "Stage2", state: "wanted", card: null, choice: null, dexId: 6 },
    ],
    current: { 1: { kind: "filler", filler: { material: "card", copyId: "spare" } } },
    thirdPocket: null,
    spares: { spare: { name: "Charmander", homeBoxId } },
    boxes: BOXES,
  });
  async function mount(homeBoxId: string) {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      createElement(LineStagesPopup, {
        lineId: "L1",
        loadModel: async () => model(homeBoxId),
        onConfirm,
        onClose: vi.fn(),
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Choose for this line" });
    const stage1 = await within(dialog).findByRole("region", { name: /Stage 1/ });
    await user.click(within(stage1).getByRole("button", { name: "Leave empty" }));
    return { user, onConfirm, dialog };
  }
  const save = (d: HTMLElement) =>
    within(d).getByRole("button", { name: /Save/ }) as HTMLButtonElement;

  it("home with room: it says where it goes, and Save sends no pick", async () => {
    const { user, onConfirm, dialog } = await mount("c");
    expect(within(dialog).getByText(/Charmander → Box C/)).toBeTruthy();
    await user.click(save(dialog));
    expect(onConfirm).toHaveBeenCalledWith({ lineId: "L1", stages: { 1: { kind: "empty" } } });
  });

  it("home full: it says so, Save waits for a box, and her pick is sent", async () => {
    const { user, onConfirm, dialog } = await mount("b");
    const ask = within(dialog).getByRole("group", { name: "Where Charmander goes" });
    expect(ask.textContent).toMatch(/Box B is full \(1 of 1 card · full\)/);
    expect(save(dialog).disabled).toBe(true);
    // A full box is not offered.
    expect(within(ask).queryByRole("button", { name: /Box B/ })).toBeNull();
    await user.click(within(ask).getByRole("button", { name: /Box C/ }));
    expect(save(dialog).disabled).toBe(false);
    await user.click(save(dialog));
    expect(onConfirm).toHaveBeenCalledWith({
      lineId: "L1",
      stages: { 1: { kind: "empty" } },
      returnBoxes: { spare: "c" },
    });
  });
});

describe("an Add into the stage a spare card fills: it goes back to a box", () => {
  const MODEL: LinePopupModel = {
    mode: "add",
    copyId: "moving",
    card: { ...card("sv03-027", "Charmeleon", "027"), locale: "en" },
    line: {
      lineId: "L1",
      binderId: "b1",
      binderName: "KB-001",
      bandKey: "red",
      bandDisplay: "Red",
      locale: "en",
      filledBefore: 1,
      filledAfter: 2,
      total: 2,
      status: "open",
    },
    stages: [
      { stageIndex: 0, stage: "Basic", state: "here", card: card("sv03-026", "Charmander", "026") },
      {
        stageIndex: 1,
        stage: "Stage1",
        state: "incoming",
        card: card("sv03-027", "Charmeleon", "027"),
      },
    ],
    existingLines: [],
    returning: [{ copyId: "spare", name: "Charmander", homeBoxId: "b" }],
    boxes: BOXES,
  };
  function Harness({ onConfirm }: { onConfirm: (c: LineChoice) => void }) {
    const [value, setValue] = useState<LineChoice>({ mode: "join", lineId: "L1", slotId: "S1" });
    return createElement(LinePopup, {
      model: MODEL,
      value,
      onChange: setValue,
      onConfirm,
      onCancel: () => {},
    });
  }

  it("home full: Confirm waits for a box, and her pick rides with the Add", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(createElement(Harness, { onConfirm }));
    const confirm = () =>
      within(document.querySelector(".lp-foot") as HTMLElement)
        .getAllByRole("button")
        .at(-1)! as HTMLButtonElement;
    expect(confirm().disabled).toBe(true);
    const ask = screen.getByRole("group", { name: "Where Charmander goes" });
    await user.click(within(ask).getByRole("button", { name: /Box C/ }));
    await waitFor(() => expect(confirm().disabled).toBe(false));
    await user.click(confirm());
    expect(onConfirm.mock.calls[0][0]).toMatchObject({
      mode: "join",
      returnBoxes: { spare: "c" },
    });
  });
});
