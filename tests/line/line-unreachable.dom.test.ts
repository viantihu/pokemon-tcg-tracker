// @vitest-environment jsdom
/**
 * UIL-106 (2) — the Lines screen when an action cannot reach the server at all.
 *
 * A server action THROWS when the app was redeployed under an open page or the connection dropped. A
 * decision, a slot's Remove and a Move each set `busy` and awaited the action with nothing to catch a throw,
 * so `busy` never cleared and nothing said why. Two more, found on the way: a first load that failed left the
 * screen on "Loading lines…" for ever (its message was only drawn once lines existed), and a failure while a
 * sheet was open was drawn BEHIND the sheet, where she cannot read it. Driven through the REAL screen in a
 * DOM, each action scripted to reject.
 *
 * The Move sheet and the decision card are stood in for, so a click reaches the handler under test directly.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DecisionCard,
  LineScreenData,
  LineView,
  MoveDestination,
  SlotView,
  UnlinedCard,
} from "@/lib/line/types";
import { LOST } from "@/app/(ui)/_components/reach";
import { LineScreen, LOAD_FAILED } from "@/app/(ui)/line/LineScreen";

const DEST: MoveDestination = { kind: "shelf", binderId: "kb1", half: "back", band: "orange" };

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/line",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/(ui)/_components/MoveOverlay", async () => {
  const { createElement: h } = await import("react");
  return {
    MoveOverlay: ({ onConfirm }: { onConfirm: (d: MoveDestination) => void }) =>
      h("div", { role: "dialog", "aria-label": "Move" }, [
        h("button", { key: "c", type: "button", onClick: () => onConfirm(DEST) }, "Place it"),
      ]),
  };
});
vi.mock("@/app/(ui)/_components/DecisionCard", async () => {
  const { createElement: h } = await import("react");
  return {
    DecisionCard: ({ onChoose }: { onChoose: (id: string) => void }) =>
      h("div", { role: "dialog", "aria-label": "Decision" }, [
        h("button", { key: "c", type: "button", onClick: () => onChoose("confirm-cap") }, "Choose"),
      ]),
  };
});

const loadLine = vi.fn();
const moveCardAction = vi.fn();
const removeSlotCopyAction = vi.fn();
const resolveDecisionAction = vi.fn();
vi.mock("@/app/(ui)/line/actions", () => ({
  loadLine: (...a: unknown[]) => loadLine(...a),
  moveCardAction: (...a: unknown[]) => moveCardAction(...a),
  removeSlotCopyAction: (...a: unknown[]) => removeSlotCopyAction(...a),
  resolveDecisionAction: (...a: unknown[]) => resolveDecisionAction(...a),
}));

const LOST_CALL = () => new TypeError("Failed to fetch");

const CARD = {
  tcgdexId: "toedscruel",
  name: "Toedscruel",
  setId: "sv09",
  setName: "Journey Together",
  localId: "089",
  setCardCountOfficial: 159,
  imageUrl: null,
  bandKey: "orange",
};
const SLOT: SlotView = {
  slotId: "s1",
  stageIndex: 1,
  stage: "Stage1",
  state: "filled",
  card: CARD,
  copyId: "c1",
  variant: "normal",
  priceMarket: null,
  willLiveInSpecialty: false,
  alternates: [],
  note: null,
  wedgeLabel: null,
  moveable: true,
  copyNotShelved: false,
};
const LINE: LineView = {
  lineId: "L1",
  rootDexId: 9481,
  speciesLabel: "TOEDSCOOL LINE",
  bandKey: "orange",
  binderId: "kb1",
  binderLabel: "KB-001 · BACK",
  status: "open",
  counts: { filled: 1, placeholder: 0, block: 0 },
  slots: [SLOT],
  cap: null,
  info: [],
};
const DECISION: DecisionCard = {
  id: "L1:ex-only-cap:1",
  kind: "ex-only-cap",
  lineId: "L1",
  slotStageIndex: 1,
  title: "LINE CAP",
  question: "Cap this line?",
  card: null,
  catalog: [],
  owned: [],
  why: [],
  proposal: "Cap it.",
  wishlist: [],
  choices: [{ id: "confirm-cap", label: "Cap it", description: "" }],
};
const UNLINED: UnlinedCard = {
  copyId: "c9",
  card: { ...CARD, tcgdexId: "toedscool", name: "Toedscool" },
  currentLabel: "KB-001 · Front · Orange",
  dexId: 9481,
  binderHalf: "front",
  naturalBandKey: "orange",
  joinCandidates: [],
  existingLines: [],
};
const DATA: LineScreenData = {
  view: "color",
  lines: [LINE],
  decisions: [DECISION],
  moveOptions: { binders: [], collectionsByBinder: {}, bands: [] },
  unlinedCards: [],
};

async function mount(data: LineScreenData = DATA) {
  loadLine.mockResolvedValue(data);
  const user = userEvent.setup();
  render(createElement(LineScreen));
  await waitFor(() => expect(screen.queryByText("Loading lines…")).toBeNull());
  return user;
}

const alerts = () =>
  screen
    .queryAllByRole("alert")
    .map((a) => a.textContent)
    .join(" | ");

beforeEach(() => {
  for (const f of [loadLine, moveCardAction, removeSlotCopyAction, resolveDecisionAction])
    f.mockReset();
});
afterEach(cleanup);

describe("UIL-106 · a Lines action that cannot reach the server ends in a message", () => {
  it("the first load: says it could not load, instead of 'Loading lines…' for ever", async () => {
    loadLine.mockRejectedValue(LOST_CALL());
    render(createElement(LineScreen));
    // PRE-FIX: the message was set but only drawn once lines existed, so the screen said "Loading" for ever.
    await waitFor(() => expect(alerts()).toContain(LOAD_FAILED));
    expect(screen.queryByText("Loading lines…")).toBeNull();
  });

  it("a decision: the sheet closes, it says so, and the decisions can be worked again", async () => {
    resolveDecisionAction.mockRejectedValue(LOST_CALL());
    const user = await mount();

    await user.click(screen.getByRole("button", { name: /Work the decisions/ }));
    await user.click(screen.getByRole("button", { name: "Choose" }));

    await waitFor(() => expect(alerts()).toContain(LOST.action));
    // Not drawn behind the sheet: the sheet is gone, so the message is the thing on screen.
    expect(screen.queryByRole("dialog", { name: "Decision" })).toBeNull();
    expect(screen.getByRole("button", { name: /Work the decisions/ })).toBeTruthy();
  });

  it("a slot's Remove: says so, and the button is not left armed", async () => {
    removeSlotCopyAction.mockRejectedValue(LOST_CALL());
    const user = await mount();

    await user.click(screen.getByRole("button", { name: /Remove Toedscruel/ }));
    await user.click(screen.getByRole("button", { name: /Yes, remove/ }));

    await waitFor(() => expect(alerts()).toContain(LOST.action));
    expect(screen.getByRole("button", { name: /Remove Toedscruel/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Yes, remove/ })).toBeNull();
  });

  it("a Move: the sheet closes and it says so", async () => {
    moveCardAction.mockRejectedValue(LOST_CALL());
    const user = await mount();

    await user.click(screen.getAllByRole("button", { name: /Move/ })[0]);
    await user.click(await screen.findByRole("button", { name: "Place it" }));

    await waitFor(() => expect(alerts()).toContain(LOST.action));
    expect(screen.queryByRole("dialog", { name: "Move" })).toBeNull();
  });

  it("a Move from the 'no lines yet' screen says so too — that screen drew no message at all", async () => {
    moveCardAction.mockRejectedValue(LOST_CALL());
    const user = await mount({ ...DATA, lines: [], decisions: [], unlinedCards: [UNLINED] });

    await user.click(screen.getByRole("button", { name: /Move/ }));
    await user.click(await screen.findByRole("button", { name: "Place it" }));

    await waitFor(() => expect(alerts()).toContain(LOST.action));
    expect(screen.getByText("No lines yet")).toBeTruthy();
  });

  it("an answer the server gives is still shown in its own words", async () => {
    moveCardAction.mockResolvedValue({ ok: false, error: "That pocket is taken." });
    const user = await mount();
    await user.click(screen.getAllByRole("button", { name: /Move/ })[0]);
    await user.click(await screen.findByRole("button", { name: "Place it" }));
    await waitFor(() => expect(alerts()).toContain("That pocket is taken."));
    expect(alerts()).not.toContain(LOST.action);
  });
});
