// @vitest-environment jsdom
/**
 * UIL-060 Half 2, the screen half — driven through the REAL SyncScreen in a DOM.
 *
 * A stand-in swapped on load is named until she says OK. An unsure stand-in says what it touches (copies and where),
 * and offers four ways out: a suggestion (confirmed first), a catalog search, a fix, or keeping it as a stand-in.
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
  restoreRemovedAction: vi.fn(),
  retryUnresolvedNow: vi.fn(),
  searchCatalog: vi.fn(async () => []),
  swapStandInAction: vi.fn(),
  fixStandInAction: vi.fn(),
  keepStandInAction: vi.fn(),
  reviewStandInAgainAction: vi.fn(),
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
    removed: [],
  };
}

const m = vi.mocked(actions);
const EMPTY = state({ swapped: [], unsure: [], kept: [] });
const HELD = { count: 2, where: [{ label: "KB-001 · Front · Red", count: 2 }] };
const NONE_HELD = { count: 0, where: [] };

beforeEach(() => {
  vi.clearAllMocks();
  m.loadSyncState.mockResolvedValue(EMPTY);
});
afterEach(cleanup);

describe("UIL-060 Half 2 · the Sync screen settles stand-ins", () => {
  it("shows nothing when there is nothing to say", () => {
    render(createElement(SyncScreen, { initialState: EMPTY }));
    expect(screen.queryByText(/stand-in/i)).toBeNull();
  });

  it("names a swap made on load and lets her dismiss it", async () => {
    const user = userEvent.setup();
    render(
      createElement(SyncScreen, {
        initialState: state({ swapped: [{ standIn: STAND_IN, real: REAL }], unsure: [], kept: [] }),
      }),
    );
    const notice = screen.getByText(/swapped for the real card/).closest("section");
    expect(notice?.textContent).toContain("Fuecoco ex · 30th Celebration · #015");
    await user.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.queryByText(/swapped for the real card/)).toBeNull();
  });

  it("says how many copies the stand-in holds and where, or that it holds none", () => {
    const other = { ...STAND_IN, id: "user:en:11111111-1111-4111-8111-111111111111" };
    render(
      createElement(SyncScreen, {
        initialState: state({
          swapped: [],
          unsure: [
            { standIn: STAND_IN, held: HELD, candidates: [REAL] },
            { standIn: other, held: NONE_HELD, candidates: [REAL] },
          ],
          kept: [],
        }),
      }),
    );
    const [first, second] = screen.getAllByTestId("stand-in-review");
    expect(first.textContent).toContain("You have 2 copies: KB-001 · Front · Red");
    expect(second.textContent).toContain("Not in your collection (0 copies).");
  });

  it("swaps a suggestion only after she confirms, naming the copies it moves", async () => {
    m.swapStandInAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(
      createElement(SyncScreen, {
        initialState: state({
          swapped: [],
          unsure: [{ standIn: STAND_IN, held: HELD, candidates: [REAL] }],
          kept: [],
        }),
      }),
    );
    await user.click(screen.getByRole("button", { name: "This is the card" }));
    expect(m.swapStandInAction).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog").textContent).toContain(
      "Your 2 copies will be filed as that card.",
    );
    await user.click(screen.getByRole("button", { name: "Swap" }));
    expect(m.swapStandInAction).toHaveBeenCalledWith(STAND_IN.id, REAL.id);
    expect(await screen.findByText("Swapped your stand-in for the real card.")).toBeTruthy();
  });

  it("finds another card in the catalog when every suggestion is wrong", async () => {
    m.swapStandInAction.mockResolvedValue({ ok: true });
    m.searchCatalog.mockResolvedValue([
      {
        tcgdexId: "30th-147",
        name: "Fuecoco ex",
        setId: "30th",
        setName: "30th Celebration",
        localId: "147",
        imageUrl: null,
      } as never,
    ]);
    const user = userEvent.setup();
    render(
      createElement(SyncScreen, {
        initialState: state({
          swapped: [],
          unsure: [{ standIn: STAND_IN, held: HELD, candidates: [REAL] }],
          kept: [],
        }),
      }),
    );
    await user.click(screen.getByRole("button", { name: "Find the right card" }));
    await user.type(screen.getByPlaceholderText("Find the real card…"), "fuecoco");
    await user.click(await screen.findByText(/#147|147/, { selector: "button *, button" }));
    await user.click(screen.getByRole("button", { name: "Swap" }));
    expect(m.swapStandInAction).toHaveBeenCalledWith(STAND_IN.id, "30th-147");
  });

  it("fixes the stand-in she typed", async () => {
    m.fixStandInAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(
      createElement(SyncScreen, {
        initialState: state({
          swapped: [],
          unsure: [{ standIn: STAND_IN, held: HELD, candidates: [REAL] }],
          kept: [],
        }),
      }),
    );
    await user.click(screen.getByRole("button", { name: "Fix the stand-in" }));
    const set = screen.getByLabelText("Set");
    await user.clear(set);
    await user.type(set, "30th Celebration");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(m.fixStandInAction).toHaveBeenCalledWith(STAND_IN.id, {
      name: "Fuecoco ex",
      setName: "30th Celebration",
      localId: "15/128",
    });
  });

  it("leaves it as a stand-in, remembering the cards she was shown, and can ask again", async () => {
    m.keepStandInAction.mockResolvedValue({ ok: true });
    m.reviewStandInAgainAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    const { unmount } = render(
      createElement(SyncScreen, {
        initialState: state({
          swapped: [],
          unsure: [{ standIn: STAND_IN, held: HELD, candidates: [REAL] }],
          kept: [],
        }),
      }),
    );
    await user.click(screen.getByRole("button", { name: "Leave it as a stand-in" }));
    expect(m.keepStandInAction).toHaveBeenCalledWith(STAND_IN.id, [REAL.id]);
    unmount();

    render(
      createElement(SyncScreen, {
        initialState: state({ swapped: [], unsure: [], kept: [{ ...STAND_IN, held: HELD }] }),
      }),
    );
    await user.click(screen.getByRole("button", { name: "Ask me again" }));
    expect(m.reviewStandInAgainAction).toHaveBeenCalledWith(STAND_IN.id);
  });

  it("says why a swap was refused, and offers no swap for it", () => {
    render(
      createElement(SyncScreen, {
        initialState: state({
          swapped: [],
          unsure: [
            {
              standIn: STAND_IN,
              held: HELD,
              candidates: [REAL],
              blocked: "Something went wrong.",
            },
          ],
          kept: [],
        }),
      }),
    );
    expect(screen.getByText("Something went wrong.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "This is the card" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("the count check's 'you removed', card by card", () => {
  it("lists each removed card and adds the one she picks back", async () => {
    m.restoreRemovedAction.mockResolvedValue({ ok: true, restored: 1, alreadyRestored: false });
    const user = userEvent.setup();
    render(
      createElement(SyncScreen, {
        initialState: {
          ...EMPTY,
          removed: [
            {
              catalogCardId: "30th-123",
              dexVariantRaw: "Holo",
              count: 1,
              name: "Hisuian Zoroark",
              setName: "30th Celebration",
              localId: "123",
              imageUrl: null,
            },
          ],
        },
      }),
    );
    const panel = screen.getByTestId("removed-cards");
    expect(panel.textContent).toContain("Hisuian Zoroark · 30th Celebration · #123 · Holo");
    await user.click(screen.getByRole("button", { name: "Add it back" }));
    expect(m.restoreRemovedAction).toHaveBeenCalledWith("30th-123", "Holo");
    expect(await screen.findByText("Added back 1 Hisuian Zoroark. Ready to place.")).toBeTruthy();
  });

  it("shows nothing when she has removed nothing", () => {
    render(createElement(SyncScreen, { initialState: EMPTY }));
    expect(screen.queryByTestId("removed-cards")).toBeNull();
  });
});
