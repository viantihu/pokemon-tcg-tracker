// @vitest-environment jsdom
/**
 * UIL-117 PR 3 — the line popup's REPLACE view (mockup v3 section 5), and the UIL-069 colour choice on an Add, driven
 * in a DOM with the real popup, the real Move sheet inside it, and the real nested popup. Her rules as the screen
 * shows them: a replace opens on "keep the one that's there" and nothing moves unless she picks Swap (answer 2); the
 * card coming out goes anywhere, bulk suggested (answer 3); a colour mismatch picks neither option for her.
 */
import { createElement, useState } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LinePopup } from "@/app/(ui)/_components/LinePopup";
import {
  defaultChoiceFor,
  type LineChoice,
  type LinePopupColourChoice,
  type LinePopupModel,
  type LinePopupProps,
} from "@/lib/line/popup";
import type { MoveOptions } from "@/lib/line/types";

const id = (tcgdexId: string, name: string, localId: string, setCount = 197) => ({
  tcgdexId,
  name,
  setId: "sv03",
  setName: "Obsidian Flames",
  localId,
  setCardCountOfficial: setCount,
  imageUrl: null,
  bandKey: "red",
});
const OPTIONS: MoveOptions = {
  binders: [
    { id: "b1", name: "KB-001", type: "general" },
    { id: "b3", name: "KB-003", type: "general" },
  ],
  collectionsByBinder: {},
  bands: [{ key: "red", display: "Red" }],
};
const LINE = {
  lineId: "L1",
  binderId: "b3",
  binderName: "KB-003",
  bandKey: "red",
  bandDisplay: "Red",
  locale: "en" as const,
  filledBefore: 3,
  filledAfter: 3,
  total: 3,
};
const REPLACE: LinePopupModel = {
  mode: "replace",
  copyId: "new",
  card: { ...id("sv03.5-169", "Charmeleon", "169", 165), locale: "en" },
  line: LINE,
  stages: [
    { stageIndex: 0, stage: "Basic", state: "here", card: id("sv03-046", "Charmander", "046") },
    {
      stageIndex: 1,
      stage: "Stage1",
      state: "incoming",
      card: id("sv03.5-169", "Charmeleon", "169", 165),
    },
    { stageIndex: 2, stage: "Stage2", state: "here", card: id("sv03-028", "Charizard", "028") },
  ],
  existingLines: [],
  replace: {
    slotId: "S1",
    stageIndex: 1,
    current: {
      copyId: "old",
      card: id("sv03-027", "Charmeleon", "027"),
      where: "KB-003 · Back · Red",
    },
    incoming: {
      copyId: "new",
      card: id("sv03.5-169", "Charmeleon", "169", 165),
      where: "KB-001 · Front · Red",
    },
    defaultKeep: true,
    suggestedOutgoing: { kind: "bulk" },
  },
};
const PROPOSAL = { kind: "replace" as const, lineId: "L1", slotId: "S1", defaultKeep: true };

afterEach(cleanup);

function Harness(props: Partial<LinePopupProps> & { model: LinePopupModel; initial: LineChoice }) {
  const [value, setValue] = useState<LineChoice>(props.initial);
  return createElement(LinePopup, {
    onCancel: () => {},
    onConfirm: () => {},
    moveOptions: OPTIONS,
    ...props,
    value,
    onChange: setValue,
  });
}
const radio = (name: RegExp) => screen.getByRole("radio", { name }) as HTMLButtonElement;
const confirmBtn = () =>
  within(document.querySelector(".lp-foot") as HTMLElement)
    .getAllByRole("button")
    .at(-1)!;
const movesText = () => (document.querySelector(".lp-moves") as HTMLElement).textContent;

describe("REPLACE · opens on Keep, and nothing moves unless she picks Swap", () => {
  it("opens on Keep: the two cards side by side, 'What moves' says the line is untouched, Confirm is 'Keep'", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      createElement(Harness, {
        model: REPLACE,
        initial: defaultChoiceFor(PROPOSAL),
        onConfirm,
        keepLabel: "It stays in KB-001 · Front · Red. Nothing in the line moves.",
      }),
    );
    expect(screen.getByRole("dialog", { name: "A copy for a filled slot" })).toBeTruthy();
    expect(radio(/Keep 027\/197/).getAttribute("aria-checked")).toBe("true");
    expect(radio(/Swap in 169\/165/).getAttribute("aria-checked")).toBe("false");
    expect(document.querySelectorAll('[data-stage-state="replace"] .face.l')).toHaveLength(2);
    expect(movesText()).toContain("Stays put");
    expect(movesText()).toContain("stays in the line");
    expect(confirmBtn().textContent).toBe("Keep ▶");
    await user.click(confirmBtn());
    expect(onConfirm).toHaveBeenCalledWith({
      mode: "replace",
      lineId: "L1",
      slotId: "S1",
      keep: true,
    });
  });

  it("Swap: the card coming out goes to the bulk box unless she picks, in one step", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      createElement(Harness, { model: REPLACE, initial: defaultChoiceFor(PROPOSAL), onConfirm }),
    );
    await user.click(radio(/Swap in 169\/165/));
    const where = screen.getByRole("group", { name: /Where 027\/197 goes/ });
    expect(
      within(where)
        .getByRole("button", { name: /Bulk box/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(movesText()).toMatch(/Take out.*027\/197.*from KB-003 · Back · Red/);
    expect(movesText()).toMatch(/Shelve.*169\/165.*into its spot/);
    expect(movesText()).toMatch(/To bulk.*027\/197.*the bulk box/);
    expect(screen.getByText(/Line stays 3\/3 the whole time · one step, no gap/)).toBeTruthy();
    expect(confirmBtn().textContent).toBe("Swap them ▶");
    await user.click(confirmBtn());
    expect(onConfirm).toHaveBeenCalledWith({
      mode: "replace",
      lineId: "L1",
      slotId: "S1",
      keep: false,
      outgoing: { kind: "bulk" },
    });
  });

  it("the card coming out can go to a front half she picks on the Move sheet", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      createElement(Harness, { model: REPLACE, initial: defaultChoiceFor(PROPOSAL), onConfirm }),
    );
    await user.click(radio(/Swap in/));
    await user.click(screen.getByRole("button", { name: "A front half…" }));
    const sheet = await screen.findByRole("dialog", { name: "Move Charmeleon" });
    await user.click(within(sheet).getByRole("button", { name: "Place it here ▶" }));
    expect(screen.queryByRole("dialog", { name: "Move Charmeleon" })).toBeNull();
    expect(movesText()).toMatch(/Move.*027\/197.*KB-001 · Front · Red/);
    await user.click(confirmBtn());
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        keep: false,
        outgoing: { kind: "shelf", binderId: "b1", half: "front", band: "red" },
      }),
    );
  });

  it("…or into another line, through that card's own line popup, carried as its line choice", async () => {
    const onConfirm = vi.fn();
    const outgoingLineModel = vi.fn(async (): Promise<LinePopupModel> => ({
      mode: "start",
      copyId: "old",
      card: { ...id("sv03-027", "Charmeleon", "027"), locale: "en" },
      line: {
        ...LINE,
        lineId: null,
        binderId: "b1",
        binderName: "KB-001",
        filledBefore: 0,
        filledAfter: 1,
        total: 1,
      },
      stages: [
        {
          stageIndex: 0,
          stage: "Stage1",
          state: "incoming",
          card: id("sv03-027", "Charmeleon", "027"),
        },
      ],
      existingLines: [],
    }));
    const user = userEvent.setup();
    render(
      createElement(Harness, {
        model: REPLACE,
        initial: defaultChoiceFor(PROPOSAL),
        onConfirm,
        outgoingLineModel,
      }),
    );
    await user.click(radio(/Swap in/));
    await user.click(screen.getByRole("button", { name: "Another line…" }));
    await user.click(await screen.findByRole("button", { name: "BACK HALF" }));
    await screen.findByRole("dialog", { name: "Start a line" });
    expect(outgoingLineModel).toHaveBeenCalledWith({ kind: "start", binderId: "b1", band: "red" });
    await user.click(screen.getByRole("button", { name: /Start line/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Start a line" })).toBeNull());
    await user.click(confirmBtn());
    expect(onConfirm).toHaveBeenCalledWith({
      mode: "replace",
      lineId: "L1",
      slotId: "S1",
      keep: false,
      outgoing: { kind: "shelf", binderId: "b1", half: "back", band: "red" },
      outgoingLine: { mode: "start", binderId: "b1", band: "red", pulls: [] },
    });
  });

  it("no 'Another line…' without the loader for it", async () => {
    const user = userEvent.setup();
    render(createElement(Harness, { model: REPLACE, initial: defaultChoiceFor(PROPOSAL) }));
    await user.click(radio(/Swap in/));
    expect(screen.queryByRole("button", { name: "Another line…" })).toBeNull();
  });

  it("the holo upgrade opens pre-set to Swap, to bulk (defaultKeep false)", () => {
    const holo = { ...PROPOSAL, defaultKeep: false };
    render(
      createElement(Harness, {
        model: { ...REPLACE, replace: { ...REPLACE.replace!, defaultKeep: false } },
        initial: defaultChoiceFor(holo),
      }),
    );
    expect(radio(/Swap in/).getAttribute("aria-checked")).toBe("true");
    expect(confirmBtn().textContent).toBe("Swap them ▶");
  });

  it("a Keep with a picker (a holo kept out of a line): the incoming card's place is hers to pick, bulk suggested", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      createElement(Harness, {
        model: REPLACE,
        initial: {
          mode: "replace",
          lineId: "L1",
          slotId: "S1",
          keep: true,
          incoming: { kind: "bulk" },
        },
        keepDestination: { kind: "bulk" },
        onConfirm,
      }),
    );
    const where = screen.getByRole("group", { name: /Where 169\/165 goes/ });
    expect(
      within(where)
        .getByRole("button", { name: /Bulk box/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    // No "Another line…" for a card staying OUT of the line.
    expect(within(where).queryByRole("button", { name: "Another line…" })).toBeNull();
    await user.click(confirmBtn());
    expect(onConfirm).toHaveBeenCalledWith({
      mode: "replace",
      lineId: "L1",
      slotId: "S1",
      keep: true,
      incoming: { kind: "bulk" },
    });
  });

  it("a swap in another language waits for her second tick", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      createElement(Harness, {
        model: { ...REPLACE, card: { ...REPLACE.card, locale: "ja" } },
        initial: defaultChoiceFor(PROPOSAL),
        onConfirm,
      }),
    );
    // On Keep, nothing joins the line, so there is nothing to confirm.
    expect(screen.queryByText(/Join the English line anyway/)).toBeNull();
    await user.click(radio(/Swap in/));
    expect((confirmBtn() as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: /Join the English line anyway/ }));
    await user.click(confirmBtn());
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ keep: false, foreignLocale: true }),
    );
  });
});

describe("UIL-069 · a colour mismatch on an Add picks neither option for her", () => {
  const ADD: LinePopupModel = {
    mode: "add",
    copyId: "new",
    card: { ...id("sv03-027", "Charmeleon", "027"), locale: "en" },
    line: { ...LINE, bandKey: "green", bandDisplay: "Green", filledBefore: 1, filledAfter: 2 },
    stages: [
      { stageIndex: 0, stage: "Basic", state: "here", card: id("sv03-046", "Charmander", "046") },
      {
        stageIndex: 1,
        stage: "Stage1",
        state: "incoming",
        card: id("sv03-027", "Charmeleon", "027"),
      },
    ],
    existingLines: [],
  };
  function ColourHarness(props: { onConfirm: () => void; onConfirmOwn: () => void }) {
    const [picked, setPicked] = useState<"line" | "own" | null>(null);
    const colourChoice: LinePopupColourChoice = {
      cardBand: { key: "red", display: "Red" },
      lineBand: { key: "green", display: "Green" },
      addSub: "takes the line's colour · KB-003 · Back · Green, into its Stage 1 slot",
      ownSub: "KB-001 · Front · Red · not in a line",
      picked,
      onPick: setPicked,
      onConfirmOwn: props.onConfirmOwn,
    };
    return createElement(Harness, {
      model: ADD,
      initial: { mode: "join", lineId: "L1", slotId: "S1" },
      onConfirm: props.onConfirm,
      colourChoice,
    });
  }

  it("neither is picked; Confirm waits; the incoming card reads 'If you add it'", () => {
    render(createElement(ColourHarness, { onConfirm: vi.fn(), onConfirmOwn: vi.fn() }));
    expect(screen.getByText(/This card is/).textContent).toMatch(/Red; this line is.*Green/);
    expect(radio(/Add to the Green line/).getAttribute("aria-checked")).toBe("false");
    expect(radio(/File by its own colour/).getAttribute("aria-checked")).toBe("false");
    expect((confirmBtn() as HTMLButtonElement).disabled).toBe(true);
    expect(movesText()).toBe("Pick one above.");
    expect(screen.getByText("If you add it")).toBeTruthy();
  });

  it("'Add to the Green line' is a join: Confirm 'Add to line' sends her choice", async () => {
    const onConfirm = vi.fn();
    const onConfirmOwn = vi.fn();
    const user = userEvent.setup();
    render(createElement(ColourHarness, { onConfirm, onConfirmOwn }));
    await user.click(radio(/Add to the Green line/));
    expect(confirmBtn().textContent).toBe("Add to line ▶");
    await user.click(confirmBtn());
    expect(onConfirm).toHaveBeenCalledWith({ mode: "join", lineId: "L1", slotId: "S1" });
    expect(onConfirmOwn).not.toHaveBeenCalled();
  });

  it("'File by its own colour' is the screen's write, not a line: the slot is wanted again, with no ring", async () => {
    const onConfirm = vi.fn();
    const onConfirmOwn = vi.fn();
    const user = userEvent.setup();
    render(createElement(ColourHarness, { onConfirm, onConfirmOwn }));
    await user.click(radio(/File by its own colour/));
    expect(confirmBtn().textContent).toBe("File in front half ▶");
    expect(movesText()).toMatch(/Charmeleon → KB-001 · Front · Red · not in a line/);
    expect(document.querySelector(".lp-slot.lp-in")).toBeNull();
    expect(document.querySelector('[data-stage-state="wanted"]')).not.toBeNull();
    await user.click(confirmBtn());
    expect(onConfirmOwn).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
