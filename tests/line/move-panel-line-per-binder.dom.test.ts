// @vitest-environment jsdom
/**
 * UIL-096, the sheet — starting a new line where the family already has one is a WARNING, never a block.
 *
 * Karvi, verbatim: "the Toedscruel issue is still there. I'm not able to create a new line for it. Instead
 * of blocking the creation of an evolution line, I want a warning that there is a line existing in my
 * ENTIRE collection (not just the binder)."
 *
 * Under UIL-084 this panel refused a second line for one species in one band in one binder: it disabled
 * Confirm and said "a second line here cannot be saved", because the server refused it too. Her Toedscruel
 * is exactly that shape — its Toedscool line in KB-001, Orange, has its Stage 1 already filled, so there
 * is no slot to join — and the back half had nowhere to take it. Now the panel names every line the family
 * has, anywhere in the collection, and offers the two things she can do: join one that has a slot open for
 * this card, or start a new line anyway (Confirm, relabelled to say so).
 *
 * Driven through the real `MovePanel` in a DOM (QA's rule for a click path): chips are clicked, and what she
 * can confirm, what the warning says, and what the host receives are all asserted.
 */
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExistingLineBlock, LineJoinCandidate, MoveOptions } from "@/lib/line/types";
import { buildLineJoinIndex, joinOptionsFor } from "@/lib/line/join-options";
import { MovePanel } from "@/app/(ui)/_components/MovePanel";
import { CHARMANDER_SV03_026, CHARMELEON_SV03_027 } from "../engine/fixtures";

/** Two general binders: KB-001 holds the family's Orange line, KB-002 is the other one she fills. */
const OPTIONS: MoveOptions = {
  binders: [
    { id: "kb1", name: "KB-001", type: "general" },
    { id: "kb2", name: "KB-002", type: "general" },
  ],
  collectionsByBinder: {},
  bands: [
    { key: "orange", display: "Orange" },
    { key: "red", display: "Red fire" },
  ],
};

/** Her line: the Orange TOEDSCOOL line in KB-001, every stage filled — so there is no slot to join. */
const IN_KB1: ExistingLineBlock = {
  lineId: "L1",
  speciesLabel: "TOEDSCOOL LINE",
  filledCount: 2,
  totalCount: 2,
  binderId: "kb1",
  bandKey: "orange",
  locale: "en",
};
/** Same family, same band, ANOTHER binder, with its Stage 1 open. */
const IN_KB2: ExistingLineBlock = { ...IN_KB1, lineId: "L2", binderId: "kb2", filledCount: 1 };
/** Same family, same binder, ANOTHER band. */
const RED_IN_KB1: ExistingLineBlock = { ...IN_KB1, lineId: "L3", bandKey: "red" };
/** Same family, same binder and band, the OTHER regional variant — named, but not joinable. */
const JA_IN_KB1: ExistingLineBlock = { ...IN_KB1, lineId: "L4", locale: "ja" };

const openSlot = (line: ExistingLineBlock, slotId: string): LineJoinCandidate => ({
  lineId: line.lineId,
  slotId,
  binderId: line.binderId,
  bandKey: line.bandKey,
  speciesLabel: line.speciesLabel,
  stage: "Stage1",
  filledCount: line.filledCount,
  totalCount: line.totalCount,
});

function mount(over: Partial<Parameters<typeof MovePanel>[0]> = {}) {
  const onConfirm = vi.fn();
  const user = userEvent.setup();
  render(
    createElement(MovePanel, {
      options: OPTIONS,
      naturalBandKey: "orange",
      allowLineJoin: true,
      cardLocale: "en",
      joinCandidates: [], // her case: the line's matching stage is filled, so nothing to join
      existingLines: [IN_KB1],
      onConfirm,
      ...over,
    }),
  );
  return { onConfirm, user };
}

const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const newLine = () => button(/^\+ Start a new line/);
const anyway = () => button("Start a new line anyway ▶");
const plain = () => button("Place it here ▶");
const warning = () => screen.queryByRole("status");

afterEach(cleanup);

describe("UIL-084 · the new-line chip names the binder it would start the line in", () => {
  it("reads 'in KB-001' on the binder that is selected, and follows her to KB-002", async () => {
    const { user } = mount();
    expect(newLine().textContent).toContain("in KB-001");
    await user.click(button("KB-002"));
    expect(newLine().textContent).toContain("in KB-002");
  });
});

describe("UIL-096 · her Toedscruel: a warning, and she can still start the line", () => {
  it("names the existing line, says joining is not possible, and lets her START the line anyway", async () => {
    // PRE-FIX: Confirm was disabled here, under "a second line here cannot be saved".
    const { onConfirm, user } = mount();
    await user.click(newLine());

    const w = warning()!;
    expect(w).toBeTruthy();
    expect(w.textContent).toContain("You already have a TOEDSCOOL LINE in your collection");
    expect(w.textContent).toContain("KB-001 · Orange · 2/2 filled — this binder, this band");
    // Its Stage 1 is filled, so offering a join would be a button that cannot work.
    expect(w.textContent).toContain("joining is not possible");
    expect(screen.queryByRole("button", { name: /Join that line/ })).toBeNull();

    expect(anyway().disabled).toBe(false);
    await user.click(anyway());
    expect(onConfirm).toHaveBeenCalledWith({
      kind: "shelf",
      binderId: "kb1",
      half: "back",
      band: "orange",
      lineJoin: { mode: "new" },
    });
  });

  it("the old refusal text is gone", async () => {
    const { user } = mount();
    await user.click(newLine());
    expect(screen.queryByText(/cannot be saved/)).toBeNull();
    expect(screen.queryByText(/one binder tracks a species once per band/)).toBeNull();
    expect(screen.queryByText(/reload the screen and join it instead/)).toBeNull();
  });
});

describe("UIL-096 · the warning names the WHOLE collection, not the binder", () => {
  it("every binder, every band and both regional variants, each saying where it is relative to her pick", async () => {
    const { user } = mount({ existingLines: [RED_IN_KB1, IN_KB2, JA_IN_KB1, IN_KB1] });
    await user.click(newLine());
    const items = [...warning()!.querySelectorAll("li")].map((li) => li.textContent);

    expect(items).toHaveLength(4);
    // The per-binder match leads: it is the default suggestion the old rule has become.
    expect(items[0]).toBe("KB-001 · Orange · 2/2 filled — this binder, this band");
    expect(items).toContain("KB-002 · Orange · 1/2 filled — same band, another binder");
    expect(items).toContain("KB-001 · Red fire · 2/2 filled — another band");
    // The other regional variant is named and tagged — she asked for all of them — but it is not "this
    // binder, this band": an English card cannot join a Japanese line (UIL-090).
    expect(items).toContain("KB-001 · Orange · 2/2 filled · JA — same band, another binder");
    expect(warning()!.textContent).toContain("You already have 4 TOEDSCOOL LINES");
  });

  it("no existing line anywhere means no warning and the ordinary Confirm", async () => {
    const { user } = mount({ existingLines: [] });
    await user.click(newLine());
    expect(warning()).toBeNull();
    expect(plain().disabled).toBe(false);
  });

  it("the front half involves no line, so no warning", async () => {
    const { onConfirm, user } = mount();
    await user.click(button("FRONT HALF"));
    expect(warning()).toBeNull();
    await user.click(plain());
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ binderId: "kb1", half: "front", band: "orange" }),
    );
  });
});

describe("UIL-096 · the other choice: join a line that has a slot for this card", () => {
  it("offers to join the joinable line, and joining sends the existing-line choice instead", async () => {
    const { onConfirm, user } = mount({
      existingLines: [IN_KB1, IN_KB2],
      joinCandidates: [openSlot(IN_KB2, "s2")],
    });
    await user.click(newLine());
    // KB-001's line is full; KB-002's has its Stage 1 open, so that is the join on offer.
    await user.click(button(/Join that line · STAGE1 slot/));

    // Joining is not starting a line, so the warning goes and Confirm is the ordinary one again.
    expect(warning()).toBeNull();
    await user.click(plain());
    expect(onConfirm).toHaveBeenCalledWith({
      kind: "shelf",
      binderId: "kb2",
      half: "back",
      band: "orange",
      lineJoin: { mode: "existing", lineId: "L2", slotId: "s2" },
    });
  });

  it("the per-binder match is the suggested join when it is joinable — a suggestion, not a rule", async () => {
    const { onConfirm, user } = mount({
      existingLines: [IN_KB2, { ...IN_KB1, filledCount: 1 }],
      joinCandidates: [openSlot(IN_KB2, "s2"), openSlot({ ...IN_KB1, filledCount: 1 }, "s1")],
    });
    await user.click(newLine());
    await user.click(button(/Join that line/));
    await user.click(plain());
    // KB-001, the binder she is in, wins over KB-002 even though KB-002 was listed first.
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        binderId: "kb1",
        lineJoin: { mode: "existing", lineId: "L1", slotId: "s1" },
      }),
    );
  });

  it("and she can still ignore the suggestion and start the line anyway", async () => {
    const { onConfirm, user } = mount({
      existingLines: [IN_KB2],
      joinCandidates: [openSlot(IN_KB2, "s2")],
    });
    await user.click(newLine());
    await user.click(anyway());
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ binderId: "kb1", lineJoin: { mode: "new" } }),
    );
  });
});

/**
 * QA's survivor, in its PRODUCT form: after one "Start a new line anyway", the family has TWO lines in one
 * binder, band and locale, and the open slot is in the second. Driven through the REAL `joinOptionsFor`
 * into the real panel — a hand-built `existingLines` fixture would not notice `joinOptionsFor` collapsing
 * the two to one per key, which is the mutation this exists to kill.
 */
describe("UIL-096 · two lines sharing a binder, band and locale — the second holds the open slot", () => {
  it("both are named, and the one with the open slot is the join on offer", async () => {
    const root = CHARMANDER_SV03_026.dexId[0];
    const slot = (id: string, i: number, stage: string, state: string) => ({
      id,
      stage_index: i,
      stage,
      state,
      target_catalog_card_id: "sv03-027",
    });
    const index = buildLineJoinIndex(
      [
        { id: "L1", rootDexId: root, colorBand: "red", binderId: "kb1" },
        { id: "L2", rootDexId: root, colorBand: "red", binderId: "kb1" },
      ],
      new Map([
        ["L1", [slot("a0", 0, "Basic", "filled"), slot("a1", 1, "Stage1", "filled")]],
        ["L2", [slot("b0", 0, "Basic", "filled"), slot("b1", 1, "Stage1", "placeholder")]],
      ]),
      [CHARMANDER_SV03_026, CHARMELEON_SV03_027],
      () => null,
    );
    const opts = joinOptionsFor(CHARMELEON_SV03_027, index, { Fire: "red" }, [
      CHARMANDER_SV03_026,
      CHARMELEON_SV03_027,
    ])!;

    const { onConfirm, user } = mount({
      naturalBandKey: "red",
      existingLines: opts.existingLines,
      joinCandidates: opts.joinCandidates,
    });
    await user.click(newLine());
    // Both lines are in the warning — collapsed to one per key, only L1 would be.
    expect(warning()!.querySelectorAll("li")).toHaveLength(2);

    // The join is the SECOND line's open slot. With L2 dropped from the list, no join would be offered and
    // she would be told joining is not possible while a slot stood open.
    await user.click(button(/Join that line · STAGE1 slot/));
    await user.click(plain());
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ lineJoin: { mode: "existing", lineId: "L2", slotId: "b1" } }),
    );
  });
});
