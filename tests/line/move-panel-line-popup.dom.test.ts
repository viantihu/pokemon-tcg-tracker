// @vitest-environment jsdom
/**
 * UIL-117 PR 2 — the Move sheet opens the ONE line popup (mockup v3 section 2): "picking 'Back half' will open the
 * popup instead" of the inline line chips, on every screen that passes the popup's loader (Lines, Lookup,
 * Collections). Her confirm there IS the move, sent with her choice; a sheet without the loader is unchanged.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MovePanel } from "@/app/(ui)/_components/MovePanel";
import { MoveOverlay } from "@/app/(ui)/_components/MoveOverlay";
import type { LinePopupModel, LineProposal } from "@/lib/line/popup";
import type { LineJoinCandidate, MoveOptions } from "@/lib/line/types";

const OPTIONS: MoveOptions = {
  binders: [
    { id: "b1", name: "KB-001", type: "general" },
    { id: "b2", name: "KB-002", type: "general" },
  ],
  collectionsByBinder: {},
  bands: [
    { key: "red", display: "Red" },
    { key: "green", display: "Green" },
  ],
};
const CANDIDATE_HERE: LineJoinCandidate = {
  lineId: "L1",
  slotId: "S1",
  binderId: "b1",
  bandKey: "red",
  speciesLabel: "CHARIZARD LINE",
  stage: "Stage1",
  filledCount: 1,
  totalCount: 3,
};
const model = (mode: "start" | "add", band = "red"): LinePopupModel => ({
  mode,
  copyId: "moving",
  card: {
    tcgdexId: "sv03-027",
    name: "Charmeleon",
    setId: "sv03",
    setName: "Obsidian Flames",
    localId: "027",
    imageUrl: null,
    bandKey: "red",
    locale: "en",
  },
  line: {
    lineId: mode === "add" ? "L1" : null,
    binderId: "b1",
    binderName: "KB-001",
    bandKey: band,
    bandDisplay: band === "red" ? "Red" : "Green",
    locale: "en",
    filledBefore: mode === "add" ? 1 : 0,
    filledAfter: mode === "add" ? 2 : 1,
    total: 3,
  },
  stages: [{ stageIndex: 1, stage: "Stage1", state: "incoming", card: null }],
  existingLines: [],
});

afterEach(cleanup);

function mount(over: Partial<Parameters<typeof MovePanel>[0]> = {}) {
  const onConfirm = vi.fn();
  const lineModel = vi.fn(async (p: LineProposal) =>
    p.kind === "start"
      ? model("start", p.band)
      : model("add", p.kind === "add" && p.slotId === "S2" ? "green" : "red"),
  );
  const user = userEvent.setup();
  render(
    createElement(MovePanel, {
      options: OPTIONS,
      naturalBandKey: "red",
      lineModel,
      onConfirm,
      ...over,
    }),
  );
  return { onConfirm, lineModel, user };
}
const backHalf = () => screen.getByRole("button", { name: "BACK HALF" }) as HTMLButtonElement;

describe("UIL-117 · BACK HALF opens the line popup", () => {
  it("with no line here to add to, it opens on STARTING one in this binder and band", async () => {
    const { lineModel, user } = mount();
    expect(backHalf().disabled).toBe(false); // no longer greyed: the popup is how a line is picked
    await user.click(backHalf());
    await screen.findByRole("dialog", { name: "Start a line" });
    expect(lineModel).toHaveBeenCalledWith({ kind: "start", binderId: "b1", band: "red" });
  });

  it("with an open slot for this card in this binder and band, it opens on ADDING to that line", async () => {
    const { lineModel, user } = mount({ joinCandidates: [CANDIDATE_HERE] });
    await user.click(backHalf());
    await screen.findByRole("dialog", { name: "Add to a line" });
    expect(lineModel).toHaveBeenCalledWith({ kind: "add", lineId: "L1", slotId: "S1" });
  });

  it("her confirm in the popup IS the move: a back-half shelf in the line's binder and band, with her choice", async () => {
    const { onConfirm, user } = mount({ joinCandidates: [CANDIDATE_HERE] });
    await user.click(backHalf());
    await screen.findByRole("dialog", { name: "Add to a line" });
    await user.click(screen.getByRole("button", { name: /Add to line/ }));
    // The popup names its line as a third argument (UX review of #434).
    expect(onConfirm.mock.calls[0].slice(0, 2)).toEqual([
      { kind: "shelf", binderId: "b1", half: "back", band: "red" },
      { mode: "join", lineId: "L1", slotId: "S1" },
    ]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a host that writes on confirm keeps the popup open and busy until it answers, and a refusal is shown in it (UX review of #434)", async () => {
    let answer: (v: string | void) => void = () => {};
    const onConfirm = vi.fn(
      () =>
        new Promise<string | void>((resolve) => {
          answer = resolve;
        }),
    );
    const { user } = mount({ joinCandidates: [CANDIDATE_HERE], onConfirm });
    await user.click(backHalf());
    await screen.findByRole("dialog", { name: "Add to a line" });
    const confirm = screen.getByRole("button", { name: /Add to line/ }) as HTMLButtonElement;
    await user.click(confirm);
    // Busy while the write is in flight: still open, and her confirm cannot be pressed twice.
    expect(screen.getByRole("dialog", { name: "Add to a line" })).toBeTruthy();
    await waitFor(() => expect(confirm.disabled).toBe(true));
    answer("That slot has already been filled — reload the screen and pick again.");
    // PRE-FIX: the popup closed before the write, and the refusal had nowhere to be said.
    expect(
      await screen.findByText(
        "That slot has already been filled — reload the screen and pick again.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Add to a line" })).toBeTruthy();
    await waitFor(() => expect(confirm.disabled).toBe(false));
    // A second try that lands closes it.
    await user.click(confirm);
    answer();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it("opens with the card she already owns UNTICKED, so an untouched confirm pulls nothing (UIL-061)", async () => {
    const withPull: LinePopupModel = {
      ...model("start"),
      stages: [
        {
          stageIndex: 0,
          stage: "Basic",
          state: "pullable",
          card: { ...model("start").card, tcgdexId: "sv03-026", name: "Charmander" },
          pull: { copyId: "owned-cmd", fromLabel: "KB-001 · Front · Red" },
        },
        { stageIndex: 1, stage: "Stage1", state: "incoming", card: null },
      ],
    };
    const { onConfirm, user } = mount({ lineModel: vi.fn(async () => withPull) });
    await user.click(backHalf());
    const pull = (await screen.findByRole("checkbox", {
      name: /Pull it into this line/,
    })) as HTMLInputElement;
    expect(pull.checked).toBe(false);
    // UIL-121: that unticked stage is hers to decide; she leaves it empty.
    await user.click(screen.getByRole("button", { name: "Leave empty" }));
    await user.click(screen.getByRole("button", { name: /Start line/ }));
    // The popup names its line as a third argument (UX review of #434).
    expect(onConfirm.mock.calls[0].slice(0, 2)).toEqual([
      { kind: "shelf", binderId: "b1", half: "back", band: "red" },
      { mode: "start", binderId: "b1", band: "red", pulls: [], stages: { 0: { kind: "empty" } } },
    ]);
  });

  it("the band is picked IN the popup: another band reloads it there, and her confirm moves it into that band", async () => {
    const { lineModel, onConfirm, user } = mount();
    await user.click(backHalf());
    await screen.findByRole("dialog", { name: "Start a line" });
    const group = screen.getByRole("group", { name: "Colour band" });
    await user.click(within(group).getByRole("button", { name: /Green/ }));
    expect(lineModel).toHaveBeenLastCalledWith({ kind: "start", binderId: "b1", band: "green" });
    await waitFor(() =>
      expect(
        within(screen.getByRole("group", { name: "Colour band" }))
          .getByRole("button", { name: /Green/ })
          .getAttribute("aria-pressed"),
      ).toBe("true"),
    );
    await user.click(screen.getByRole("button", { name: /Start line/ }));
    // The popup names its line as a third argument (UX review of #434).
    expect(onConfirm.mock.calls[0].slice(0, 2)).toEqual([
      { kind: "shelf", binderId: "b1", half: "back", band: "green" },
      { mode: "start", binderId: "b1", band: "green", pulls: [], stages: {} },
    ]);
  });

  it("a band where this card has an open slot in this binder reloads it as ADD to that line", async () => {
    const GREEN_SLOT: LineJoinCandidate = { ...CANDIDATE_HERE, slotId: "S2", bandKey: "green" };
    const { lineModel, user } = mount({ joinCandidates: [GREEN_SLOT] });
    await user.click(backHalf());
    await screen.findByRole("dialog", { name: "Start a line" });
    await user.click(
      within(screen.getByRole("group", { name: "Colour band" })).getByRole("button", {
        name: /Green/,
      }),
    );
    await screen.findByRole("dialog", { name: "Add to a line" });
    expect(lineModel).toHaveBeenLastCalledWith({ kind: "add", lineId: "L1", slotId: "S2" });
  });

  it("an Add reached through 'Add to that line' moves it into THAT line's binder and band, not the sheet's (QA U1)", async () => {
    const elsewhere = {
      lineId: "L9",
      speciesLabel: "Charizard",
      filledCount: 1,
      totalCount: 3,
      binderId: "b2",
      bandKey: "green",
      locale: "en" as const,
      binderName: "KB-002",
      bandDisplay: "Green",
      joinSlotId: "S9",
      sameHere: false,
    };
    const lineModel = vi.fn(async (p: LineProposal): Promise<LinePopupModel> =>
      p.kind === "add"
        ? {
            ...model("add", "green"),
            line: {
              ...model("add", "green").line,
              lineId: "L9",
              binderId: "b2",
              binderName: "KB-002",
            },
          }
        : { ...model("start"), existingLines: [elsewhere] },
    );
    const { onConfirm, user } = mount({ lineModel });
    await user.click(backHalf());
    await screen.findByRole("dialog", { name: "Start a line" });
    await user.click(screen.getAllByRole("button", { name: "Add it there instead" })[0]);
    await screen.findByRole("dialog", { name: "Add to a line" });
    await user.click(screen.getByRole("button", { name: /Add to line/ }));
    // The sheet still says KB-001 · red; the line is in KB-002 · green, and that is where the card goes.
    // The popup names its line as a third argument (UX review of #434).
    expect(onConfirm.mock.calls[0].slice(0, 2)).toEqual([
      { kind: "shelf", binderId: "b2", half: "back", band: "green" },
      { mode: "join", lineId: "L9", slotId: "S9" },
    ]);
  });

  it("Escape closes the popup, not the Move sheet behind it; a second Escape closes the sheet", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      createElement(MoveOverlay, {
        card: {
          copyId: "moving",
          name: "Charmeleon",
          localId: "027",
          imageUrl: null,
          bandKey: "red",
          currentLabel: "KB-001 · Front · Red",
          naturalBandKey: "red",
        },
        options: OPTIONS,
        lineModel: vi.fn(async () => model("start")),
        onConfirm: vi.fn(),
        onClose,
      }),
    );
    await user.click(backHalf());
    await screen.findByRole("dialog", { name: "Start a line" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Start a line" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Cancel closes the popup and nothing moves", async () => {
    const { onConfirm, user } = mount();
    await user.click(backHalf());
    await screen.findByRole("dialog", { name: "Start a line" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("a refusal loading the line is shown on the sheet, in its words", async () => {
    const { user } = mount({
      lineModel: vi.fn(async () => {
        throw new Error("That card is no longer in the collection.");
      }),
    });
    await user.click(backHalf());
    expect(await screen.findByText("That card is no longer in the collection.")).toBeTruthy();
  });

  it("a sheet WITHOUT the popup's loader is unchanged: the back half still needs a line picked elsewhere", () => {
    mount({ lineModel: undefined });
    expect(backHalf().disabled).toBe(true);
  });
});
