// @vitest-environment jsdom
/**
 * UIL-121 (UX) — the spare-card grid: one tile per printing with how many she has (×N), a search box on a long list,
 * and one copy for one pocket. Two pockets can take two copies of the same printing; a printing whose every copy is
 * in another pocket of this popup says so and cannot be picked. The real popup and grid; only the actions are stood
 * in for.
 */
import { createElement, useState } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chosenFillerCopyIds,
  type FillerCardOption,
  type LineChoice,
  type LinePopupModel,
} from "@/lib/line/popup";
import type { LineStagesModel } from "@/lib/line/stages-load";
import { LineStagesPopup } from "@/app/(ui)/line/LineStagesPopup";
import { LinePopup } from "@/app/(ui)/_components/LinePopup";

const bulkFillerAction = vi.fn();
vi.mock("@/app/(ui)/_components/line-popup-actions", () => ({
  lineModelAction: vi.fn(),
  stageOptionsAction: vi.fn(async () => ({ ok: true, options: [] })),
  bulkFillerAction: (...a: unknown[]) => bulkFillerAction(...a),
}));

const card = (tcgdexId: string, name: string, localId: string) => ({
  tcgdexId,
  name,
  setId: "sv01",
  setName: "Scarlet & Violet",
  localId,
  setCardCountOfficial: 198,
  imageUrl: null,
  bandKey: "green",
});
const spare = (name: string, localId: string, copyIds: string[]): FillerCardOption => ({
  copyId: copyIds[0],
  copyIds,
  count: copyIds.length,
  where: "Bulk box",
  card: card(`sv01-${localId}`, name, localId),
});
const MODEL: LineStagesModel = {
  line: {
    lineId: "L1",
    name: "Sprigatito",
    binderName: "KB-001",
    bandKey: "green",
    bandDisplay: "Green",
    locale: "en",
    total: 3,
  },
  stages: [
    { stageIndex: 0, stage: "Basic", state: "here", card: card("sv01-013", "Sprigatito", "013") },
    { stageIndex: 1, stage: "Stage1", state: "wanted", card: null, choice: null, dexId: 907 },
    { stageIndex: 2, stage: "Stage2", state: "wanted", card: null, choice: null, dexId: 908 },
  ],
  current: {},
  thirdPocket: null,
};

beforeEach(() => bulkFillerAction.mockReset());
afterEach(cleanup);

async function mount(bulk: FillerCardOption[]) {
  bulkFillerAction.mockResolvedValue({ ok: true, options: bulk });
  const onConfirm = vi.fn();
  const user = userEvent.setup();
  render(
    createElement(LineStagesPopup, {
      lineId: "L1",
      loadModel: async () => MODEL,
      onConfirm,
      onClose: vi.fn(),
    }),
  );
  await screen.findByRole("region", { name: /Stage 1/ });
  return { user, onConfirm };
}
/** Open a stage's bulk grid. */
async function grid(user: ReturnType<typeof userEvent.setup>, stage: RegExp) {
  const region = screen.getByRole("region", { name: stage });
  await user.click(within(region).getByRole("button", { name: "Fill the pocket" }));
  await user.click(within(region).getByRole("button", { name: /A card from your bulk box/ }));
  return within(region).findByRole("group", { name: "Cards in your bulk box" });
}

describe("UIL-121 · the spare-card grid", () => {
  it("one tile per printing with ×N; a second pocket takes the NEXT copy of the same printing", async () => {
    const { user, onConfirm } = await mount([
      spare("Pawmi", "074", ["p1"]),
      spare("Sprigatito", "013", ["s1", "s2"]),
    ]);
    const g1 = await grid(user, /Stage 1/);
    expect(within(g1).getAllByRole("button")).toHaveLength(2);
    await user.click(within(g1).getByRole("button", { name: /Sprigatito.*×2/ }));
    const g2 = await grid(user, /Stage 2/);
    // Stage 1 holds one of the two: one is left.
    await user.click(within(g2).getByRole("button", { name: /Sprigatito.*×1/ }));
    await user.click(screen.getByRole("button", { name: /Save/ }));
    expect(onConfirm).toHaveBeenCalledWith({
      lineId: "L1",
      stages: {
        1: { kind: "filler", filler: { material: "card", copyId: "s1" } },
        2: { kind: "filler", filler: { material: "card", copyId: "s2" } },
      },
    });
  });

  it("a printing whose only copy is in another pocket says so and cannot be picked", async () => {
    const { user } = await mount([spare("Pawmi", "074", ["p1"])]);
    await user.click(within(await grid(user, /Stage 1/)).getByRole("button", { name: /Pawmi/ }));
    const g2 = await grid(user, /Stage 2/);
    const pawmi = within(g2).getByRole("button", { name: /Pawmi.*In another pocket/ });
    expect((pawmi as HTMLButtonElement).disabled).toBe(true);
  });

  it("a long list gets a search box, and it narrows the grid", async () => {
    const many = Array.from({ length: 13 }, (_, i) =>
      spare(i === 7 ? "Fuecoco" : `Spare${i}`, String(100 + i), [`x${i}`]),
    );
    const { user } = await mount(many);
    const g = await grid(user, /Stage 1/);
    expect(within(g).getAllByRole("button")).toHaveLength(13);
    await user.type(screen.getByRole("searchbox", { name: "Find a spare card" }), "fuec");
    await waitFor(() => expect(within(g).getAllByRole("button")).toHaveLength(1));
    expect(within(g).getByRole("button", { name: /Fuecoco/ })).toBeTruthy();
  });
});

describe("UIL-121 · the line popup's START: one copy, one pocket there too", () => {
  const START: LinePopupModel = {
    mode: "start",
    copyId: "moving",
    card: { ...card("sv01-081", "Floragato", "081"), locale: "en" },
    line: {
      lineId: null,
      binderId: "b1",
      binderName: "KB-001",
      bandKey: "green",
      bandDisplay: "Green",
      locale: "en",
      filledBefore: 0,
      filledAfter: 1,
      total: 3,
    },
    stages: [
      { stageIndex: 0, stage: "Basic", state: "wanted", card: null, dexId: 906 },
      {
        stageIndex: 1,
        stage: "Stage1",
        state: "incoming",
        card: card("sv01-081", "Floragato", "081"),
      },
      { stageIndex: 2, stage: "Stage2", state: "wanted", card: null, dexId: 908 },
    ],
    existingLines: [],
  };
  function Harness({ onConfirm }: { onConfirm: (c: LineChoice) => void }) {
    const [value, setValue] = useState<LineChoice>({
      mode: "start",
      binderId: "b1",
      band: "green",
      pulls: [],
      stages: {},
    });
    return createElement(LinePopup, {
      model: START,
      value,
      onChange: setValue,
      onConfirm,
      onCancel: () => {},
    });
  }

  it("the Basic takes one Sprigatito, the Stage 2 the next", async () => {
    bulkFillerAction.mockResolvedValue({
      ok: true,
      options: [spare("Sprigatito", "013", ["s1", "s2"])],
    });
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(createElement(Harness, { onConfirm }));
    await user.click(within(await grid(user, /Basic/)).getByRole("button", { name: /×2/ }));
    await user.click(within(await grid(user, /Stage 2/)).getByRole("button", { name: /×1/ }));
    await user.click(screen.getByRole("button", { name: /Start line/ }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect((onConfirm.mock.calls[0][0] as { stages: unknown }).stages).toEqual({
      0: { kind: "filler", filler: { material: "card", copyId: "s1" } },
      2: { kind: "filler", filler: { material: "card", copyId: "s2" } },
    });
  });
});

describe("chosenFillerCopyIds · the spare cards a popup's choices hold", () => {
  it("each stage's filler card and the third pocket's; an energy, an empty or a chase holds none", () => {
    expect(
      chosenFillerCopyIds(
        {
          0: { kind: "filler", filler: { material: "card", copyId: "a" } },
          1: { kind: "filler", filler: { material: "energy" } },
          2: { kind: "empty" },
          3: { kind: "chase", catalogCardId: "sv01-013" },
        },
        { material: "card", copyId: "t" },
      ),
    ).toEqual(["a", "t"]);
    expect(chosenFillerCopyIds(undefined, { material: "energy" })).toEqual([]);
  });
});
