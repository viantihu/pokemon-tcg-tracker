// @vitest-environment jsdom
/**
 * UIL-121 A2c — Lines' "Choose", end to end in a DOM: an open stage says what she chose for it ("NOT DECIDED" until
 * she does, never an engine's card), "Choose" / "Change" open the popup for that line, only what she changes is
 * sent, and a complete two-card line asks what fills its third pocket. The real screen and popup; only the server
 * actions are stood in for.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LineScreenData, LineView, SlotView } from "@/lib/line/types";
import type { LineStagesModel } from "@/lib/line/stages-load";
import { LineScreen } from "@/app/(ui)/line/LineScreen";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/line",
  useSearchParams: () => new URLSearchParams(),
}));
const loadLine = vi.fn();
const lineStagesAction = vi.fn();
const decideStagesAction = vi.fn();
vi.mock("@/app/(ui)/line/actions", () => ({
  loadLine: (...a: unknown[]) => loadLine(...a),
  lineStagesAction: (...a: unknown[]) => lineStagesAction(...a),
  decideStagesAction: (...a: unknown[]) => decideStagesAction(...a),
  moveCardAction: vi.fn(),
  replaceCandidatesAction: vi.fn(),
  removeSlotCopyAction: vi.fn(),
  resolveDecisionAction: vi.fn(),
  checkLineDeletionAction: vi.fn(),
  deleteLineAction: vi.fn(),
}));
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
const base: Omit<SlotView, "slotId" | "stageIndex" | "stage" | "state"> = {
  card: null,
  copyId: null,
  variant: null,
  priceMarket: null,
  willLiveInSpecialty: false,
  alternates: [],
  note: null,
  wedgeLabel: null,
  moveable: false,
  copyNotShelved: false,
};
const LINE: LineView = {
  lineId: "L1",
  rootDexId: 4,
  speciesLabel: "CHARMANDER LINE",
  bandKey: "red",
  binderId: "kb1",
  binderLabel: "KB-001 · BACK",
  status: "open",
  counts: { filled: 1, placeholder: 2, block: 0 },
  slots: [
    {
      ...base,
      slotId: "S0",
      stageIndex: 0,
      stage: "Basic",
      state: "filled",
      card: card("sv03-026", "Charmander", "026"),
      copyId: "c0",
      moveable: true,
    },
    {
      ...base,
      slotId: "S1",
      stageIndex: 1,
      stage: "Stage1",
      state: "placeholder",
      stageChoice: "chase",
      card: card("sv03-027", "Charmeleon", "027"),
    },
    {
      ...base,
      slotId: "S2",
      stageIndex: 2,
      stage: "Stage2",
      state: "placeholder",
      stageChoice: null,
    },
  ],
  cap: null,
  info: [],
};
const DATA: LineScreenData = {
  view: "color",
  lines: [LINE],
  decisions: [],
  moveOptions: {
    binders: [{ id: "kb1", name: "KB-001", type: "general" }],
    collectionsByBinder: {},
    bands: [{ key: "red", display: "Red" }],
  },
  unlinedCards: [],
};
const MODEL: LineStagesModel = {
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
    {
      stageIndex: 1,
      stage: "Stage1",
      state: "wanted",
      card: card("sv03-027", "Charmeleon", "027"),
      choice: "chase",
      dexId: 5,
      suggestion: { card: card("sv03-027", "Charmeleon", "027"), special: false },
    },
    {
      stageIndex: 2,
      stage: "Stage2",
      state: "wanted",
      card: null,
      choice: null,
      dexId: 6,
      suggestion: { card: card("sv03-125", "Charizard", "125"), special: false },
    },
  ],
  current: { 1: { kind: "chase", catalogCardId: "sv03-027" } },
  thirdPocket: null,
};

beforeEach(() => {
  for (const f of [loadLine, lineStagesAction, decideStagesAction]) f.mockReset();
  loadLine.mockResolvedValue(DATA);
  lineStagesAction.mockResolvedValue({ ok: true, model: MODEL });
  decideStagesAction.mockResolvedValue({ ok: true, data: DATA });
});
afterEach(cleanup);

async function mount() {
  const user = userEvent.setup();
  render(createElement(LineScreen, {}));
  await waitFor(() => expect(screen.queryByText("Loading lines…")).toBeNull());
  return user;
}

describe("UIL-121 · Lines says what she chose for each open stage", () => {
  it("a chased stage says CHASING with its card; an undecided one says NOT DECIDED with no card", async () => {
    await mount();
    expect(screen.getByText("CHASING")).toBeTruthy();
    expect(screen.getByText("NOT DECIDED")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose" })).toBeTruthy();
  });
});

describe("UIL-121 · Choose opens the line's popup; only what she changes is sent", () => {
  it("Save waits for a change; her Stage 2 choice alone is sent, and the screen refreshes", async () => {
    const user = await mount();
    await user.click(screen.getByRole("button", { name: "Choose" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose for this line" });
    expect(lineStagesAction).toHaveBeenCalledWith("L1");
    const save = within(dialog).getByRole("button", { name: /Save/ }) as HTMLButtonElement;
    await waitFor(() => expect(within(dialog).getByText(/Stage 2 · Choose/)).toBeTruthy());
    expect(save.disabled).toBe(true);
    const stage2 = within(dialog).getByRole("region", { name: /Stage 2/ });
    await user.click(within(stage2).getByRole("button", { name: "Leave empty" }));
    expect(save.disabled).toBe(false);
    await user.click(save);
    await waitFor(() => expect(decideStagesAction).toHaveBeenCalledTimes(1));
    expect(decideStagesAction).toHaveBeenCalledWith(
      { lineId: "L1", stages: { 2: { kind: "empty" } } },
      "color",
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Choose for this line" })).toBeNull(),
    );
  });

  it("the strip across the top shows the whole line and follows her choices; the footer says why Save is off", async () => {
    const user = await mount();
    await user.click(screen.getByRole("button", { name: "Choose" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose for this line" });
    const strip = await within(dialog).findByRole("list", { name: "This line's stages" });
    const words = () =>
      within(strip)
        .getAllByRole("listitem")
        .map((li) => li.textContent);
    expect(words()).toEqual(["Basic Charmander", "Stage 1 Chasing", "Stage 2 Not decided"]);
    expect(within(dialog).getByText("Change a choice to save")).toBeTruthy();
    const stage2 = within(dialog).getByRole("region", { name: /Stage 2/ });
    await user.click(within(stage2).getByRole("button", { name: "Leave empty" }));
    expect(words()[2]).toBe("Stage 2 Left empty");
    expect(within(dialog).getByText("nothing is written until you save")).toBeTruthy();
  });

  it("she can take back a chase: 'Decide later' on the chased stage is sent as that", async () => {
    const user = await mount();
    await user.click(screen.getByRole("button", { name: "Change" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose for this line" });
    const stage1 = await within(dialog).findByRole("region", { name: /Stage 1/ });
    await user.click(within(stage1).getByRole("button", { name: "Decide later" }));
    await user.click(within(dialog).getByRole("button", { name: /Save/ }));
    await waitFor(() =>
      expect(decideStagesAction).toHaveBeenCalledWith(
        { lineId: "L1", stages: { 1: { kind: "later" } } },
        "color",
      ),
    );
  });
});

describe("UIL-121 · a complete two-card line asks what fills its third pocket", () => {
  it("the banner opens the popup on the pocket, and her answer is sent", async () => {
    const complete: LineView = {
      ...LINE,
      status: "closed",
      thirdPocketOpen: true,
      slots: [
        LINE.slots[0],
        { ...LINE.slots[1], state: "filled", stageChoice: null, copyId: "c1" },
      ],
    };
    loadLine.mockResolvedValue({ ...DATA, lines: [complete] });
    lineStagesAction.mockResolvedValue({
      ok: true,
      model: {
        ...MODEL,
        line: { ...MODEL.line, total: 2 },
        stages: [MODEL.stages[0], { ...MODEL.stages[1], state: "here" }],
        current: {},
        thirdPocket: { current: null },
      },
    });
    const user = await mount();
    await user.click(screen.getByRole("button", { name: "Choose what fills it" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose for this line" });
    await user.click(await within(dialog).findByRole("button", { name: /A basic energy/ }));
    await user.click(within(dialog).getByRole("button", { name: /Save/ }));
    await waitFor(() =>
      expect(decideStagesAction).toHaveBeenCalledWith(
        { lineId: "L1", stages: {}, thirdPocket: { material: "energy" } },
        "color",
      ),
    );
  });
});
