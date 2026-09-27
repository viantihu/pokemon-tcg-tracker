// @vitest-environment jsdom
/**
 * UIL-117 PR 5 prep: the line popup's render-only parts, exported for Backfill's confirm sheet, render the same on
 * their own as inside the popup: a stage tile, and UIL-096's "You already have N X lines" block with its tiles.
 */
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExistingLinesBlock, LineStageTile } from "@/app/(ui)/_components/LinePopupParts";
import type { LinePopupExistingLine } from "@/lib/line/popup";

const card = {
  tcgdexId: "sv03-026",
  name: "Charmander",
  setId: "sv03",
  setName: "Obsidian Flames",
  localId: "026",
  setCardCountOfficial: 197,
  imageUrl: null,
  bandKey: "red",
};
const LINE: LinePopupExistingLine = {
  lineId: "L2",
  speciesLabel: "CHARMANDER LINE",
  filledCount: 1,
  totalCount: 3,
  binderId: "b2",
  bandKey: "red",
  locale: "ja",
  binderName: "KB-002",
  bandDisplay: "Red",
  joinSlotId: "S2",
  sameHere: false,
  face: card,
};

afterEach(cleanup);

describe("UIL-117 PR 5 prep · the popup's parts, on their own", () => {
  it("ExistingLinesBlock: the count, each line's place and language, and 'Add to that line' opens it", async () => {
    const onSwitch = vi.fn();
    const user = userEvent.setup();
    render(
      createElement(ExistingLinesBlock, {
        existingLines: [LINE],
        lineName: "Charmeleon",
        cardLocale: "en",
        onSwitch,
      }),
    );
    expect(screen.getByText(/You already have 1 Charmeleon line/)).toBeTruthy();
    expect(screen.getByText(/KB-002 · Back · Red/)).toBeTruthy();
    expect(screen.getByText(/Japanese · 1\/3 filled/)).toBeTruthy();
    expect(
      screen.getByText(/A line in another language won't take this English card/),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add to that line" }));
    expect(onSwitch).toHaveBeenCalledWith({ kind: "add", lineId: "L2", slotId: "S2" });
  });

  it("ExistingLinesBlock: nothing at all when the family has no line; no button without a handler", () => {
    const { container } = render(
      createElement(ExistingLinesBlock, { existingLines: [], lineName: "X", cardLocale: "en" }),
    );
    expect(container.innerHTML).toBe("");
    cleanup();
    render(
      createElement(ExistingLinesBlock, { existingLines: [LINE], lineName: "X", cardLocale: "ja" }),
    );
    expect(screen.queryByRole("button", { name: "Add to that line" })).toBeNull();
  });

  it("LineStageTile: a stage with its card, number and state tag", () => {
    render(
      createElement(LineStageTile, {
        stage: { stageIndex: 0, stage: "Basic", state: "here", card },
        first: true,
        incomingLabel: "New",
        asWanted: false,
        swapping: false,
        ticked: false,
        onTogglePull: () => {},
        busy: false,
      }),
    );
    expect(screen.getByText("Basic")).toBeTruthy();
    expect(screen.getByText("026/197")).toBeTruthy();
    expect(screen.getByText("Already here")).toBeTruthy();
    expect(document.querySelector(".lp-arrow")).toBeNull();
  });
});
