// @vitest-environment jsdom
/**
 * UIL-109 — Binders & capacity when a read fails: the shared words (`LOST.load`, a read that also throws for
 * a server failure), never the raw error text. The page's first load, and a binder's card grid once opened.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOST } from "@/app/(ui)/_components/reach";
import { CapacityScreen } from "@/app/(ui)/binders/CapacityScreen";

const loadCapacity = vi.fn();
const loadBinderCards = vi.fn();
vi.mock("@/app/(ui)/binders/actions", () => ({
  loadCapacity: (...a: unknown[]) => loadCapacity(...a),
  loadBinderCards: (...a: unknown[]) => loadBinderCards(...a),
}));

const DATA = {
  sections: [
    {
      binderId: "kb1",
      binderName: "KB-001",
      binderType: "general",
      half: "front",
      capacity: 180,
      shelvedCount: 10,
      blockPockets: 0,
      openPlaceholders: 0,
      freePockets: 170,
      fullness: "ok",
    },
  ],
  roomForLine: [],
};
const text = () =>
  screen
    .queryAllByRole("alert")
    .map((a) => a.textContent)
    .join(" | ") + document.body.textContent;

beforeEach(() => {
  loadCapacity.mockReset();
  loadBinderCards.mockReset();
});
afterEach(cleanup);

describe("UIL-109 · Binders says a failed read in the shared words", () => {
  it("the page's first load", async () => {
    loadCapacity.mockRejectedValue(new Error("relation binder does not exist"));
    render(createElement(CapacityScreen));
    await waitFor(() => expect(document.body.textContent).toContain(LOST.load));
    expect(document.body.textContent).not.toContain("relation binder");
  });

  it("a binder's cards, once she opens it", async () => {
    loadCapacity.mockResolvedValue(DATA);
    loadBinderCards.mockRejectedValue(new TypeError("Failed to fetch"));
    const user = userEvent.setup();
    render(createElement(CapacityScreen));
    const opener = await screen.findByRole("button", { name: /KB-001/ });
    await user.click(opener);
    await waitFor(() => expect(text()).toContain(LOST.load));
    expect(document.body.textContent).not.toContain("Failed to fetch");
  });
});
