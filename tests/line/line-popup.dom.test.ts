// @vitest-environment jsdom
/**
 * UIL-117 PR 2 — the line popup (mockup v3 sections 3 and 4), driven in a DOM. Her rules as the screen shows them:
 * nothing she owns is pulled unless she ticks it; "What moves" says what physically happens; the lines the family
 * already has are named before she starts another; a line in another language takes a second, explicit tick.
 */
import { createElement, useState } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
      value: { mode: "start", binderId: "b1", band: "red", pulls: [], stages: {} } as LineChoice,
      onChange: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    };
    const { rerender } = render(
      createElement(LinePopup, { ...props, position: { index: 1, total: 2 } }),
    );
    expect(screen.getByRole("button", { name: /Start (a new )?line/ }).textContent).toBe(
      "Start a new line anyway · next ▶",
    );
    rerender(createElement(LinePopup, { ...props, position: { index: 2, total: 2 } }));
    expect(screen.getByRole("button", { name: /Start (a new )?line/ }).textContent).toBe(
      "Start a new line anyway ▶",
    );
    expect(screen.getByText(/Line card 2 of 2/)).toBeTruthy();
  });

  it("the screen's own word wins: Confirm & next wraps to a skipped card, so 2 of 2 can still have a next", () => {
    const props = {
      model: START,
      value: { mode: "start", binderId: "b1", band: "red", pulls: [], stages: {} } as LineChoice,
      onChange: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    };
    const { rerender } = render(
      createElement(LinePopup, { ...props, position: { index: 2, total: 2, next: true } }),
    );
    expect(screen.getByRole("button", { name: /Start (a new )?line/ }).textContent).toBe(
      "Start a new line anyway · next ▶",
    );
    rerender(createElement(LinePopup, { ...props, position: { index: 1, total: 2, next: false } }));
    expect(screen.getByRole("button", { name: /Start (a new )?line/ }).textContent).toBe(
      "Start a new line anyway ▶",
    );
  });
});

describe("UIL-117 · the line popup", () => {
  it("START: the card she owns is shown UNTICKED, and 'What moves' says it stays put", () => {
    render(
      createElement(Harness, {
        model: START,
        initial: { mode: "start", binderId: "b1", band: "red", pulls: [], stages: {} },
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
        initial: { mode: "start", binderId: "b1", band: "red", pulls: [], stages: {} },
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
        value: { mode: "start", binderId: "b1", band: "red", pulls: [], stages: {} },
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
        initial: { mode: "start", binderId: "b1", band: "red", pulls: [], stages: {} },
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
        initial: { mode: "start", binderId: "b1", band: "red", pulls: [], stages: {} },
        onConfirm,
      }),
    );
    await user.click(screen.getByRole("checkbox", { name: /Pull it into this line/ }));
    expect(screen.getByText("Take out")).toBeTruthy();
    expect(screen.queryByText("Stays put")).toBeNull();
    // UIL-121: with the pull ticked the two-card line is complete, so she says what fills its third pocket first.
    await user.click(screen.getByRole("button", { name: /Leave it empty/ }));
    await user.click(screen.getByRole("button", { name: /Start (a new )?line/ }));
    expect(onConfirm).toHaveBeenCalledWith({
      mode: "start",
      binderId: "b1",
      band: "red",
      pulls: ["owned-cmd"],
      stages: {},
      thirdPocket: { material: "empty" },
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
        initial: { mode: "start", binderId: "b1", band: "red", pulls: [], stages: {} },
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
        initial: { mode: "start", binderId: "b1", band: "red", pulls: [], stages: {} },
        onConfirm: vi.fn(),
        onSwitch,
      }),
    );
    expect(screen.getByText(/You already have 1 Charmeleon line/)).toBeTruthy();
    expect(screen.getByText(/Japanese · 1\/2 filled/)).toBeTruthy();
    // The tile's own button (the note at the top has the same one: UX review of #441).
    await user.click(
      within(document.querySelector(".lp-also") as HTMLElement).getByRole("button", {
        name: "Add it there instead",
      }),
    );
    expect(onSwitch).toHaveBeenCalledWith({ kind: "add", lineId: "line-ja", slotId: "slot-ja-1" });
  });

  it("UIL-096's warning, marked: the line with room for this card comes first, 'Add it there instead' leads, nothing is picked, and starting another is still hers", async () => {
    // Two lines she already has: one full (listed first as it came), one with room for this card.
    const full = {
      ...START.existingLines[0],
      lineId: "line-full",
      binderName: "KB-003",
      locale: "en" as const,
      filledCount: 2,
      totalCount: 2,
      joinSlotId: null,
    };
    const withRoom = {
      ...START.existingLines[0],
      lineId: "line-room",
      binderName: "KB-001",
      locale: "en" as const,
      joinSlotId: "slot-room-1",
      sameHere: true,
    };
    const onConfirm = vi.fn();
    const onSwitch = vi.fn();
    const user = userEvent.setup();
    render(
      createElement(Harness, {
        model: { ...START, existingLines: [full, withRoom] },
        initial: { mode: "start", binderId: "b1", band: "red", pulls: [], stages: {} },
        onConfirm,
        onSwitch,
      }),
    );
    const tiles = [...document.querySelectorAll(".lp-also .lp-mini")] as HTMLElement[];
    // The line with room first, marked, with the one "Add it there instead".
    expect(tiles[0].textContent).toContain("KB-001");
    expect(within(tiles[0]).getByText("Has room for this card")).toBeTruthy();
    expect(within(tiles[1]).queryByText("Has room for this card")).toBeNull();
    expect(within(tiles[0]).getByRole("button", { name: "Add it there instead" })).toBeTruthy();
    expect(within(tiles[1]).queryByRole("button", { name: "Add it there instead" })).toBeNull();
    // …and named at the TOP, before what moves and the sticky confirm (UX review of #441), with the same one tap.
    const note = screen.getByRole("note");
    expect(note.textContent).toContain(
      "You have a Charmeleon line with room for this card · KB-001 · Back · Red",
    );
    const whatMoves = screen.getByText("What moves");
    expect(note.compareDocumentPosition(whatMoves) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(within(note).getByRole("button", { name: "Add it there instead" }));
    expect(onSwitch).toHaveBeenCalledWith({
      kind: "add",
      lineId: "line-room",
      slotId: "slot-room-1",
    });
    onSwitch.mockClear();
    // Nothing is picked for her: still a START, said as "anyway".
    const start = screen.getByRole("button", {
      name: /Start a new line anyway/,
    }) as HTMLButtonElement;
    expect(onSwitch).not.toHaveBeenCalled();
    // Her Basic, which she does not pull, she leaves empty (UIL-121: nothing is decided for her); then she starts.
    await user.click(screen.getByRole("button", { name: "Leave empty" }));
    await waitFor(() => expect(start.disabled).toBe(false));
    await user.click(start);
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ mode: "start" }));
  });

  it("with no line that has room, the confirm is the plain 'Start line'", () => {
    render(
      createElement(Harness, {
        model: {
          ...START,
          stages: START.stages.filter((st) => st.state === "incoming"),
          existingLines: [{ ...START.existingLines[0], joinSlotId: null }],
        },
        initial: { mode: "start", binderId: "b1", band: "red", pulls: [], stages: {} },
        onConfirm: vi.fn(),
      }),
    );
    expect(screen.getByRole("button", { name: /^Start line/ })).toBeTruthy();
    expect(screen.queryByText("Has room for this card")).toBeNull();
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

describe("UIL-121 · her choice for each empty stage and the third pocket", () => {
  const initial: LineChoice = { mode: "start", binderId: "b1", band: "red", pulls: [], stages: {} };
  const confirmButton = () =>
    screen.getByRole("button", { name: /Start (a new )?line/ }) as HTMLButtonElement;

  it("an unticked stage waits for her choice: Confirm stays off until she picks, and her pick is what is sent", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(createElement(Harness, { model: START, initial, onConfirm }));
    expect(screen.getByText(/Your choice for each empty stage/)).toBeTruthy();
    expect(screen.getByText(/Basic · Choose/)).toBeTruthy();
    expect(confirmButton().disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Leave empty" }));
    expect(confirmButton().disabled).toBe(false);
    await user.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith({ ...initial, stages: { 0: { kind: "empty" } } });
  });

  it("ticking the pull fills that stage: its choice is dropped from what is sent, and the third pocket is asked", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(createElement(Harness, { model: START, initial, onConfirm }));
    await user.click(screen.getByRole("button", { name: "Leave empty" }));
    await user.click(screen.getByRole("checkbox", { name: /Pull it into this line/ }));
    expect(screen.queryByText(/Your choice for each empty stage/)).toBeNull();
    expect(screen.getByText(/Third pocket · Choose/)).toBeTruthy();
    expect(confirmButton().disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: /A basic energy/ }));
    // It is on her to-do list: an energy in the third pocket.
    const rows = Array.from(document.querySelectorAll(".lp-moves .lp-mrow")).map(
      (r) => r.textContent,
    );
    expect(rows.some((t) => /Put in.*A basic energy.*→ the third pocket/.test(t ?? ""))).toBe(true);
    await user.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith({
      ...initial,
      pulls: ["owned-cmd"],
      stages: {},
      thirdPocket: { material: "energy" },
    });
  });

  it("unticking again drops the third pocket from what is sent: the line is no longer complete", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(createElement(Harness, { model: START, initial, onConfirm }));
    await user.click(screen.getByRole("checkbox", { name: /Pull it into this line/ }));
    await user.click(screen.getByRole("button", { name: /A basic energy/ }));
    await user.click(screen.getByRole("checkbox", { name: /Pull it into this line/ }));
    expect(screen.queryByText(/Third pocket/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Leave empty" }));
    await user.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith({ ...initial, stages: { 0: { kind: "empty" } } });
  });

  it("an Add that completes a short line whose pocket she has not decided asks it; one already decided does not", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    const english: LinePopupModel = {
      ...FOREIGN_ADD,
      line: { ...FOREIGN_ADD.line, locale: "en", thirdPocketOpen: true },
      stages: FOREIGN_ADD.stages.map((st) =>
        st.state === "here" ? { ...st, card: identity("sv03-026", "Charmander") } : st,
      ),
    };
    const join: LineChoice = { mode: "join", lineId: "line-ja", slotId: "slot-1" };
    const { unmount } = render(
      createElement(Harness, { model: english, initial: join, onConfirm }),
    );
    const add = () => screen.getByRole("button", { name: /Add to line/ }) as HTMLButtonElement;
    expect(add().disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: /Leave it empty/ }));
    await user.click(add());
    expect(onConfirm).toHaveBeenLastCalledWith({ ...join, thirdPocket: { material: "empty" } });
    unmount();
    render(
      createElement(Harness, {
        model: { ...english, line: { ...english.line, thirdPocketOpen: false } },
        initial: join,
        onConfirm,
      }),
    );
    expect(screen.queryByText(/Third pocket/)).toBeNull();
    await user.click(add());
    expect(onConfirm).toHaveBeenLastCalledWith(join);
  });
});

describe("UIL-121 · a stage whose card is still in this haul is not asked about", () => {
  it("while another card for the line waits in this haul, nothing is asked yet: that card's confirm asks", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    const coming: LinePopupModel = {
      ...START,
      line: { ...START.line, total: 3 },
      stages: [
        {
          stageIndex: 0,
          stage: "Basic",
          state: "coming",
          card: identity("sv03-026", "Charmander"),
          coming: { copyId: "haul-cmd" },
        },
        START.stages[1],
        { stageIndex: 2, stage: "Stage2", state: "wanted", card: null, dexId: 6 },
      ],
    };
    const initial: LineChoice = {
      mode: "start",
      binderId: "b1",
      band: "red",
      pulls: [],
      stages: {},
    };
    render(createElement(Harness, { model: coming, initial, onConfirm }));
    expect(screen.getByText("In this haul")).toBeTruthy();
    // The Senior BA's condition 1: the Stage 2 is asked on the LAST card she has for the line, not on this one.
    expect(screen.queryByText(/Your choice for each empty stage/)).toBeNull();
    expect(screen.queryByText(/Third pocket/)).toBeNull();
    await user.click(screen.getByRole("button", { name: /Start (a new )?line/ }));
    expect(onConfirm).toHaveBeenCalledWith({ ...initial, stages: {} });
  });
});

describe("UIL-121 · a join of her last card for a line asks about its other open stages (Karvi's ruling)", () => {
  const LINE3: LinePopupModel = {
    ...FOREIGN_ADD,
    line: { ...FOREIGN_ADD.line, locale: "en", total: 3, filledAfter: 2 },
    stages: [
      { ...FOREIGN_ADD.stages[0], card: identity("sv03-026", "Charmander") },
      FOREIGN_ADD.stages[1],
      {
        stageIndex: 2,
        stage: "Stage2",
        state: "wanted",
        card: null,
        choice: null,
        dexId: 6,
        suggestion: { card: identity("sv03-125", "Charizard"), special: false },
      },
    ],
  };
  const join: LineChoice = { mode: "join", lineId: "line-ja", slotId: "slot-1" };
  const addButton = () => screen.getByRole("button", { name: /Add to line/ }) as HTMLButtonElement;

  it("asks, with nothing pre-picked (Decide later included); Confirm waits; Decide later counts and is sent", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(createElement(Harness, { model: LINE3, initial: join, onConfirm }));
    expect(screen.getByText(/This line's other empty stages: your choice/)).toBeTruthy();
    expect(screen.getByText(/Stage 2 · Choose/)).toBeTruthy();
    expect(document.querySelectorAll(".lp-stagechoice .picked")).toHaveLength(0);
    expect(addButton().disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Decide later" }));
    expect(screen.getByRole("button", { name: "Decide later" }).className).toContain("picked");
    expect(addButton().disabled).toBe(false);
    await user.click(addButton());
    expect(onConfirm).toHaveBeenCalledWith({ ...join, stages: { 2: { kind: "later" } } });
  });

  it("a chase answer names its card in 'What moves' as a wishlist add", async () => {
    const user = userEvent.setup();
    render(createElement(Harness, { model: LINE3, initial: join, onConfirm: vi.fn() }));
    await user.click(screen.getByRole("button", { name: "Chase this" }));
    const rows = Array.from(document.querySelectorAll(".lp-moves .lp-mrow")).map(
      (r) => r.textContent,
    );
    expect(rows.some((t) => /Wishlist.*Charizard 026\/197 · for the Stage 2/.test(t ?? ""))).toBe(
      true,
    );
  });

  it("with another card for the line still in the haul, nothing is asked: that card's confirm asks", () => {
    const withComing: LinePopupModel = {
      ...LINE3,
      stages: [
        LINE3.stages[0],
        LINE3.stages[1],
        {
          ...LINE3.stages[2],
          state: "coming",
          card: identity("sv03-125", "Charizard"),
          coming: { copyId: "h" },
        },
      ],
    };
    render(createElement(Harness, { model: withComing, initial: join, onConfirm: vi.fn() }));
    expect(screen.queryByText(/other empty stages/)).toBeNull();
    expect(addButton().disabled).toBe(false);
  });
});

describe("UIL-121 · UX on #429: a picked choice and an open panel look different", () => {
  const initial: LineChoice = { mode: "start", binderId: "b1", band: "red", pulls: [], stages: {} };
  const suggested: LinePopupModel = {
    ...START,
    stages: [
      {
        ...START.stages[0],
        dexId: 4,
        suggestion: { card: identity("sv03-026", "Charmander"), special: false },
      },
      START.stages[1],
    ],
  };

  it("'Chase this' shows it is picked; an opened panel is marked open, not picked", async () => {
    const user = userEvent.setup();
    render(createElement(Harness, { model: suggested, initial, onConfirm: vi.fn() }));
    await user.click(screen.getByRole("button", { name: "Fill the pocket" }));
    const fill = screen.getByRole("button", { name: "Fill the pocket" });
    expect(fill.getAttribute("aria-expanded")).toBe("true");
    expect(fill.className).not.toContain("picked");
    await user.click(screen.getByRole("button", { name: "Chase this" }));
    expect(screen.getByRole("button", { name: "Chase this" }).className).toContain("picked");
  });

  it("a START's tile follows her choice: 'Not decided', then 'Filler'", async () => {
    const user = userEvent.setup();
    const wanted: LinePopupModel = {
      ...START,
      line: { ...START.line, total: 3 },
      stages: [
        ...START.stages,
        { stageIndex: 2, stage: "Stage2", state: "wanted", card: null, dexId: 6 },
      ],
    };
    render(createElement(Harness, { model: wanted, initial, onConfirm: vi.fn() }));
    const tile = () => document.querySelectorAll(".lp-strip .lp-slot")[2] as HTMLElement;
    expect(tile().textContent).toContain("Not decided");
    const stage2 = screen.getByRole("region", { name: /Stage 2/ });
    await user.click(within(stage2).getByRole("button", { name: "Fill the pocket" }));
    await user.click(within(stage2).getByRole("button", { name: /A basic energy/ }));
    expect(tile().textContent).toContain("Filler");
  });
});
