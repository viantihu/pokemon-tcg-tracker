// @vitest-environment jsdom
/**
 * UIL-117 PR 2 — the line popup (mockup v3 sections 3 and 4), driven in a DOM. Her rules as the screen shows them:
 * nothing she owns is pulled unless she ticks it; "What moves" says what physically happens; the lines the family
 * already has are named before she starts another; a line in another language takes a second, explicit tick.
 */
import { createElement, useState } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
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
      face: identity("ja:sv2a-005", "Charmeleon"),
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

describe("UIL-117 · the step-through label", () => {
  it("'· next' while another line card follows, and a plain confirm on the last one", () => {
    const props = {
      model: START,
      value: { mode: "start", binderId: "b1", band: "red", pulls: [] } as LineChoice,
      onChange: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    };
    const { rerender } = render(
      createElement(LinePopup, { ...props, position: { index: 1, total: 2 } }),
    );
    expect(screen.getByRole("button", { name: /Start line/ }).textContent).toBe(
      "Start line · next ▶",
    );
    rerender(createElement(LinePopup, { ...props, position: { index: 2, total: 2 } }));
    expect(screen.getByRole("button", { name: /Start line/ }).textContent).toBe("Start line ▶");
    expect(screen.getByText(/Line card 2 of 2/)).toBeTruthy();
  });

  it("the screen's own word wins: Confirm & next wraps to a skipped card, so 2 of 2 can still have a next", () => {
    const props = {
      model: START,
      value: { mode: "start", binderId: "b1", band: "red", pulls: [] } as LineChoice,
      onChange: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    };
    const { rerender } = render(
      createElement(LinePopup, { ...props, position: { index: 2, total: 2, next: true } }),
    );
    expect(screen.getByRole("button", { name: /Start line/ }).textContent).toBe(
      "Start line · next ▶",
    );
    rerender(createElement(LinePopup, { ...props, position: { index: 1, total: 2, next: false } }));
    expect(screen.getByRole("button", { name: /Start line/ }).textContent).toBe("Start line ▶");
  });
});

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
    const from = document.querySelector(".lp-src.lp-binder") as HTMLElement;
    expect(from.textContent).toBe("In KB-001 · Front · Red");
    // UX review of #385: each part stays whole, so a narrow tag never breaks "· Red" off on its own line.
    expect([...from.querySelectorAll(".lp-seg")].map((e) => e.textContent)).toEqual([
      "KB-001",
      "· Front",
      "· Red",
    ]);
  });

  it("every 'What moves' row and every existing-line tile leads with the card's image (v3)", () => {
    render(
      createElement(Harness, {
        model: START,
        initial: { mode: "start", binderId: "b1", band: "red", pulls: [] },
        onConfirm: vi.fn(),
      }),
    );
    const rows = [...document.querySelectorAll(".lp-mrow")];
    expect(rows).toHaveLength(2); // Shelve the Charmeleon, and her Charmander stays put
    for (const row of rows) expect(row.querySelector(".face.s")).not.toBeNull();
    expect(document.querySelector(".lp-mini .face.s")).not.toBeNull();
    // The line's stages at the large size, the incoming one marked for its ring.
    expect(document.querySelectorAll(".lp-strip .face.l")).toHaveLength(2);
    expect(document.querySelector(".lp-slot.lp-in .face.l")).not.toBeNull();
  });

  it("the band row: her band is marked, another reloads the popup for that band", async () => {
    const onBand = vi.fn();
    const user = userEvent.setup();
    render(
      createElement(LinePopup, {
        model: START,
        value: { mode: "start", binderId: "b1", band: "red", pulls: [] },
        onChange: () => {},
        onConfirm: () => {},
        onCancel: () => {},
        bands: [
          { key: "red", display: "Red" },
          { key: "green", display: "Green" },
        ],
        onBand,
      }),
    );
    const group = screen.getByRole("group", { name: "Colour band" });
    const red = within(group).getByRole("button", { name: /Red/ });
    expect(red.getAttribute("aria-pressed")).toBe("true");
    await user.click(red);
    expect(onBand).not.toHaveBeenCalled();
    await user.click(within(group).getByRole("button", { name: /Green/ }));
    expect(onBand).toHaveBeenCalledWith("green");
  });

  it("no band row where the band is already decided (no handler)", () => {
    render(
      createElement(Harness, {
        model: START,
        initial: { mode: "start", binderId: "b1", band: "red", pulls: [] },
        onConfirm: vi.fn(),
      }),
    );
    expect(screen.queryByRole("group", { name: "Colour band" })).toBeNull();
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

  it("a pull out of another line says that line is left one short, on its tag and in 'What moves' (UIL-061)", async () => {
    const user = userEvent.setup();
    const fromLine: LinePopupModel = {
      ...START,
      stages: [
        {
          ...START.stages[0],
          pull: {
            copyId: "owned-cmd",
            fromLabel: "KB-002 · Back · Red",
            leaves: { lineName: "CHARMANDER LINE", stage: "Basic" },
          },
        },
        START.stages[1],
      ],
    };
    render(
      createElement(Harness, {
        model: fromLine,
        initial: { mode: "start", binderId: "b1", band: "red", pulls: [] },
        onConfirm: vi.fn(),
      }),
    );
    expect((document.querySelector(".lp-src.lp-binder") as HTMLElement).textContent).toContain(
      "· leaves the CHARMANDER LINE one short",
    );
    await user.click(screen.getByRole("checkbox", { name: /Pull it into this line/ }));
    expect((document.querySelector(".lp-moves") as HTMLElement).textContent).toMatch(
      /Take out.*from KB-002 · Back · Red → into this line · leaves the CHARMANDER LINE one short \(its Basic goes empty\)/,
    );
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
    expect(screen.getByText(/This line is Japanese and this card is English/)).toBeTruthy();
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
