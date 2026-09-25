// @vitest-environment jsdom
/**
 * UIL-099 E2, the screen half — driven through the REAL SyncScreen in a DOM (QA's rule for a click path).
 *
 * A manual match that held cards back because she removed them must SAY so and offer the way back, not show
 * "Matched and ready to place" over a match that added nothing. The notice is a panel, not a toast, because
 * it carries an action and must stay until she chooses. "Add it back" calls the restore action for THIS row;
 * "Keep it removed" writes nothing.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncScreen } from "@/app/(ui)/sync/SyncScreen";
import type { LookupCard } from "@/app/(ui)/plan/plan-types";
import type { QueueEntryView, SyncState } from "@/app/(ui)/sync/sync-types";
import * as actions from "@/app/(ui)/sync/actions";
import { emptyCountCheck } from "@/lib/sync/count-check";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const CARD: LookupCard = {
  tcgdexId: "xy7-012",
  name: "Card A",
  setId: "xy7",
  setName: "Ancient Origins",
  localId: "012",
  setCardCountOfficial: 100,
  stage: "Basic",
  types: ["Fire"],
  category: "Pokemon",
  trainerType: null,
  cardClass: "standard",
  imageUrl: null,
  variants: ["normal"],
};

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
  searchCatalog: vi.fn(async () => [CARD]),
  undismissEntryAction: vi.fn(),
  undoLastSync: vi.fn(),
}));

const ENTRY = {
  id: "e1",
  dexId: "xy7-99",
  dexName: "Mystery Card",
  dexSetName: "Ancient Origins",
  dexSeries: "XY",
  dexNumber: "99",
  dexVariantRaw: "Normal",
  quantity: 1,
  locale: "en",
  reason: "UNKNOWN_CARD",
  status: "WAITING",
  firstSeenSync: "2026-09-24T00:00:00Z",
  lastRetrySync: null,
  retryCount: 0,
  manualMatchId: null,
  aliasKey: "en:xy7",
} as QueueEntryView;

const STATE: SyncState = {
  waiting: { unknownSet: [], unknownCard: [ENTRY] },
  cardTypes: ["Fire"],
  dismissed: [],
  counts: { waiting: 1, dismissed: 0 },
  undo: { available: false, createdAt: null, summary: null },
  aliases: [],
  countCheck: emptyCountCheck(),
};

const m = vi.mocked(actions);

beforeEach(() => {
  vi.clearAllMocks();
  m.loadSyncState.mockResolvedValue(STATE);
  m.searchCatalog.mockResolvedValue([CARD]);
});
afterEach(cleanup);

/** Open the match overlay for ENTRY, search, and pick CARD — exactly her clicks. */
async function matchIt(user: ReturnType<typeof userEvent.setup>) {
  render(createElement(SyncScreen, { initialState: STATE }));
  await user.click(screen.getByRole("button", { name: "Match manually" }));
  await user.type(screen.getByLabelText("Card lookup"), "Card A");
  await waitFor(() => expect(document.querySelector(".cgrid button")).not.toBeNull());
  await user.click(document.querySelector(".cgrid button") as HTMLElement);
}

describe("UIL-099 E2 · the Sync screen says what a match held back", () => {
  it("shows the notice, names the card, and does NOT claim the card is ready to place", async () => {
    m.manualMatchEntry.mockResolvedValue({
      ok: true,
      drainedSet: false,
      withheld: 1,
      alreadyMatched: false,
    });
    const user = userEvent.setup();
    await matchIt(user);

    expect(m.manualMatchEntry).toHaveBeenCalledWith("e1", "xy7-012");
    const notice = await screen.findByText(/not added/);
    expect(notice.textContent).toContain("1 Mystery Card was not added");
    expect(notice.textContent).toContain("you removed this card from the app");
    expect(screen.getByRole("button", { name: "Add it back" })).toBeTruthy();
    expect(screen.queryByText("Matched and ready to place.")).toBeNull();
  });

  it("'Add it back' restores THIS row's cards, then the notice goes and says what came back", async () => {
    m.manualMatchEntry.mockResolvedValue({
      ok: true,
      drainedSet: false,
      withheld: 1,
      alreadyMatched: false,
    });
    m.restoreWithheldAction.mockResolvedValue({ ok: true, restored: 1, alreadyRestored: false });
    const user = userEvent.setup();
    await matchIt(user);

    await user.click(await screen.findByRole("button", { name: "Add it back" }));

    expect(m.restoreWithheldAction).toHaveBeenCalledWith("e1");
    expect(await screen.findByText("Added back 1 Mystery Card. Ready to place.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add it back" })).toBeNull();
  });

  it("'Keep it removed' closes the notice and writes nothing", async () => {
    m.manualMatchEntry.mockResolvedValue({
      ok: true,
      drainedSet: false,
      withheld: 1,
      alreadyMatched: false,
    });
    const user = userEvent.setup();
    await matchIt(user);

    await user.click(await screen.findByRole("button", { name: "Keep it removed" }));

    expect(m.restoreWithheldAction).not.toHaveBeenCalled();
    expect(screen.queryByText(/not added/)).toBeNull();
  });

  it("with nothing held back there is no notice, and the usual toast", async () => {
    m.manualMatchEntry.mockResolvedValue({
      ok: true,
      drainedSet: false,
      withheld: 0,
      alreadyMatched: false,
    });
    const user = userEvent.setup();
    await matchIt(user);

    expect(await screen.findByText("Matched and ready to place.")).toBeTruthy();
    expect(screen.queryByText(/not added/)).toBeNull();
  });

  it("a second press that found the match already made says nothing was added twice", async () => {
    m.manualMatchEntry.mockResolvedValue({
      ok: true,
      drainedSet: false,
      withheld: 0,
      alreadyMatched: true,
    });
    const user = userEvent.setup();
    await matchIt(user);

    expect(await screen.findByText("Already matched. Nothing was added twice.")).toBeTruthy();
  });
});
