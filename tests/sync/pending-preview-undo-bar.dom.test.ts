// @vitest-environment jsdom
/**
 * Her import "failed" (2026-10-02): the preview of her new import was waiting for Apply, and beside it the PREVIOUS
 * sync's LAST SYNC bar offered "Place new cards". She tapped that, never pressed Apply, and nothing of the import
 * was in. Driven through the REAL SyncScreen: while a preview is pending, the old bar offers no "Place new cards"
 * and cannot be undone, and says to apply this preview first; once she applies it, the bar is this sync's, with
 * both back; a cancelled preview gives the old bar its controls back.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncScreen } from "@/app/(ui)/sync/SyncScreen";
import type { SyncState } from "@/app/(ui)/sync/sync-types";
import * as actions from "@/app/(ui)/sync/actions";
import { emptyCountCheck } from "@/lib/sync/count-check";
import type { SyncCounts } from "@/lib/sync/undo";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
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

/** A sync's counts, zero but where named. */
const COUNTS = (c: Partial<SyncCounts>): SyncCounts => ({
  creates: 0,
  retires: 0,
  variantUpdates: 0,
  flagFixes: 0,
  promotions: 0,
  parks: 0,
  drops: 0,
  dedupeUpdates: 0,
  unchanged: 0,
  ...c,
});
/** Her state with a previous sync to undo. */
const AFTER_LAST_SYNC: SyncState = {
  waiting: { unknownSet: [], unknownCard: [] },
  cardTypes: [],
  dismissed: [],
  counts: { waiting: 0, dismissed: 0 },
  undo: {
    available: true,
    createdAt: null,
    summary: COUNTS({ creates: 12 }),
  },
  aliases: [],
  countCheck: emptyCountCheck(),
};
/** After she applies this import: the bar is this sync's. */
const AFTER_THIS_SYNC: SyncState = {
  ...AFTER_LAST_SYNC,
  undo: {
    available: true,
    createdAt: null,
    summary: COUNTS({ creates: 3, retires: 1 }),
  },
};
const GATED = {
  ok: true as const,
  preview: {
    kind: "gated",
    summary: { removed: 1, variantChanges: 0, flagFixes: 0, added: 3, waiting: 0, unchanged: 0 },
    summaryLine: "3 added · 1 removed",
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
};
const FILE = () => new File(["Type;Category\n"], "dex.csv", { type: "text/csv" });
const fileInput = () => document.querySelector('input[type="file"]') as HTMLInputElement;
const placeLink = () => screen.queryByRole("link", { name: "Place new cards" });
const undoButton = () => screen.getByRole("button", { name: "Undo last sync" });

const m = vi.mocked(actions);
beforeEach(() => {
  vi.clearAllMocks();
  m.loadSyncState.mockResolvedValue(AFTER_LAST_SYNC);
  m.previewSync.mockResolvedValue(GATED);
});
afterEach(cleanup);

describe("Sync · the LAST SYNC bar while a preview waits for Apply", () => {
  it("with no preview, the last sync offers Place new cards and its Undo", () => {
    render(createElement(SyncScreen, { initialState: AFTER_LAST_SYNC }));
    expect(placeLink()?.getAttribute("href")).toBe("/plan");
    expect(undoButton().hasAttribute("disabled")).toBe(false);
  });

  it("with a preview pending: no Place new cards, the old sync's Undo locked, and Apply this preview first", async () => {
    const user = userEvent.setup();
    render(createElement(SyncScreen, { initialState: AFTER_LAST_SYNC }));
    await user.upload(fileInput(), FILE());
    expect(await screen.findByRole("button", { name: "Apply" })).toBeTruthy();
    expect(placeLink()).toBeNull();
    expect(undoButton().hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("note").textContent).toBe("Apply this preview first");
    // Apply is the one primary action on the screen's preview.
    expect(screen.getByRole("button", { name: "Apply" }).className).toContain("btn-primary");
  });

  it("after Apply, the bar is this sync's: Place new cards and its Undo are back", async () => {
    m.applySync.mockResolvedValue({
      ok: true,
      added: 3,
      removed: 1,
      variantChanges: 0,
      flagFixes: 0,
      waiting: 0,
      fastPath: false,
      notification: "",
    });
    const user = userEvent.setup();
    render(createElement(SyncScreen, { initialState: AFTER_LAST_SYNC }));
    await user.upload(fileInput(), FILE());
    m.loadSyncState.mockResolvedValue(AFTER_THIS_SYNC);
    await user.click(await screen.findByRole("button", { name: "Apply" }));
    await waitFor(() => expect(placeLink()?.getAttribute("href")).toBe("/plan"));
    expect(undoButton().hasAttribute("disabled")).toBe(false);
    expect(screen.queryByText("Apply this preview first")).toBeNull();
    expect(screen.getByText("LAST SYNC").parentElement?.textContent).toContain(
      "3 added · 1 removed",
    );
  });

  it("a cancelled preview gives the old bar its controls back", async () => {
    const user = userEvent.setup();
    render(createElement(SyncScreen, { initialState: AFTER_LAST_SYNC }));
    await user.upload(fileInput(), FILE());
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(placeLink()?.getAttribute("href")).toBe("/plan");
    expect(undoButton().hasAttribute("disabled")).toBe(false);
  });
});
