// @vitest-environment jsdom
/**
 * UIL-113 — the Japanese collection as she saw it: 10 cards shelved, 2 more on its list that she holds nowhere
 * (left by the Testing wipe, which deletes copies and keeps lists). Driven through the REAL Collections hub.
 * The header says what is IN it, the 2 are marked, and each can be taken off the list from its own tile.
 */
import { createElement } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollHubData, CollectionCardView } from "@/app/(ui)/coll/coll-types";
import { CollHub } from "@/app/(ui)/coll/CollHub";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
const loadCollHub = vi.fn();
const removeCardFromCollection = vi.fn();
vi.mock("@/app/(ui)/coll/actions", () => ({
  deleteCollection: vi.fn(),
  loadCollHub: (...a: unknown[]) => loadCollHub(...a),
  logCardIntoCollection: vi.fn(),
  rebindCollectionWithMove: vi.fn(),
  removeCardFromCollection: (...a: unknown[]) => removeCardFromCollection(...a),
  removeCopyFromApp: vi.fn(),
  saveCollection: vi.fn(),
  searchCatalog: vi.fn(async () => []),
  setCollectionMode: vi.fn(),
  wishlistCollectionCard: vi.fn(),
}));

const card = (n: number, owned: boolean): CollectionCardView => ({
  tcgdexId: `ja:sv2a-${String(n).padStart(3, "0")}`,
  name: `Card ${n}`,
  setName: "Pokemon Card 151",
  localId: String(n),
  setCardCountOfficial: null,
  bandKey: "red",
  imageUrl: null,
  owned,
  held: owned,
  wished: false,
  copyIds: owned ? [`copy-${n}`] : [],
});
const CARDS = [
  ...Array.from({ length: 10 }, (_, i) => card(i + 1, true)),
  card(11, false),
  card(12, false),
];
const DATA: CollHubData = {
  collections: [
    {
      id: "col-ja",
      name: "Japanese",
      mode: "open",
      binderIds: ["spec"],
      binderNames: ["Specialty A"],
      cards: CARDS,
      ownedCount: 10,
      totalCount: 12,
      incomplete: false,
    },
  ],
  specialtyBinders: [{ id: "spec", name: "Specialty A" }],
  wishlist: { groups: [], entries: [] },
  moveOptions: { binders: [], collectionsByBinder: {}, bands: [] },
};

beforeEach(() => {
  loadCollHub.mockReset().mockResolvedValue(DATA);
  removeCardFromCollection.mockReset().mockResolvedValue({ ok: true });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The hub, with the collection unfolded so its tiles render (collections start folded). */
async function mountOpen() {
  const user = userEvent.setup();
  render(createElement(CollHub));
  await screen.findByText("Japanese");
  const show = screen.queryByTitle("Show Japanese");
  if (show) await user.click(show);
  return user;
}

describe("UIL-113 · an open collection counts what is IN it", () => {
  it("says 10 in the binder and 2 not in your collection, never 12 logged", async () => {
    await mountOpen();
    expect(screen.getByText(/10 in the binder · 2 not in your collection/)).toBeTruthy();
    expect(screen.queryByText(/12 logged/)).toBeNull();
    expect(document.querySelector(".infnum")?.textContent).toBe("10");
  });

  it("marks exactly the 2, each with its own Remove from collection", async () => {
    await mountOpen();
    const marked = screen.getAllByText("Not in your collection");
    expect(marked).toHaveLength(2);
    for (const pill of marked) {
      const tile = pill.closest(".ccard") as HTMLElement;
      expect(tile.className).toContain("need");
      expect(within(tile).getByRole("button", { name: "Remove from collection" })).toBeTruthy();
    }
    expect(screen.getAllByText("In collection")).toHaveLength(10);
  });

  it("Remove from collection takes THAT card off the list, and moves nothing", async () => {
    const user = await mountOpen();
    const tile = screen.getByText("Card 12").closest(".ccard") as HTMLElement;
    await user.click(within(tile).getByRole("button", { name: "Remove from collection" }));
    expect(removeCardFromCollection).toHaveBeenCalledWith("col-ja", "ja:sv2a-012", {
      kind: "bulk",
    });
  });
});
