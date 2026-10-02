// @vitest-environment jsdom
/**
 * 0037 (the Tech Lead's call on #453's UI) — the Move sheet knows which box the card is already in. Lookup opens a
 * bulk card's Move on its own box; a card already in a 60-of-60 box is not "1 over", and its own box is not full for
 * it: no warning, no "Add anyway", and no override sent. Any OTHER full box is still an Add anyway (the card goes in).
 * The real Lookup screen and Move sheet in a DOM; only the server actions are stood in for.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LookupAnswer } from "@/lib/surfaces";
import type { LookupMovableCopy } from "@/app/(ui)/look/lookup-copies";
import { LookupScreen } from "@/app/(ui)/look/LookupScreen";

vi.mock("@/app/(ui)/_components/CardResultsGrid", async () => {
  const { createElement: h } = await import("react");
  return {
    CardResultsGrid: ({ onPick }: { onPick: (c: { tcgdexId: string }) => void }) =>
      h("button", { type: "button", onClick: () => onPick({ tcgdexId: "sv03-027" }) }, "Pick it"),
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
vi.mock("@/app/(ui)/_components/line-popup-actions", () => ({ lineModelAction: vi.fn() }));

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
  ownedCount: 1,
  location: { binderName: "Bulk box", half: "BULK", bandDisplay: "Red" },
  facts: [],
};
/** Her copy, in Shoebox: 60 of 60 counting itself. Her default has room. */
const COPIES: LookupMovableCopy[] = [
  {
    copyId: "c-bulk",
    role: "bulk",
    currentLabel: "Shoebox",
    initial: { kind: "bulk", unitId: "s" },
  },
];
const OPTIONS = {
  binders: [{ id: "b1", name: "Main", type: "general" as const }],
  collectionsByBinder: {},
  bands: [{ key: "red", display: "Red" }],
  bulkUnits: [
    { id: "d", name: "Bulk box", capacity: null, held: 12, isDefault: true },
    { id: "s", name: "Shoebox", capacity: 60, held: 60, isDefault: false },
    { id: "t", name: "Tin", capacity: 5, held: 5, isDefault: false },
  ],
};

beforeEach(() => {
  for (const f of [lookupAnswer, lookupMoveOptions, moveFromLookup]) f.mockReset();
  lookupAnswer.mockResolvedValue({ ok: true, answer: ANSWER, copies: COPIES });
  lookupMoveOptions.mockResolvedValue({ ok: true, options: OPTIONS });
  moveFromLookup.mockResolvedValue({
    ok: true,
    label: "Shoebox",
    lookup: { ok: true, answer: ANSWER, copies: COPIES },
  });
});
afterEach(cleanup);

async function openMove() {
  const user = userEvent.setup();
  render(createElement(LookupScreen));
  await user.click(screen.getByRole("button", { name: "Pick it" }));
  await screen.findByText("Charmeleon");
  await user.click(screen.getAllByRole("button", { name: "Move" })[0]);
  const sheet = await screen.findByRole("dialog", { name: "Move Charmeleon" });
  return {
    user,
    sheet,
    boxes: within(within(sheet).getByRole("group", { name: "Which bulk box" })),
  };
}

describe("0037 · Lookup: a card already in its own full box", () => {
  it("opens on its box with no warning and no Add anyway; its box's load leaves the card out", async () => {
    const { user, sheet, boxes } = await openMove();
    const own = boxes.getByRole("button", { name: "Shoebox · 59 of 60 cards" });
    expect(own.getAttribute("aria-pressed")).toBe("true");
    expect(own.getAttribute("title")).toBeNull();
    expect(within(sheet).queryByRole("alert")).toBeNull();
    expect(within(sheet).queryByRole("button", { name: /Add anyway/ })).toBeNull();
    await user.click(within(sheet).getByRole("button", { name: "Place it here ▶" }));
    await waitFor(() => expect(moveFromLookup).toHaveBeenCalledTimes(1));
    // No override: it is where it was.
    expect(moveFromLookup.mock.calls[0][1]).toEqual({ kind: "bulk", unitId: "s" });
  });

  it("its own box already over its limit: still no Add anyway, and no override, for a card that is already there", async () => {
    lookupMoveOptions.mockResolvedValue({
      ok: true,
      options: {
        ...OPTIONS,
        bulkUnits: OPTIONS.bulkUnits.map((u) => (u.id === "s" ? { ...u, held: 62 } : u)),
      },
    });
    const { user, sheet } = await openMove();
    expect(within(sheet).queryByRole("alert")).toBeNull();
    expect(within(sheet).queryByRole("button", { name: /Add anyway/ })).toBeNull();
    await user.click(within(sheet).getByRole("button", { name: "Place it here ▶" }));
    await waitFor(() => expect(moveFromLookup).toHaveBeenCalledTimes(1));
    expect(moveFromLookup.mock.calls[0][1]).toEqual({ kind: "bulk", unitId: "s" });
  });

  it("another full box is still hers to add it to anyway, 1 over", async () => {
    const { user, sheet, boxes } = await openMove();
    await user.click(boxes.getByRole("button", { name: "Tin · 5 of 5 cards · full" }));
    expect(within(sheet).getByRole("alert").textContent).toBe(
      "Tin is full (5 of 5 cards). Pick another box. Or add it anyway: it will be 1 over.",
    );
    await user.click(within(sheet).getByRole("button", { name: "Add anyway · 1 over" }));
    await waitFor(() => expect(moveFromLookup).toHaveBeenCalledTimes(1));
    expect(moveFromLookup.mock.calls[0][1]).toEqual({ kind: "bulk", unitId: "t", overFull: true });
  });
});
