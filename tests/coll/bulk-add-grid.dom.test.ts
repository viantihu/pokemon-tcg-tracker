// @vitest-environment jsdom
/**
 * UIL-101 — "Search & add cards", the click path: pick cards, press Add, and the page says where they went.
 *
 * Driven through the REAL page in a DOM (QA's rule for a click path), with the server action stood in for:
 * what the write does is pinned against real Postgres in tests/coll/bulk-add-wishlist.test.ts. What is pinned
 * here is that she is TOLD, since an add that quietly put cards on her wishlist would be its own surprise:
 * how many joined the list, how many went on her wishlist, and how many she already owns. And that an Add
 * which cannot reach the server ends in the shared words (UIL-106) with her selection kept.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowseCard } from "@/app/(ui)/coll/coll-types";
import { LOST } from "@/app/(ui)/_components/reach";
import { bulkAddSummary, CardSearchGrid } from "@/app/(ui)/coll/CardSearchGrid";

// The real module, with only the router hooks stood in for: `reach` needs its `unstable_rethrow`.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
const bulkAddTargets = vi.fn();
const browseCards = vi.fn();
vi.mock("@/app/(ui)/coll/actions", () => ({
  browseCards: (...a: unknown[]) => browseCards(...a),
  bulkAddTargets: (...a: unknown[]) => bulkAddTargets(...a),
  getCollectionName: vi.fn(async () => "Starters"),
  listSetOptions: vi.fn(async () => []),
  resolveSpeciesToDexId: vi.fn(async () => null),
}));

const card = (tcgdexId: string, name: string, owned: boolean): BrowseCard => ({
  tcgdexId,
  name,
  setId: "sv01",
  setName: "Scarlet & Violet",
  localId: tcgdexId.slice(-3),
  setCardCountOfficial: 198,
  illustrator: null,
  types: ["Grass"],
  imageUrl: null,
  owned,
});
const CARDS = [
  card("sv01-001", "Sprigatito", false),
  card("sv01-002", "Floragato", false),
  card("sv01-003", "Meowscarada", true),
];

async function pickAll() {
  const user = userEvent.setup();
  render(createElement(CardSearchGrid, { collectionId: "col-1" }));
  for (const c of CARDS)
    await user.click(await screen.findByRole("button", { name: new RegExp(c.name) }));
  return user;
}
const addButton = () => screen.getByRole("button", { name: /^Add 3 to/ }) as HTMLButtonElement;

beforeEach(() => {
  browseCards.mockReset();
  browseCards.mockResolvedValue({ cards: CARDS, nextOffset: 3, hasMore: false });
  bulkAddTargets.mockReset();
});
afterEach(cleanup);

describe("UIL-101 · a bulk add says where each card went", () => {
  it("how many joined the list, how many went on her wishlist, and how many she already owns", async () => {
    bulkAddTargets.mockResolvedValue({
      ok: true,
      added: 3,
      wishlisted: 2,
      alreadyWished: 0,
      owned: 1,
    });
    const user = await pickAll();
    await user.click(addButton());

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "Added 3 cards to Starters. Of the 3 you picked, 2 went on your wishlist, 1 you already own.",
      ),
    );
    expect(bulkAddTargets).toHaveBeenCalledWith("col-1", ["sv01-001", "sv01-002", "sv01-003"]);
  });

  it("an Add that cannot reach the server says so in the shared words, and keeps her selection", async () => {
    bulkAddTargets.mockRejectedValue(new TypeError("Failed to fetch"));
    const user = await pickAll();
    await user.click(addButton());

    // PRE-FIX: the raw "Failed to fetch".
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(LOST.action));
    expect(screen.getByRole("alert").textContent).not.toContain("Failed to fetch");
    // Nothing is claimed as added, and she can press Add again without re-picking.
    expect(screen.queryByRole("status")).toBeNull();
    expect(addButton().disabled).toBe(false);
  });
});

describe("UIL-101 · the summary's words", () => {
  const r = (over: Partial<Parameters<typeof bulkAddSummary>[0]>) => ({
    added: 0,
    wishlisted: 0,
    alreadyWished: 0,
    owned: 0,
    ...over,
  });

  it("leaves out the parts that are zero", () => {
    expect(bulkAddSummary(r({ added: 2, owned: 2 }), "Starters")).toBe(
      "Added 2 cards to Starters. Of the 2 you picked, 2 you already own.",
    );
  });

  it("names cards already on her wishlist, which were not wished for twice", () => {
    expect(bulkAddSummary(r({ added: 1, alreadyWished: 1 }), "Starters")).toBe(
      "Added 1 card to Starters. Of the 1 you picked, 1 was already on your wishlist.",
    );
  });

  it("counts what she picked, not only what was new to the list", () => {
    // Two were already on the list, so one is new; all three are unowned and now wished for.
    expect(bulkAddSummary(r({ added: 1, wishlisted: 3 }), "Starters")).toBe(
      "Added 1 card to Starters. Of the 3 you picked, 3 went on your wishlist.",
    );
  });
});
