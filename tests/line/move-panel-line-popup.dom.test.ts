// @vitest-environment jsdom
/**
 * UIL-117 PR 2 — the Move sheet opens the ONE line popup (mockup v3 section 2): "picking 'Back half' will open the
 * popup instead" of the inline line chips, on every screen that passes the popup's loader (Lines, Lookup,
 * Collections). Her confirm there IS the move, sent with her choice; a sheet without the loader is unchanged.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MovePanel } from "@/app/(ui)/_components/MovePanel";
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
const model = (mode: "start" | "add"): LinePopupModel => ({
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
    bandKey: "red",
    bandDisplay: "Red",
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
  const lineModel = vi.fn(async (p: LineProposal) => model(p.kind === "add" ? "add" : "start"));
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
    expect(onConfirm).toHaveBeenCalledWith(
      { kind: "shelf", binderId: "b1", half: "back", band: "red" },
      { mode: "join", lineId: "L1", slotId: "S1" },
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
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
    await user.click(screen.getByRole("button", { name: /Start line/ }));
    expect(onConfirm).toHaveBeenCalledWith(
      { kind: "shelf", binderId: "b1", half: "back", band: "red" },
      { mode: "start", binderId: "b1", band: "red", pulls: [] },
    );
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
