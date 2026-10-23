// @vitest-environment jsdom
/**
 * UIL-139 — a failed Apply says so where she is looking. Apply sits at the bottom of a preview that can run to
 * hundreds of rows; the error used to render in an amber panel at the TOP of the page, so a refused Apply read as
 * a button that did nothing, with no error text. Driven through the REAL SyncScreen: the error shows inside the
 * preview directly above Apply and Cancel, as an alert, scrolled into view; a retry or a cancel clears it; and an
 * error with no preview open (the file itself failed) still shows at the top.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncScreen } from "@/app/(ui)/sync/SyncScreen";
import type { SyncState } from "@/app/(ui)/sync/sync-types";
import * as actions from "@/app/(ui)/sync/actions";
import { emptyCountCheck } from "@/lib/sync/count-check";

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

const STATE: SyncState = {
  waiting: { unknownSet: [], unknownCard: [] },
  cardTypes: [],
  dismissed: [],
  counts: { waiting: 0, dismissed: 0 },
  undo: { available: false, createdAt: null, summary: null },
  aliases: [],
  countCheck: emptyCountCheck(),
  standIns: { swapped: [], unsure: [] },
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
const REFUSED =
  "Your collection changed since this preview, so it was not applied. Import the file again to see what it would do now.";

const FILE = () => new File(["Type;Category\n"], "dex.csv", { type: "text/csv" });
const fileInput = () => document.querySelector('input[type="file"]') as HTMLInputElement;
const apply = () => screen.findByRole("button", { name: "Apply" });
const m = vi.mocked(actions);
const scrollIntoView = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no layout, so no scrollIntoView; the screen guards for it and the test supplies one to watch.
  Element.prototype.scrollIntoView = scrollIntoView;
  m.loadSyncState.mockResolvedValue(STATE);
  m.previewSync.mockResolvedValue(GATED);
});
afterEach(cleanup);

describe("UIL-139 · a refused Apply reports beside Apply", () => {
  it("shows the refusal inside the preview, directly above Apply and Cancel, as the only alert", async () => {
    m.applySync.mockResolvedValue({ ok: false, error: REFUSED });
    const user = userEvent.setup();
    render(createElement(SyncScreen, { initialState: STATE }));
    await user.upload(fileInput(), FILE());
    await user.click(await apply());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(REFUSED);
    expect(screen.getAllByRole("alert")).toHaveLength(1); // PRE-FIX: a second copy sat at the top of the page
    // It lives in the preview's own panel, and the button row follows it.
    const preview = alert.parentElement as HTMLElement;
    expect(preview.textContent).toContain("PREVIEW");
    expect(alert.nextElementSibling?.contains(screen.getByRole("button", { name: "Apply" }))).toBe(
      true,
    );
    // Still in the preview: Apply is live again so she can try once more.
    expect(screen.getByRole("button", { name: "Apply" }).hasAttribute("disabled")).toBe(false);
  });

  it("scrolls the error into view", async () => {
    m.applySync.mockResolvedValue({ ok: false, error: REFUSED });
    const user = userEvent.setup();
    render(createElement(SyncScreen, { initialState: STATE }));
    await user.upload(fileInput(), FILE());
    await user.click(await apply());
    await screen.findByRole("alert");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  });

  it("a lost call reads the same way", async () => {
    m.applySync.mockRejectedValue(new Error("fetch failed"));
    const user = userEvent.setup();
    render(createElement(SyncScreen, { initialState: STATE }));
    await user.upload(fileInput(), FILE());
    await user.click(await apply());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Reload the page to see whether your import was saved/);
    expect(alert.parentElement?.textContent).toContain("PREVIEW");
  });

  it("a second Apply clears the old message while it works, and a success leaves no alert", async () => {
    m.applySync.mockResolvedValueOnce({ ok: false, error: REFUSED }).mockResolvedValueOnce({
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
    render(createElement(SyncScreen, { initialState: STATE }));
    await user.upload(fileInput(), FILE());
    await user.click(await apply());
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.queryByText(REFUSED)).toBeNull();
  });

  it("Cancel discards the preview and its error with it", async () => {
    m.applySync.mockResolvedValue({ ok: false, error: REFUSED });
    const user = userEvent.setup();
    render(createElement(SyncScreen, { initialState: STATE }));
    await user.upload(fileInput(), FILE());
    await user.click(await apply());
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(REFUSED)).toBeNull();
  });
});

describe("UIL-139 · an error with no preview stays at the top", () => {
  it("a file that could not be read is an alert at the top of the page, not inside a preview", async () => {
    m.previewSync.mockResolvedValue({ ok: false, error: "That file is not a Dex export." });
    const user = userEvent.setup();
    render(createElement(SyncScreen, { initialState: STATE }));
    await user.upload(fileInput(), FILE());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("That file is not a Dex export.");
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    expect(alert.parentElement?.textContent).not.toContain("PREVIEW");
  });
});
