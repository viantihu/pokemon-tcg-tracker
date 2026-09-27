// @vitest-environment jsdom
/**
 * UIL-117 PR 2 — Lookup's Move sheet opens the line popup for the copy being moved (its back half was greyed out:
 * "Move it from the Lines page"), and her confirm there reaches `moveFromLookup` with her choice. The Move sheet is
 * stood in for (its popup behaviour is pinned in move-panel-line-popup.dom.test.ts); what is pinned here is the
 * screen's wiring: which copy the popup is built for, and that the choice is sent.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LineChoice, LineProposal } from "@/lib/line/popup";
import type { MoveDestination } from "@/lib/line/types";
import type { LookupAnswer } from "@/lib/surfaces";
import type { LookupMovableCopy } from "@/app/(ui)/look/lookup-copies";
import { LookupScreen } from "@/app/(ui)/look/LookupScreen";

const DEST: MoveDestination = { kind: "shelf", binderId: "b1", half: "back", band: "red" };
const PROPOSAL: LineProposal = { kind: "start", binderId: "b1", band: "red" };
const CHOICE: LineChoice = { mode: "start", binderId: "b1", band: "red", pulls: [], stages: {} };

vi.mock("@/app/(ui)/_components/CardResultsGrid", async () => {
  const { createElement: h } = await import("react");
  return {
    CardResultsGrid: ({ onPick }: { onPick: (c: { tcgdexId: string }) => void }) =>
      h("button", { type: "button", onClick: () => onPick({ tcgdexId: "sv03-027" }) }, "Pick it"),
  };
});
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

const lookupAnswer = vi.fn();
const lookupMoveOptions = vi.fn();
const moveFromLookup = vi.fn();
vi.mock("@/app/(ui)/look/actions", () => ({
  lookupAnswer: (...a: unknown[]) => lookupAnswer(...a),
  lookupMoveOptions: (...a: unknown[]) => lookupMoveOptions(...a),
  moveFromLookup: (...a: unknown[]) => moveFromLookup(...a),
  removeCopy: vi.fn(),
  searchCatalog: vi.fn(async () => []),
}));
const lineModelAction = vi.fn();
vi.mock("@/app/(ui)/_components/line-popup-actions", () => ({
  lineModelAction: (...a: unknown[]) => lineModelAction(...a),
}));

const ANSWER: LookupAnswer = {
  card: {
    tcgdexId: "sv03-027",
    name: "Charmeleon",
    setName: "Obsidian Flames",
    localId: "027/197",
    rarity: "Uncommon",
    types: ["Fire"],
    stage: "Stage1",
    cardClass: "standard",
    imageUrl: null,
  },
  subtitle: "Uncommon · Fire · Stage1",
  bandKey: "red",
  bandDisplay: "Red",
  bandStack: [{ key: "red", active: true }],
  owned: true,
  ownedCount: 2,
  location: { binderName: "Main", half: "FRONT HALF", bandDisplay: "Red" },
  facts: [],
};
const COPIES: LookupMovableCopy[] = [
  {
    copyId: "c-front",
    role: "shelved",
    currentLabel: "Main · Front · Red",
    initial: { kind: "shelf", binderId: "b1", half: "front", band: "red" },
  },
  { copyId: "c-haul", role: "haul", currentLabel: "In your haul" },
];

beforeEach(() => {
  for (const f of [lookupAnswer, lookupMoveOptions, moveFromLookup, lineModelAction]) f.mockReset();
  lookupAnswer.mockResolvedValue({ ok: true, answer: ANSWER, copies: COPIES });
  lookupMoveOptions.mockResolvedValue({
    ok: true,
    options: { binders: [], collectionsByBinder: {}, bands: [] },
  });
  lineModelAction.mockResolvedValue({ ok: true, model: {} });
  moveFromLookup.mockResolvedValue({
    ok: true,
    label: "Main · Back · Red",
    lookup: { ok: true, answer: ANSWER, copies: COPIES },
  });
});
afterEach(cleanup);

async function openMoveFor(index: number) {
  const user = userEvent.setup();
  render(createElement(LookupScreen));
  await user.click(screen.getByRole("button", { name: "Pick it" }));
  await screen.findByText("Charmeleon");
  await user.click(screen.getAllByRole("button", { name: "Move" })[index]);
  await screen.findByRole("dialog");
  return user;
}

describe("UIL-117 · Lookup: the back half opens the line popup", () => {
  it("builds the popup for THE copy being moved, not another copy of the card", async () => {
    const user = await openMoveFor(1);
    await user.click(screen.getByRole("button", { name: "BACK HALF" }));
    await screen.findByText("Line loaded");
    expect(lineModelAction).toHaveBeenCalledWith("c-haul", PROPOSAL);
  });

  it("her confirm reaches the server as one move carrying her choice", async () => {
    const user = await openMoveFor(0);
    await user.click(screen.getByRole("button", { name: "Start line" }));
    await waitFor(() => expect(moveFromLookup).toHaveBeenCalledTimes(1));
    expect(moveFromLookup).toHaveBeenCalledWith("c-front", DEST, "sv03-027", CHOICE);
  });

  it("a refusal loading the line comes back in its own words", async () => {
    lineModelAction.mockResolvedValue({
      ok: false,
      error: "That card is no longer in the collection.",
    });
    const user = await openMoveFor(0);
    await user.click(screen.getByRole("button", { name: "BACK HALF" }));
    expect(await screen.findByText("That card is no longer in the collection.")).toBeTruthy();
  });
});
