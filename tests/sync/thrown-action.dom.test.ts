// @vitest-environment jsdom
/**
 * The stuck import (2026-09-26): her first import after a wipe showed its progress bar for good and saved nothing.
 * Testing had been redeployed a minute earlier, and a new deployment retires the old server-action ids, so the
 * open page's call THREW before reaching the server. The actions return their own failures as `{ ok: false }`, but
 * nothing on the Sync screen caught a throw, so the phase never reset. Driven through the REAL SyncScreen: a thrown
 * preview, a thrown apply (fast path and gated), a thrown Undo and a thrown refresh each end in a message that says what to
 * do, with the controls usable again.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOST_ACTION,
  LOST_APPLY,
  LOST_PREVIEW,
  LOST_REFRESH,
  SyncScreen,
} from "@/app/(ui)/sync/SyncScreen";
import type { SyncState } from "@/app/(ui)/sync/sync-types";
import * as actions from "@/app/(ui)/sync/actions";
import { emptyCountCheck } from "@/lib/sync/count-check";

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
  searchCatalog: vi.fn(),
  undismissEntryAction: vi.fn(),
  undoLastSync: vi.fn(),
}));

const STATE: SyncState = {
  waiting: { unknownSet: [], unknownCard: [] },
  cardTypes: [],
  dismissed: [],
  counts: { waiting: 0, dismissed: 0 },
  undo: { available: false, createdAt: null, summary: null },
  aliases: [],
  countCheck: emptyCountCheck(),
};
const WITH_UNDO: SyncState = {
  ...STATE,
  undo: { available: true, createdAt: null, summary: null },
};

/** What the browser throws when the page's action id no longer exists on the deployment. */
const STALE = () => Promise.reject(new Error("Failed to find Server Action"));
const FILE = () => new File(["Type;Category\n"], "dex.csv", { type: "text/csv" });
const fileInput = () => document.querySelector('input[type="file"]') as HTMLInputElement;
const bar = () => screen.queryByRole("progressbar");

const m = vi.mocked(actions);

beforeEach(() => {
  vi.clearAllMocks();
  m.loadSyncState.mockResolvedValue(STATE);
});
afterEach(cleanup);

/** The controls are usable again: no bar, the import is enabled, and it runs when she picks a file. */
async function expectUsable(user: ReturnType<typeof userEvent.setup>) {
  expect(bar()).toBeNull();
  expect(fileInput().disabled).toBe(false);
  expect(screen.getByText("Import Dex export")).toBeTruthy();
  m.previewSync.mockResolvedValueOnce({
    ok: true,
    preview: { kind: "noop" } as never,
    bundle: {} as never,
  });
  await user.upload(fileInput(), FILE());
  expect(await screen.findByText("Already in sync — nothing to apply.")).toBeTruthy();
}

describe("a server action that throws does not leave the Sync screen running forever", () => {
  it("a thrown PREVIEW: the message says nothing was saved, and the import works again", async () => {
    m.previewSync.mockImplementationOnce(STALE);
    const user = userEvent.setup();
    render(createElement(SyncScreen, { initialState: STATE }));

    await user.upload(fileInput(), FILE());

    expect(await screen.findByText(LOST_PREVIEW)).toBeTruthy();
    expect(m.applySync).not.toHaveBeenCalled();
    await expectUsable(user);
  });

  it("a thrown fast-path APPLY: the bar said it was saving, then the message says to reload and check", async () => {
    m.previewSync.mockResolvedValueOnce({
      ok: true,
      preview: { kind: "fastpath" } as never,
      bundle: {} as never,
    });
    let fail!: (e: Error) => void;
    m.applySync.mockImplementationOnce(
      () => new Promise((_, reject) => (fail = reject)) as ReturnType<typeof actions.applySync>,
    );
    const user = userEvent.setup();
    render(createElement(SyncScreen, { initialState: STATE }));

    await user.upload(fileInput(), FILE());

    // While the auto-apply runs, the bar names the stage she is in, not the read before it.
    await waitFor(() => expect(m.applySync).toHaveBeenCalledTimes(1));
    expect(bar()?.getAttribute("aria-label")).toBe("Saving your changes…");
    fail(new Error("Failed to find Server Action"));

    expect(await screen.findByText(LOST_APPLY)).toBeTruthy();
    await expectUsable(user);
  });

  it("a thrown gated APPLY: the message says to reload and check, and the preview's buttons work again", async () => {
    m.previewSync.mockResolvedValueOnce({
      ok: true,
      preview: {
        kind: "gated",
        summary: {
          removed: 1,
          variantChanges: 0,
          flagFixes: 0,
          added: 0,
          waiting: 0,
          unchanged: 0,
        },
        sections: {
          flagFixes: [],
          removals: [],
          variantChanges: [],
          additions: [],
          unresolved: { newParks: [], stillWaiting: 0 },
          unchanged: 0,
        },
        retireOptions: {},
      } as never,
      bundle: {} as never,
    });
    m.applySync.mockImplementationOnce(STALE);
    const user = userEvent.setup();
    render(createElement(SyncScreen, { initialState: STATE }));

    await user.upload(fileInput(), FILE());
    await user.click(await screen.findByRole("button", { name: "Apply" }));

    expect(await screen.findByText(LOST_APPLY)).toBeTruthy();
    expect(bar()).toBeNull();
    expect(screen.getByRole("button", { name: "Apply" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(false);
  });

  it("a thrown UNDO: the message says to reload and check, and Undo can be pressed again", async () => {
    m.undoLastSync.mockImplementationOnce(STALE);
    m.loadSyncState.mockResolvedValue(WITH_UNDO); // nothing was undone, so the bar is still there
    const user = userEvent.setup();
    render(createElement(SyncScreen, { initialState: WITH_UNDO }));

    await user.click(screen.getByRole("button", { name: "Undo last sync" }));

    expect(await screen.findByText(LOST_ACTION)).toBeTruthy();
    expect(bar()).toBeNull();
    expect(screen.getByRole("button", { name: "Undo last sync" }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("a thrown REFRESH after an import that went through: no bar, and she is told to reload for the latest", async () => {
    m.previewSync.mockResolvedValueOnce({
      ok: true,
      preview: { kind: "noop" } as never,
      bundle: {} as never,
    });
    m.loadSyncState.mockImplementationOnce(STALE);
    const user = userEvent.setup();
    render(createElement(SyncScreen, { initialState: STATE }));

    await user.upload(fileInput(), FILE());

    expect(await screen.findByText(LOST_REFRESH)).toBeTruthy();
    expect(screen.getByText("Already in sync — nothing to apply.")).toBeTruthy();
    expect(bar()).toBeNull();
  });
});
