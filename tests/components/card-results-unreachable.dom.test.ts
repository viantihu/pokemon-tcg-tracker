// @vitest-environment jsdom
/**
 * UIL-109 — the shared card search (Lookup's type-ahead, the Sync match overlay, Backfill and Collections'
 * pickers) when the search itself fails: the shared words, never the raw error text, and still never "no
 * match" (UIL-035: a failed search is not a missing card).
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOST } from "@/app/(ui)/_components/reach";
import { CardResultsGrid } from "@/app/(ui)/_components/CardResultsGrid";

afterEach(cleanup);

describe("UIL-109 · the read wording is true of every throw", () => {
  it("names the server failing too, since these reads also throw for that, not only a dropped call", () => {
    expect(LOST.load).toMatch(
      /^The app was updated while this page was open, the connection dropped, or the server could not answer\./,
    );
    expect(LOST.load).not.toMatch(/saved/i); // a read changes nothing
  });
});

describe("UIL-109 · a failed card search says so in the shared words", () => {
  it("names the causes, not the server's text, and does not claim the card is missing", async () => {
    const search = vi.fn(async () => {
      throw new Error("Could not search the catalog: canceling statement due to statement timeout");
    });
    const user = userEvent.setup();
    render(createElement(CardResultsGrid, { search, onPick: vi.fn() }));
    await user.type(screen.getByRole("textbox"), "Charm");
    // PRE-FIX: "Could not search the catalog: canceling statement due to statement timeout".
    await waitFor(() => expect(document.body.textContent).toContain(LOST.load));
    expect(document.body.textContent).not.toContain("statement timeout");
    expect(document.body.textContent).not.toMatch(/no match/i);
  });
});
