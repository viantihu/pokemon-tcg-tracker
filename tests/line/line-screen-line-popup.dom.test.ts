// @vitest-environment jsdom
/**
 * UIL-117 PR 2 — the Lines screen, end to end in a DOM: a card on no line, her Move, BACK HALF, the line popup, and
 * her confirm reaching the server as ONE move carrying her choice. The real screen, the real Move sheet and the
 * real popup; only the server actions are stood in for.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinePopupModel } from "@/lib/line/popup";
import type { LineScreenData, UnlinedCard } from "@/lib/line/types";
import { LineScreen } from "@/app/(ui)/line/LineScreen";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/line",
  useSearchParams: () => new URLSearchParams(),
}));

const loadLine = vi.fn();
const moveCardAction = vi.fn();
vi.mock("@/app/(ui)/line/actions", () => ({
  loadLine: (...a: unknown[]) => loadLine(...a),
  moveCardAction: (...a: unknown[]) => moveCardAction(...a),
  removeSlotCopyAction: vi.fn(),
  resolveDecisionAction: vi.fn(),
}));
const lineModelAction = vi.fn();
vi.mock("@/app/(ui)/_components/line-popup-actions", () => ({
  lineModelAction: (...a: unknown[]) => lineModelAction(...a),
}));

const CARD = {
  tcgdexId: "sv09-088",
  name: "Toedscool",
  setId: "sv09",
  setName: "Journey Together",
  localId: "088",
  setCardCountOfficial: 159,
  imageUrl: null,
  bandKey: "orange",
};
const STRANDED: UnlinedCard = {
  copyId: "c9",
  card: CARD,
  currentLabel: "KB-001 · Back · Orange",
  dexId: 9481,
  binderHalf: "back",
  naturalBandKey: "orange",
  joinCandidates: [],
  existingLines: [],
};
const DATA: LineScreenData = {
  view: "color",
  lines: [],
  decisions: [],
  moveOptions: {
    binders: [{ id: "kb1", name: "KB-001", type: "general" }],
    collectionsByBinder: {},
    bands: [{ key: "orange", display: "Orange" }],
  },
  unlinedCards: [STRANDED],
};
const MODEL: LinePopupModel = {
  mode: "start",
  copyId: "c9",
  card: { ...CARD, locale: "en" },
  line: {
    lineId: null,
    binderId: "kb1",
    binderName: "KB-001",
    bandKey: "orange",
    bandDisplay: "Orange",
    locale: "en",
    filledBefore: 0,
    filledAfter: 1,
    total: 1,
  },
  stages: [{ stageIndex: 0, stage: "Basic", state: "incoming", card: CARD }],
  existingLines: [],
};

beforeEach(() => {
  for (const f of [loadLine, moveCardAction, lineModelAction]) f.mockReset();
  loadLine.mockResolvedValue(DATA);
  lineModelAction.mockResolvedValue({ ok: true, model: MODEL });
  moveCardAction.mockResolvedValue({ ok: true, data: DATA, label: "KB-001 · Back · Orange" });
});
afterEach(cleanup);

describe("UIL-117 · Lines: a card on no line gets one through the popup", () => {
  it("Move → BACK HALF → the popup → Start line: one move, with her choice", async () => {
    const user = userEvent.setup();
    render(createElement(LineScreen));
    await waitFor(() => expect(screen.queryByText("Loading lines…")).toBeNull());

    await user.click(screen.getByRole("button", { name: /Move/ }));
    await user.click(await screen.findByRole("button", { name: "BACK HALF" }));
    await screen.findByRole("dialog", { name: "Start a line" });
    expect(lineModelAction).toHaveBeenCalledWith("c9", {
      kind: "start",
      binderId: "kb1",
      band: "orange",
    });

    // UIL-121: a one-card line is complete, so she says what fills the rest of its row.
    await user.click(screen.getByRole("button", { name: /Leave it empty/ }));
    await user.click(screen.getByRole("button", { name: /Start line/ }));
    await waitFor(() => expect(moveCardAction).toHaveBeenCalledTimes(1));
    expect(moveCardAction).toHaveBeenCalledWith(
      "c9",
      { kind: "shelf", binderId: "kb1", half: "back", band: "orange" },
      "color",
      {
        mode: "start",
        binderId: "kb1",
        band: "orange",
        pulls: [],
        stages: {},
        thirdPocket: { material: "empty" },
      },
    );
  });

  it("a refusal loading the line is shown in its own words, and nothing moves", async () => {
    lineModelAction.mockResolvedValue({
      ok: false,
      error: "That card is no longer in the collection.",
    });
    const user = userEvent.setup();
    render(createElement(LineScreen));
    await waitFor(() => expect(screen.queryByText("Loading lines…")).toBeNull());

    await user.click(screen.getByRole("button", { name: /Move/ }));
    await user.click(await screen.findByRole("button", { name: "BACK HALF" }));
    expect(await screen.findByText("That card is no longer in the collection.")).toBeTruthy();
    expect(moveCardAction).not.toHaveBeenCalled();
  });
});
