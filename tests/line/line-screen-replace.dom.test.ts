// @vitest-environment jsdom
/**
 * UIL-117 PR 3 — "Replace this card" on the Lines page, end to end in a DOM: a filled slot, the copies she owns that
 * could take its place (image first), the line popup opening on Keep, and her Swap reaching the server as ONE move of
 * the new copy into that line's binder and band, with her replace choice. The real screen, the real picker and the
 * real popup; only the server actions are stood in for.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinePopupModel } from "@/lib/line/popup";
import type { LineScreenData, LineView, SlotView } from "@/lib/line/types";
import { LineScreen } from "@/app/(ui)/line/LineScreen";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/line",
  useSearchParams: () => new URLSearchParams(),
}));
const loadLine = vi.fn();
const moveCardAction = vi.fn();
const replaceCandidatesAction = vi.fn();
vi.mock("@/app/(ui)/line/actions", () => ({
  loadLine: (...a: unknown[]) => loadLine(...a),
  moveCardAction: (...a: unknown[]) => moveCardAction(...a),
  replaceCandidatesAction: (...a: unknown[]) => replaceCandidatesAction(...a),
  removeSlotCopyAction: vi.fn(),
  resolveDecisionAction: vi.fn(),
  checkLineDeletionAction: vi.fn(),
  deleteLineAction: vi.fn(),
}));
const lineModelAction = vi.fn();
vi.mock("@/app/(ui)/_components/line-popup-actions", () => ({
  lineModelAction: (...a: unknown[]) => lineModelAction(...a),
}));

const card = (tcgdexId: string, localId: string) => ({
  tcgdexId,
  name: "Toedscruel",
  setId: "sv09",
  setName: "Journey Together",
  localId,
  setCardCountOfficial: 159,
  imageUrl: null,
  bandKey: "orange",
});
const SLOT: SlotView = {
  slotId: "S1",
  stageIndex: 1,
  stage: "Stage1",
  state: "filled",
  card: card("sv09-089", "089"),
  copyId: "old",
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
  status: "complete",
  counts: { filled: 1, placeholder: 0, block: 0 },
  slots: [SLOT],
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
    bands: [{ key: "orange", display: "Orange" }],
  },
  unlinedCards: [],
};
const MODEL: LinePopupModel = {
  mode: "replace",
  copyId: "new",
  card: { ...card("sv09-190", "190"), locale: "en" },
  line: {
    lineId: "L1",
    binderId: "kb1",
    binderName: "KB-001",
    bandKey: "orange",
    bandDisplay: "Orange",
    locale: "en",
    filledBefore: 1,
    filledAfter: 1,
    total: 1,
  },
  stages: [{ stageIndex: 1, stage: "Stage1", state: "incoming", card: card("sv09-190", "190") }],
  existingLines: [],
  replace: {
    slotId: "S1",
    stageIndex: 1,
    current: { copyId: "old", card: card("sv09-089", "089"), where: "KB-001 · Back · Orange" },
    incoming: { copyId: "new", card: card("sv09-190", "190"), where: "KB-001 · Front · Orange" },
    defaultKeep: true,
    suggestedOutgoing: { kind: "bulk" },
  },
};

beforeEach(() => {
  for (const f of [loadLine, moveCardAction, replaceCandidatesAction, lineModelAction])
    f.mockReset();
  loadLine.mockResolvedValue(DATA);
  replaceCandidatesAction.mockResolvedValue({
    ok: true,
    slotCardName: "Toedscruel",
    candidates: [
      { copyId: "new", card: card("sv09-190", "190"), where: "KB-001 · Front · Orange" },
    ],
  });
  lineModelAction.mockResolvedValue({ ok: true, model: MODEL });
  moveCardAction.mockResolvedValue({ ok: true, data: DATA, label: "KB-001 · Back · Orange" });
});
afterEach(cleanup);

async function openReplace() {
  const user = userEvent.setup();
  render(createElement(LineScreen));
  await waitFor(() => expect(screen.queryByText("Loading lines…")).toBeNull());
  await user.click(screen.getByRole("button", { name: /Replace this card/ }));
  await screen.findByRole("dialog", { name: "Replace Toedscruel" });
  return user;
}

describe("UIL-117 PR 3 · Lines: replace the card in a filled slot", () => {
  it("pick a copy → the popup opens on Keep → Swap: ONE move of the new copy into that line, with her choice", async () => {
    const user = await openReplace();
    expect(replaceCandidatesAction).toHaveBeenCalledWith("S1");
    expect(screen.getByText("Now · KB-001 · Front · Orange")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Toedscruel.*190\/159/ }));
    await screen.findByRole("dialog", { name: "A copy for a filled slot" });
    expect(lineModelAction).toHaveBeenCalledWith("new", {
      kind: "replace",
      lineId: "L1",
      slotId: "S1",
      defaultKeep: true,
    });
    expect(screen.getByRole("radio", { name: /Keep 089\/159/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
    await user.click(screen.getByRole("radio", { name: /Swap in 190\/159/ }));
    await user.click(screen.getByRole("button", { name: "Swap them ▶" }));
    await waitFor(() => expect(moveCardAction).toHaveBeenCalledTimes(1));
    expect(moveCardAction).toHaveBeenCalledWith(
      "new",
      { kind: "shelf", binderId: "kb1", half: "back", band: "orange" },
      "color",
      { mode: "replace", lineId: "L1", slotId: "S1", keep: false, outgoing: { kind: "bulk" } },
    );
    expect(
      await screen.findByText(/Swapped · a new Toedscruel in the TOEDSCOOL LINE/),
    ).toBeTruthy();
  });

  it("Keep changes nothing: the popup closes and no move is sent", async () => {
    const user = await openReplace();
    await user.click(screen.getByRole("button", { name: /Toedscruel.*190\/159/ }));
    await screen.findByRole("dialog", { name: "A copy for a filled slot" });
    await user.click(screen.getByRole("button", { name: "Keep ▶" }));
    expect(screen.queryByRole("dialog", { name: "A copy for a filled slot" })).toBeNull();
    expect(moveCardAction).not.toHaveBeenCalled();
  });

  it("Escape closes the replace, from the picker and from its popup, like the Move sheet", async () => {
    const user = await openReplace();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Replace Toedscruel" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Replace this card/ }));
    await user.click(await screen.findByRole("button", { name: /Toedscruel.*190\/159/ }));
    await screen.findByRole("dialog", { name: "A copy for a filled slot" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "A copy for a filled slot" })).toBeNull();
    expect(moveCardAction).not.toHaveBeenCalled();
  });

  it("Escape on the Move sheet opened from the popup closes that sheet only; the replace stays open", async () => {
    const user = await openReplace();
    await user.click(await screen.findByRole("button", { name: /Toedscruel.*190\/159/ }));
    await screen.findByRole("dialog", { name: "A copy for a filled slot" });
    await user.click(screen.getByRole("radio", { name: /Swap in/ }));
    await user.click(screen.getByRole("button", { name: "A front half…" }));
    await screen.findByRole("dialog", { name: "Move Toedscruel" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Move Toedscruel" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "A copy for a filled slot" })).toBeTruthy();
  });

  it("no other copy outside a line: it says so, and offers nothing to pick", async () => {
    replaceCandidatesAction.mockResolvedValue({
      ok: true,
      slotCardName: "Toedscruel",
      candidates: [],
    });
    await openReplace();
    expect(
      await screen.findByText(/You have no other Toedscruel outside a line to swap in/),
    ).toBeTruthy();
    expect(lineModelAction).not.toHaveBeenCalled();
  });

  it("a refusal is shown in its own words", async () => {
    replaceCandidatesAction.mockResolvedValue({
      ok: false,
      error: "That slot is no longer filled — reload the Lines page.",
    });
    await openReplace();
    expect(
      await screen.findByText("That slot is no longer filled — reload the Lines page."),
    ).toBeTruthy();
  });
});
