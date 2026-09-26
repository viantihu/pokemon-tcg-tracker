// @vitest-environment jsdom
/**
 * UIL-106 (3) — the Collections hub's two calls outside `run`, when they cannot reach the server at all.
 *
 * A server action THROWS when the app was redeployed under an open page or the connection dropped.
 * "New collection" awaited its draft save with nothing to catch a throw, so the button did nothing and
 * said nothing. The rebind remedy ("Move N cards … and rebind") reset its busy state in a `finally` but the
 * throw escaped, so the refusal and its button stayed up as if nothing had been tried. Driven through the
 * REAL hub in a DOM, each call scripted to reject.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollHubData, RebindRemedy } from "@/app/(ui)/coll/coll-types";
import { LOST } from "@/app/(ui)/_components/reach";
import { CollHub, rebindButtonLabel } from "@/app/(ui)/coll/CollHub";

// The real module, with only the router hooks stood in for: `reach` needs its `unstable_rethrow`.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
const loadCollHub = vi.fn();
const saveCollection = vi.fn();
const rebindCollectionWithMove = vi.fn();
const setCollectionMode = vi.fn();
vi.mock("@/app/(ui)/coll/actions", () => ({
  deleteCollection: vi.fn(),
  loadCollHub: (...a: unknown[]) => loadCollHub(...a),
  logCardIntoCollection: vi.fn(),
  rebindCollectionWithMove: (...a: unknown[]) => rebindCollectionWithMove(...a),
  removeCardFromCollection: vi.fn(),
  removeCopyFromApp: vi.fn(),
  saveCollection: (...a: unknown[]) => saveCollection(...a),
  searchCatalog: vi.fn(async () => []),
  setCollectionMode: (...a: unknown[]) => setCollectionMode(...a),
  wishlistCollectionCard: vi.fn(),
}));

const LOST_CALL = () => new TypeError("Failed to fetch");

const DATA: CollHubData = {
  collections: [
    {
      id: "col-1",
      name: "Starters",
      mode: "finite",
      binderIds: ["spec"],
      binderNames: ["Specialty A"],
      cards: [],
      ownedCount: 0,
      totalCount: 0,
      incomplete: false,
    },
  ],
  specialtyBinders: [
    { id: "spec", name: "Specialty A" },
    { id: "spec2", name: "Specialty B" },
  ],
  wishlist: { groups: [], entries: [] },
  moveOptions: { binders: [], collectionsByBinder: {}, bands: [] },
};
const REMEDY: RebindRemedy = {
  kind: "rebind-move",
  collectionId: "col-1",
  toBinderId: "spec2",
  toBinderName: "Specialty B",
  fromBinderNames: ["Specialty A"],
  copyCount: 3,
  cards: [{ tcgdexId: "sv04-099", name: "Minior", copyCount: 3 }],
  staying: [],
};
const REFUSAL = "Moving to a new binder would strand 3 shelved cards in the old one.";

const alerts = () =>
  screen
    .queryAllByRole("alert")
    .map((a) => a.textContent)
    .join(" | ");

async function mount() {
  const user = userEvent.setup();
  render(createElement(CollHub));
  await screen.findByText("Starters");
  return user;
}

beforeEach(() => {
  for (const f of [loadCollHub, saveCollection, rebindCollectionWithMove, setCollectionMode])
    f.mockReset();
  loadCollHub.mockResolvedValue(DATA);
});
afterEach(cleanup);

describe("UIL-106 · the Collections hub when a call cannot reach the server", () => {
  it("'New collection' says so, and opens no editor", async () => {
    saveCollection.mockRejectedValue(LOST_CALL());
    const user = await mount();

    await user.click(screen.getByRole("button", { name: /New collection/ }));

    // PRE-FIX: the throw escaped the click; nothing opened and nothing was said.
    await waitFor(() => expect(alerts()).toContain(LOST.action));
    expect(screen.queryByPlaceholderText("e.g. Matsuno illustrations")).toBeNull();
  });

  it("UIL-109: a first load that fails says so in the shared words, not the raw error text", async () => {
    loadCollHub.mockReset();
    loadCollHub.mockRejectedValue(new Error("relation collection does not exist"));
    render(createElement(CollHub));
    await waitFor(() => expect(alerts()).toContain(LOST.load));
    expect(alerts()).not.toContain("relation collection");
  });

  it("UIL-109: a change through run() that cannot reach the server says so in the shared words", async () => {
    // Its actions return `{ ok }` for their own failures, so a throw is a call that never arrived.
    setCollectionMode.mockRejectedValue(LOST_CALL());
    const user = await mount();
    // The mode toggle's "Open" (switching a finite list to an open count), not the card grid's.
    const toggle = screen
      .getAllByRole("button", { name: "Open" })
      .find((b) => b.className.includes("modebtn"))!;
    await user.click(toggle);
    await waitFor(() => expect(alerts()).toContain(LOST.action));
    expect(alerts()).not.toContain("Failed to fetch");
  });

  it("the rebind remedy says so on the editor's bar, and its button goes", async () => {
    // The pick is refused with its remedy; the remedy's own call then never arrives.
    saveCollection.mockResolvedValue({ ok: false, error: REFUSAL, remedy: REMEDY });
    rebindCollectionWithMove.mockRejectedValue(LOST_CALL());
    const user = await mount();

    await user.click(screen.getByRole("button", { name: /Edit/ }));
    await user.click(await screen.findByRole("button", { name: "Specialty B" }));
    const remedyButton = await screen.findByRole("button", { name: rebindButtonLabel(REMEDY) });
    await user.click(remedyButton);

    // PRE-FIX: the refusal and its button stayed, as if she had never pressed it.
    await waitFor(() => expect(alerts()).toContain(LOST.action));
    expect(alerts()).not.toContain(REFUSAL);
    expect(screen.queryByRole("button", { name: rebindButtonLabel(REMEDY) })).toBeNull();
  });
});
