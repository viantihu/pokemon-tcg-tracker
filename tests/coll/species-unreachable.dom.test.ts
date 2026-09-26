// @vitest-environment jsdom
/**
 * UIL-106 (3) — "Search & add cards": the Pokémon filter when its lookup cannot reach the server.
 *
 * The species box resolves a name to a Pokédex number on every change. That call had nothing to catch a
 * throw, so a lookup that never arrived left the LAST name's filter applied under the new name, and said
 * nothing: she would be reading results for a Pokémon she was no longer asking about. Driven through the
 * REAL page in a DOM, with the lookup scripted to reject.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CardSearchGrid, speciesLookupFailed } from "@/app/(ui)/coll/CardSearchGrid";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
const browseCards = vi.fn();
const resolveSpeciesToDexId = vi.fn();
vi.mock("@/app/(ui)/coll/actions", () => ({
  browseCards: (...a: unknown[]) => browseCards(...a),
  bulkAddTargets: vi.fn(),
  getCollectionName: vi.fn(async () => "Starters"),
  listSetOptions: vi.fn(async () => []),
  resolveSpeciesToDexId: (...a: unknown[]) => resolveSpeciesToDexId(...a),
}));

const box = () => screen.getByPlaceholderText("e.g. Charmander");
/** The species filter the most recent search was sent with. */
const lastDexFilter = () =>
  (browseCards.mock.calls.at(-1)?.[0] as { dexId?: number } | undefined)?.dexId;

beforeEach(() => {
  browseCards.mockReset();
  browseCards.mockResolvedValue({ cards: [], nextOffset: 0, hasMore: false });
  resolveSpeciesToDexId.mockReset();
});
afterEach(cleanup);

describe("UIL-106 · the Pokémon filter when its lookup cannot reach the server", () => {
  it("says so under the box, and drops the previous name's filter instead of keeping it silently", async () => {
    resolveSpeciesToDexId.mockResolvedValue(4); // "Charmander"
    const user = userEvent.setup();
    render(createElement(CardSearchGrid, { collectionId: "col-1" }));

    await user.type(box(), "Charmander");
    await waitFor(() => expect(lastDexFilter()).toBe(4));

    resolveSpeciesToDexId.mockRejectedValue(new TypeError("Failed to fetch"));
    await user.clear(box());
    await user.type(box(), "Pikachu");

    // PRE-FIX: no message, and the search kept filtering on Charmander (4) under the word "Pikachu".
    await waitFor(() => expect(screen.getByText(speciesLookupFailed("Pikachu"))).toBeTruthy());
    await waitFor(() => expect(lastDexFilter()).toBeUndefined());
  });
});
