// @vitest-environment jsdom
/**
 * UIL-118 — "Delete line" on the Lines screen, through the REAL screen. Karvi: "I need the ability to delete
 * lines… I want to get rid of them, and users should be able to as well."
 *
 * Pinned: a two-tap confirm that says exactly what goes (asked of the server when she taps, not read off the
 * page); the line goes and the next one shows; "Keep it" writes nothing; a line holding cards says so and offers
 * nothing; a refusal (a block) is shown in her words; a delete that cannot reach the server says so.
 * The write itself is tests/db/delete-line.test.ts.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LineScreenData, LineView, SlotView } from "@/lib/line/types";
import { LOST } from "@/app/(ui)/_components/reach";
import { DELETE_LINE } from "@/lib/line/delete";
import { LineScreen } from "@/app/(ui)/line/LineScreen";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/line",
  useSearchParams: () => new URLSearchParams(),
}));

const loadLine = vi.fn();
const checkLineDeletionAction = vi.fn();
const deleteLineAction = vi.fn();
vi.mock("@/app/(ui)/line/actions", () => ({
  loadLine: (...a: unknown[]) => loadLine(...a),
  moveCardAction: vi.fn(),
  removeSlotCopyAction: vi.fn(),
  resolveDecisionAction: vi.fn(),
  checkLineDeletionAction: (...a: unknown[]) => checkLineDeletionAction(...a),
  deleteLineAction: (...a: unknown[]) => deleteLineAction(...a),
}));

const card = (name: string) => ({
  tcgdexId: `sv03-${name}`,
  name,
  setId: "sv03",
  setName: "Obsidian Flames",
  localId: "004",
  setCardCountOfficial: 197,
  imageUrl: null,
  bandKey: "red",
});
const slot = (i: number, name: string, copyId: string | null): SlotView => ({
  slotId: `s-${name}`,
  stageIndex: i,
  stage: i === 0 ? "Basic" : "Stage1",
  state: copyId ? "filled" : "placeholder",
  card: card(name),
  copyId,
  variant: copyId ? "normal" : null,
  priceMarket: null,
  willLiveInSpecialty: false,
  alternates: [],
  note: null,
  wedgeLabel: null,
  moveable: !!copyId,
  copyNotShelved: false,
});
const line = (id: string, label: string, slots: SlotView[]): LineView => ({
  lineId: id,
  rootDexId: 4,
  speciesLabel: label,
  bandKey: "red",
  binderId: "kb1",
  binderLabel: "KB-001 · BACK",
  status: "open",
  counts: {
    filled: slots.filter((s) => s.copyId).length,
    placeholder: slots.filter((s) => !s.copyId).length,
    block: 0,
  },
  slots,
  cap: null,
  info: [],
});
// Her case: a line of placeholders only. And a line that holds a card.
const EMPTY = line("L-empty", "CHARMANDER LINE", [
  slot(0, "Charmander", null),
  slot(1, "Charmeleon", null),
]);
const HELD = line("L-held", "SQUIRTLE LINE", [slot(0, "Squirtle", "c-squirtle")]);
const data = (lines: LineView[]): LineScreenData => ({
  view: "color",
  lines,
  decisions: [],
  moveOptions: { binders: [], collectionsByBinder: {}, bands: [] },
  unlinedCards: [],
});

async function mount(lines: LineView[] = [EMPTY, HELD]) {
  loadLine.mockResolvedValue(data(lines));
  const user = userEvent.setup();
  render(createElement(LineScreen));
  await screen.findByText(lines[0].speciesLabel, { selector: ".sp" });
  return user;
}
const title = () => document.querySelector(".linetitle .sp")?.textContent;

beforeEach(() => {
  for (const f of [loadLine, checkLineDeletionAction, deleteLineAction]) f.mockReset();
  checkLineDeletionAction.mockResolvedValue({
    ok: true,
    deletion: { lineId: "L-empty", emptySlots: 2, openWishes: 1 },
  });
});
afterEach(cleanup);

describe("UIL-118 · Delete line", () => {
  it("says exactly what goes, and deletes on the second tap; the next line shows", async () => {
    deleteLineAction.mockResolvedValue({ ok: true, data: data([HELD]) });
    const user = await mount();
    // PRE-FIX: there is no way to delete a line at all.
    await user.click(screen.getByRole("button", { name: "Delete the CHARMANDER LINE" }));
    expect(checkLineDeletionAction).toHaveBeenCalledWith("L-empty");
    expect(
      await screen.findByText(
        "Delete the CHARMANDER LINE? Its 2 empty slots go, and 1 card comes off your wishlist that it was waiting for. Nothing in your binders moves.",
      ),
    ).toBeTruthy();
    expect(deleteLineAction).not.toHaveBeenCalled(); // the first tap writes nothing

    await user.click(screen.getByRole("button", { name: "Yes, delete line" }));
    await waitFor(() => expect(deleteLineAction).toHaveBeenCalledWith("L-empty", "color"));
    await waitFor(() => expect(title()).toBe("SQUIRTLE LINE"));
    expect(screen.getByText("Deleted · the CHARMANDER LINE")).toBeTruthy();
  });

  it("'Keep it' writes nothing and puts the button back", async () => {
    const user = await mount();
    await user.click(screen.getByRole("button", { name: "Delete the CHARMANDER LINE" }));
    await user.click(await screen.findByRole("button", { name: "Keep it" }));
    expect(deleteLineAction).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Delete the CHARMANDER LINE" })).toBeTruthy();
  });

  it("a line holding cards says so, and offers nothing to confirm", async () => {
    const user = await mount([HELD, EMPTY]);
    const btn = screen.getByRole("button", { name: "Delete line" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText("Move its 1 card out first")).toBeTruthy();
    await user.click(btn);
    expect(checkLineDeletionAction).not.toHaveBeenCalled();
  });

  it("a refusal from the server is shown in her words, with nothing to confirm", async () => {
    checkLineDeletionAction.mockResolvedValue({ ok: false, error: DELETE_LINE.hasBlock });
    const user = await mount();
    await user.click(screen.getByRole("button", { name: "Delete the CHARMANDER LINE" }));
    expect(
      await screen.findByText(
        "This line has a block in your binder. Remove its block first, then delete the line.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Yes, delete line" })).toBeNull();
  });

  it("a delete that cannot reach the server says so, and the line stays", async () => {
    deleteLineAction.mockRejectedValue(new TypeError("Failed to fetch"));
    const user = await mount();
    await user.click(screen.getByRole("button", { name: "Delete the CHARMANDER LINE" }));
    await user.click(await screen.findByRole("button", { name: "Yes, delete line" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(LOST.action));
    expect(title()).toBe("CHARMANDER LINE");
    expect(screen.getByRole("button", { name: "Delete the CHARMANDER LINE" })).toBeTruthy();
  });
});
