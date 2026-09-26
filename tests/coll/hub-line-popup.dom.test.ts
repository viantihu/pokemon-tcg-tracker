// @vitest-environment jsdom
/**
 * UIL-117 PR 2 — Collections' "Remove ▸" sheet opens the line popup for a card with ONE copy here (a line slot holds
 * one card), and her confirm reaches `removeCardFromCollection` with her choice. With several copies the sheet has
 * no popup, so the back half stays as it was (the server refuses it too, remove-into-line.test.ts). The Move sheet is
 * stood in for; what is pinned here is the hub's wiring.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LineChoice, LineProposal } from "@/lib/line/popup";
import type { MoveDestination } from "@/lib/line/types";
import type { CollHubData, CollectionCardView } from "@/app/(ui)/coll/coll-types";
import { CollHub } from "@/app/(ui)/coll/CollHub";

const DEST: MoveDestination = { kind: "shelf", binderId: "kb1", half: "back", band: "red" };
const PROPOSAL: LineProposal = { kind: "start", binderId: "kb1", band: "red" };
const CHOICE: LineChoice = { mode: "start", binderId: "kb1", band: "red", pulls: [] };

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/(ui)/_components/MoveOverlay", async () => {
  const { createElement: h, useState } = await import("react");
  return {
    MoveOverlay: function MoveOverlay({
      lineModel,
      onConfirm,
    }: {
      lineModel?: (p: LineProposal) => Promise<unknown>;
      onConfirm: (d: MoveDestination, c?: LineChoice) => void;
    }) {
      const [said, setSaid] = useState("");
      if (!lineModel) return h("div", { role: "dialog" }, "No line popup");
      return h("div", { role: "dialog" }, [
        h(
          "button",
          {
            key: "l",
            type: "button",
            onClick: () =>
              lineModel(PROPOSAL).then(
                () => setSaid("Line loaded"),
                (e: Error) => setSaid(e.message),
              ),
          },
          "BACK HALF",
        ),
        h(
          "button",
          { key: "c", type: "button", onClick: () => onConfirm(DEST, CHOICE) },
          "Start line",
        ),
        h("span", { key: "s" }, said),
      ]);
    },
  };
});
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
const lineModelAction = vi.fn();
vi.mock("@/app/(ui)/_components/line-popup-actions", () => ({
  lineModelAction: (...a: unknown[]) => lineModelAction(...a),
}));

const card = (name: string, copyIds: string[]): CollectionCardView => ({
  tcgdexId: `sv03-${name.toLowerCase()}`,
  name,
  setName: "Obsidian Flames",
  localId: "004",
  setCardCountOfficial: 197,
  bandKey: "red",
  imageUrl: null,
  owned: true,
  held: true,
  wished: false,
  copyIds,
});
const DATA: CollHubData = {
  collections: [
    {
      id: "col-1",
      name: "Starters",
      mode: "finite",
      binderIds: ["spec"],
      binderNames: ["Specialty A"],
      cards: [card("Charmander", ["copy-1"]), card("Squirtle", ["copy-2", "copy-3"])],
      ownedCount: 2,
      totalCount: 2,
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
  lineModelAction.mockReset().mockResolvedValue({ ok: true, model: {} });
});
afterEach(cleanup);

async function openRemoveFor(name: string) {
  const user = userEvent.setup();
  render(createElement(CollHub));
  await screen.findByText("Starters");
  const show = screen.queryByTitle("Show Starters");
  if (show) await user.click(show);
  const tile = screen.getByText(name).closest(".ccard") as HTMLElement;
  await user.click(within(tile).getByRole("button", { name: /^Remove (\d+ )?▸$/ }));
  await screen.findByRole("dialog");
  return user;
}

describe("UIL-117 · Collections: Remove into a back half, through the line popup", () => {
  it("one copy here: the popup is built for that copy", async () => {
    const user = await openRemoveFor("Charmander");
    await user.click(screen.getByRole("button", { name: "BACK HALF" }));
    await screen.findByText("Line loaded");
    expect(lineModelAction).toHaveBeenCalledWith("copy-1", PROPOSAL);
  });

  it("her confirm reaches the server as one removal carrying her choice", async () => {
    const user = await openRemoveFor("Charmander");
    await user.click(screen.getByRole("button", { name: "Start line" }));
    await waitFor(() => expect(removeCardFromCollection).toHaveBeenCalledTimes(1));
    expect(removeCardFromCollection).toHaveBeenCalledWith("col-1", "sv03-charmander", DEST, CHOICE);
  });

  it("two copies here: no popup (a line holds one card)", async () => {
    await openRemoveFor("Squirtle");
    expect(screen.getByText("No line popup")).toBeTruthy();
    expect(lineModelAction).not.toHaveBeenCalled();
  });
});
