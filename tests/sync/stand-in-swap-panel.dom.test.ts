// @vitest-environment jsdom
/**
 * UIL-060 Half 2, the screen half — driven through the REAL SyncScreen in a DOM.
 *
 * A stand-in swapped on load is named, and stays named until she says OK (a later load finds nothing to swap, so it
 * must not wipe the notice). An unsure stand-in shows the real cards it might be; "Swap for this card" swaps THAT
 * pair. A swap the database refused shows why and offers no button.
 */
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncScreen } from "@/app/(ui)/sync/SyncScreen";
import type { SyncState } from "@/app/(ui)/sync/sync-types";
import * as actions from "@/app/(ui)/sync/actions";
import { emptyCountCheck } from "@/lib/sync/count-check";
import type { StandInCardView } from "@/lib/sync";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/app/(ui)/sync/actions", () => ({
  applySync: vi.fn(),
  createStandInAndMatch: vi.fn(),
  dismissEntryAction: vi.fn(),
  forgetSetAliasAction: vi.fn(),
  loadSyncState: vi.fn(),
  manualMatchEntry: vi.fn(),
  previewSync: vi.fn(),
  restoreWithheldAction: vi.fn(),
  retryUnresolvedNow: vi.fn(),
  searchCatalog: vi.fn(async () => []),
  swapStandInAction: vi.fn(),
  undismissEntryAction: vi.fn(),
  undoLastSync: vi.fn(),
}));

const STAND_IN: StandInCardView = {
  id: "user:en:5be24283-2dae-4074-af2c-ba3114778d55",
  name: "Fuecoco ex",
  setName: "30th Celebrations",
  localId: "15/128",
  imageUrl: null,
};
const REAL: StandInCardView = {
  id: "30th-015",
  name: "Fuecoco ex",
  setName: "30th Celebration",
  localId: "015",
  imageUrl: null,
};

function state(standIns: SyncState["standIns"]): SyncState {
  return {
    waiting: { unknownSet: [], unknownCard: [] },
    cardTypes: [],
    dismissed: [],
    counts: { waiting: 0, dismissed: 0 },
    undo: { available: false, createdAt: null, summary: null },
    aliases: [],
    countCheck: emptyCountCheck(),
    standIns,
  };
}

const m = vi.mocked(actions);
const EMPTY = state({ swapped: [], unsure: [] });

beforeEach(() => {
  vi.clearAllMocks();
  m.loadSyncState.mockResolvedValue(EMPTY);
});
afterEach(cleanup);

describe("UIL-060 Half 2 · the Sync screen shows stand-in swaps", () => {
  it("shows nothing when there is nothing to say", () => {
    render(createElement(SyncScreen, { initialState: EMPTY }));
    expect(screen.queryByText(/stand-in/i)).toBeNull();
  });

  it("names a swap made on load, keeps it across a reload, and lets her dismiss it", async () => {
    m.swapStandInAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    const other = { ...STAND_IN, id: "user:en:11111111-1111-4111-8111-111111111111" };
    render(
      createElement(SyncScreen, {
        initialState: state({
          swapped: [{ standIn: STAND_IN, real: REAL }],
          unsure: [{ standIn: other, candidates: [REAL] }],
        }),
      }),
    );
    const notice = screen.getByText(/swapped for the real card/).closest("section");
    expect(notice?.textContent).toContain("Fuecoco ex · 30th Celebration · #015");

    // Any action reloads the state; that load swaps nothing, and the notice stays.
    await user.click(screen.getByRole("button", { name: "Swap for this card" }));
    expect(await screen.findByText("Swapped your stand-in for the real card.")).toBeTruthy();
    expect(screen.getByText(/swapped for the real card\./)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.queryByText(/swapped for the real card/)).toBeNull();
  });

  it("offers the candidates for an unsure stand-in and swaps the pair she picks", async () => {
    m.swapStandInAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(
      createElement(SyncScreen, {
        initialState: state({ swapped: [], unsure: [{ standIn: STAND_IN, candidates: [REAL] }] }),
      }),
    );
    expect(screen.getByText(/may now be in the catalog/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Swap for this card" }));
    expect(m.swapStandInAction).toHaveBeenCalledWith(STAND_IN.id, REAL.id);
    expect(await screen.findByText("Swapped your stand-in for the real card.")).toBeTruthy();
    expect(m.loadSyncState).toHaveBeenCalled();
  });

  it("says why a swap was refused, and offers no button for it", () => {
    render(
      createElement(SyncScreen, {
        initialState: state({
          swapped: [],
          unsure: [
            { standIn: STAND_IN, candidates: [REAL], blocked: "You already have the real card." },
          ],
        }),
      }),
    );
    expect(screen.getByText("You already have the real card.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Swap for this card" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
