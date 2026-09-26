// @vitest-environment jsdom
/**
 * UIL-109 — "Search & add cards" when the catalog search fails: the shared words (`LOST.load`: a read that
 * also throws for a server failure), never the raw error text. The first page, and "Load more".
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOST } from "@/app/(ui)/_components/reach";
import { CardSearchGrid } from "@/app/(ui)/coll/CardSearchGrid";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
const browseCards = vi.fn();
vi.mock("@/app/(ui)/coll/actions", () => ({
  browseCards: (...a: unknown[]) => browseCards(...a),
  bulkAddTargets: vi.fn(),
  getCollectionName: vi.fn(async () => "Starters"),
  listSetOptions: vi.fn(async () => []),
  resolveSpeciesToDexId: vi.fn(async () => null),
}));

const CARD = {
  tcgdexId: "sv01-001",
  name: "Sprigatito",
  setId: "sv01",
  setName: "Scarlet & Violet",
  localId: "001",
  setCardCountOfficial: 198,
  illustrator: null,
  types: ["Grass"],
  imageUrl: null,
  owned: false,
};

// Braces matter: a function RETURNED from beforeEach is run by Vitest as a teardown, and mockReset returns the mock.
beforeEach(() => {
  browseCards.mockReset();
});
afterEach(cleanup);

describe("UIL-109 · a failed catalog search says so in the shared words", () => {
  it("the first page", async () => {
    browseCards.mockRejectedValue(new Error("canceling statement due to statement timeout"));
    render(createElement(CardSearchGrid, { collectionId: "col-1" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(LOST.load));
    expect(document.body.textContent).not.toContain("statement timeout");
  });

  it("Load more, keeping the cards already shown", async () => {
    browseCards.mockResolvedValueOnce({ cards: [CARD], nextOffset: 1, hasMore: true });
    browseCards.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const user = userEvent.setup();
    render(createElement(CardSearchGrid, { collectionId: "col-1" }));
    await user.click(await screen.findByRole("button", { name: /Load more/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(LOST.load));
    expect(screen.getByText("Sprigatito")).toBeTruthy();
  });
});
