// @vitest-environment jsdom
/**
 * UIL-117 PR 2 — the line popup (mockup v3 sections 3 and 4), driven in a DOM. Her rules as the screen shows them:
 * nothing she owns is pulled unless she ticks it; "What moves" says what physically happens; the lines the family
 * already has are named before she starts another; a line in another language takes a second, explicit tick.
 */
import { createElement, useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LinePopup } from "@/app/(ui)/_components/LinePopup";
import type { LineChoice, LinePopupModel, LineProposal } from "@/lib/line/popup";

const identity = (tcgdexId: string, name: string) => ({
  tcgdexId,
  name,
  setId: "sv03",
  setName: "Obsidian Flames",
  localId: "026",
  setCardCountOfficial: 197,
  imageUrl: null,
  bandKey: "red",
});
const START: LinePopupModel = {
  mode: "start",
  copyId: "moving",
  card: { ...identity("sv03-027", "Charmeleon"), locale: "en" },
  line: {
    lineId: null,
    binderId: "b1",
    binderName: "KB-001",
    bandKey: "red",
    bandDisplay: "Red",
    locale: "en",
    filledBefore: 0,
    filledAfter: 1,
    total: 2,
  },
  stages: [
    {
      stageIndex: 0,
      stage: "Basic",
      state: "pullable",
      card: identity("sv03-026", "Charmander"),
      pull: { copyId: "owned-cmd", fromLabel: "KB-001 · Front · Red" },
    },
    { stageIndex: 1, stage: "Stage1", state: "incoming", card: identity("sv03-027", "Charmeleon") },
  ],
  existingLines: [
    {
      lineId: "line-ja",
      speciesLabel: "Charmeleon",
      filledCount: 1,
      totalCount: 2,
      binderId: "b2",
      bandKey: "red",
      locale: "ja",
      binderName: "KB-002",
      bandDisplay: "Red",
      joinSlotId: "slot-ja-1",
      sameHere: false,
    },
  ],
};
const FOREIGN_ADD: LinePopupModel = {
  ...START,
  mode: "add",
  line: {
    ...START.line,
    lineId: "line-ja",
    binderName: "KB-002",
    locale: "ja",
    filledBefore: 1,
    filledAfter: 2,
  },
  stages: [
    {
      stageIndex: 0,
      stage: "Basic",
      state: "here",
      card: identity("ja:sv2a-004", "Charmander"),
      copyId: "ja-cmd",
    },
    { stageIndex: 1, stage: "Stage1", state: "incoming", card: identity("sv03-027", "Charmeleon") },
  ],
  existingLines: [],
};

afterEach(cleanup);

/** The popup with real state, as a screen holds it. */
function Harness(props: {
  model: LinePopupModel;
  initial: LineChoice;
  onConfirm: (c: LineChoice) => void;
  onSwitch?: (p: LineProposal) => void;
}) {
  const [value, setValue] = useState<LineChoice>(props.initial);
  return createElement(LinePopup, {
    model: props.model,
    value,
    onChange: setValue,
    onConfirm: props.onConfirm,
    onCancel: () => {},
    onSwitch: props.onSwitch,
  });
}

describe("UIL-117 · the line popup", () => {
  it("START: the card she owns is shown UNTICKED, and 'What moves' says it stays put", () => {
    render(
      createElement(Harness, {
        model: START,
        initial: { mode: "start", binderId: "b1", band: "red", pulls: [] },
        onConfirm: vi.fn(),
      }),
    );
    expect(screen.getByRole("dialog", { name: "Start a line" })).toBeTruthy();
    expect(
      (screen.getByRole("checkbox", { name: /Pull it into this line/ }) as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(screen.getByText("Stays put")).toBeTruthy();
    expect(screen.getByText(/In KB-001 · Front · Red/)).toBeTruthy();
  });

  it("ticking the pull moves it into the line, and confirming sends exactly what she ticked", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      createElement(Harness, {
        model: START,
        initial: { mode: "start", binderId: "b1", band: "red", pulls: [] },
        onConfirm,
      }),
    );
    await user.click(screen.getByRole("checkbox", { name: /Pull it into this line/ }));
    expect(screen.getByText("Take out")).toBeTruthy();
    expect(screen.queryByText("Stays put")).toBeNull();
    await user.click(screen.getByRole("button", { name: /Start line/ }));
    expect(onConfirm).toHaveBeenCalledWith({
      mode: "start",
      binderId: "b1",
      band: "red",
      pulls: ["owned-cmd"],
    });
  });

  it("names the line the family already has, in its language, and 'Add to that line' switches to it", async () => {
    const onSwitch = vi.fn();
    const user = userEvent.setup();
    render(
      createElement(Harness, {
        model: START,
        initial: { mode: "start", binderId: "b1", band: "red", pulls: [] },
        onConfirm: vi.fn(),
        onSwitch,
      }),
    );
    expect(screen.getByText(/You already have 1 Charmeleon line/)).toBeTruthy();
    expect(screen.getByText(/Japanese · 1\/2 filled/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add to that line" }));
    expect(onSwitch).toHaveBeenCalledWith({ kind: "add", lineId: "line-ja", slotId: "slot-ja-1" });
  });

  it("ADD to a line in another language: Confirm waits for the second, explicit tick", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      createElement(Harness, {
        model: FOREIGN_ADD,
        initial: { mode: "join", lineId: "line-ja", slotId: "slot-ja-1" },
        onConfirm,
      }),
    );
    const confirm = screen.getByRole("button", { name: /Add to line/ }) as HTMLButtonElement;
    expect(screen.getByText(/This is a Japanese line, and this card is English/)).toBeTruthy();
    expect(confirm.disabled).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: /Join the Japanese line anyway/ }));
    expect(confirm.disabled).toBe(false);
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith({
      mode: "join",
      lineId: "line-ja",
      slotId: "slot-ja-1",
      foreignLocale: true,
    });
  });
});
