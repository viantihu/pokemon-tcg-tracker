// @vitest-environment jsdom
/**
 * UIL-106 (2, 3) — Lookup when an action cannot reach the server at all.
 *
 * A server action THROWS when the app was redeployed under an open page or the connection dropped. Remove,
 * "Same card" and Move set `moving` and awaited the action with nothing to catch a throw, so `moving` never
 * cleared: every button on her copies stayed disabled and nothing said why. Opening Move threw out of the
 * click with no word at all. Driven through the REAL screen in a DOM, each action scripted to reject.
 *
 * The pick (CardResultsGrid) and the Move sheet are stood in for, so that a click reaches the handler under
 * test directly: what is pinned here is the screen's handling of the call, not the picker.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MoveDestination } from "@/lib/line/types";
import type { LookupAnswer } from "@/lib/surfaces";
import type { LookupMovableCopy } from "@/app/(ui)/look/lookup-copies";
import { LOST } from "@/app/(ui)/_components/reach";
import { LookupScreen } from "@/app/(ui)/look/LookupScreen";

const DEST: MoveDestination = { kind: "shelf", binderId: "b1", half: "back", band: "red" };

vi.mock("@/app/(ui)/_components/CardResultsGrid", async () => {
  const { createElement: h } = await import("react");
  return {
    CardResultsGrid: ({ onPick }: { onPick: (c: { tcgdexId: string }) => void }) =>
      h("button", { type: "button", onClick: () => onPick({ tcgdexId: "sv03-027" }) }, "Pick it"),
  };
});
vi.mock("@/app/(ui)/_components/MoveOverlay", async () => {
  const { createElement: h } = await import("react");
  return {
    MoveOverlay: ({ onConfirm }: { onConfirm: (d: MoveDestination) => void }) =>
      h("div", { role: "dialog" }, [
        h("button", { key: "c", type: "button", onClick: () => onConfirm(DEST) }, "Place it"),
      ]),
  };
});

const lookupAnswer = vi.fn();
const lookupMoveOptions = vi.fn();
const mergeCopies = vi.fn();
const moveFromLookup = vi.fn();
const removeCopy = vi.fn();
vi.mock("@/app/(ui)/look/actions", () => ({
  lookupAnswer: (...a: unknown[]) => lookupAnswer(...a),
  lookupMoveOptions: (...a: unknown[]) => lookupMoveOptions(...a),
  mergeCopies: (...a: unknown[]) => mergeCopies(...a),
  moveFromLookup: (...a: unknown[]) => moveFromLookup(...a),
  removeCopy: (...a: unknown[]) => removeCopy(...a),
  searchCatalog: vi.fn(async () => []),
}));

const LOST_CALL = () => new TypeError("Failed to fetch");

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
  location: { binderName: "Main", half: "BACK HALF", bandDisplay: "Red" },
  facts: [],
};
/** Her Meditite shape (UIL-089): a copy she placed by hand beside the import's twin, so "Same card" shows. */
const COPIES: LookupMovableCopy[] = [
  {
    copyId: "c-hand",
    role: "shelved",
    currentLabel: "Main · Back · Red",
    initial: { kind: "shelf", binderId: "b1", half: "back", band: "red" },
    dexTracked: false,
  },
  { copyId: "c-dex", role: "haul", currentLabel: "In your haul", dexTracked: true },
];

async function mountWithAnswer() {
  const user = userEvent.setup();
  render(createElement(LookupScreen));
  await user.click(screen.getByRole("button", { name: "Pick it" }));
  await screen.findByText("Charmeleon");
  return user;
}

const moveButtons = () => screen.getAllByRole("button", { name: "Move" }) as HTMLButtonElement[];
const alerts = () =>
  screen
    .queryAllByRole("alert")
    .map((a) => a.textContent)
    .join(" | ");
/** Her copies are answerable again: no button on them is left disabled by a call that never came back. */
const copiesAnswer = () => moveButtons().every((b) => !b.disabled);

beforeEach(() => {
  for (const f of [lookupAnswer, lookupMoveOptions, mergeCopies, moveFromLookup, removeCopy])
    f.mockReset();
  lookupAnswer.mockResolvedValue({ ok: true, answer: ANSWER, copies: COPIES });
  lookupMoveOptions.mockResolvedValue({
    ok: true,
    options: { binders: [], collectionsByBinder: {}, bands: [] },
  });
});
afterEach(cleanup);

describe("UIL-106 · a Lookup action that cannot reach the server ends in a message", () => {
  it("Remove: says so, and her copies answer again", async () => {
    removeCopy.mockRejectedValue(LOST_CALL());
    const user = await mountWithAnswer();

    await user.click(screen.getAllByRole("button", { name: "Remove this copy" })[0]);
    await user.click(screen.getByRole("button", { name: /Yes, remove/ }));

    await waitFor(() => expect(alerts()).toContain(LOST.action));
    // PRE-FIX: `moving` stayed true, so every button on her copies stayed disabled, with no message.
    expect(copiesAnswer()).toBe(true);
    expect(screen.getAllByRole("button", { name: "Remove this copy" })).toHaveLength(2);
  });

  it("Same card: says so, and her copies answer again", async () => {
    mergeCopies.mockRejectedValue(LOST_CALL());
    const user = await mountWithAnswer();

    await user.click(screen.getByRole("button", { name: "Same card" }));

    await waitFor(() => expect(alerts()).toContain(LOST.action));
    expect(copiesAnswer()).toBe(true);
  });

  it("Move, when the options cannot be read: says so, as a read, and opens no sheet", async () => {
    lookupMoveOptions.mockRejectedValue(LOST_CALL());
    const user = await mountWithAnswer();

    await user.click(moveButtons()[0]);

    // A read changed nothing, so it does not ask her to check whether anything went through.
    await waitFor(() => expect(alerts()).toContain(LOST.read));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(copiesAnswer()).toBe(true);
  });

  it("Move, when the move cannot be sent: the sheet closes, it says so, and her copies answer again", async () => {
    moveFromLookup.mockRejectedValue(LOST_CALL());
    const user = await mountWithAnswer();

    await user.click(moveButtons()[0]);
    await user.click(await screen.findByRole("button", { name: "Place it" }));

    await waitFor(() => expect(alerts()).toContain(LOST.action));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(copiesAnswer()).toBe(true);
  });

  it("the lookup itself: COULD NOT LOOK THIS UP, in the family's words, never NO MATCH", async () => {
    lookupAnswer.mockRejectedValue(LOST_CALL());
    const user = userEvent.setup();
    render(createElement(LookupScreen));
    await user.click(screen.getByRole("button", { name: "Pick it" }));

    // PRE-FIX: the raw "Failed to fetch".
    await waitFor(() => expect(alerts()).toContain(LOST.read));
    expect(alerts()).not.toContain("Failed to fetch");
    expect(screen.queryByText(/No match/i)).toBeNull();
  });

  it("an answer the server gives is still shown in its own words", async () => {
    removeCopy.mockResolvedValue({ ok: false, error: "That copy is already gone." });
    const user = await mountWithAnswer();
    await user.click(screen.getAllByRole("button", { name: "Remove this copy" })[0]);
    await user.click(screen.getByRole("button", { name: /Yes, remove/ }));
    await waitFor(() => expect(alerts()).toContain("That copy is already gone."));
    expect(alerts()).not.toContain(LOST.action);
  });
});
