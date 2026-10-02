// @vitest-environment jsdom
/**
 * UIL-130 / 0037 — the Haul Plan's own route to bulk when every box is full. The plan never sends a card to a full
 * box on its own (the database refuses it: "Your Bulk box is full. Pick another box."), and that used to be a dead end
 * on the plan. Karvi, 2026-10-01/02: "Users should always be able to override all rules." So the spotlight says every
 * box is full, Done waits, and "Pick a box…" opens her Move sheet on the bulk box, where she adds it anyway; Done then
 * writes her Move with `overFull`. The real screen and Move sheet; only the server actions are stood in for.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanItem } from "@/lib/plan";
import type { MoveOptions } from "@/lib/line/types";
import { groupPlan } from "@/lib/plan/group";
import type { DraftCard, LookupCard, RunPlanResult } from "@/app/(ui)/plan/plan-types";
import { PlanScreen } from "@/app/(ui)/plan/PlanScreen";
import { flattenPlan } from "@/app/(ui)/plan/reroute";
import { routedPlan } from "../support/plan-route";

const OPTIONS: MoveOptions = {
  binders: [{ id: "b1", name: "KB-001", type: "general" }],
  collectionsByBinder: {},
  bands: [{ key: "orange", display: "Orange" }],
  bulkUnits: [{ id: "d", name: "Bulk box", capacity: 1, held: 1, isDefault: true }],
};
const shelveCardAction = vi.fn();
vi.mock("@/app/(ui)/plan/actions", () => ({
  shelveCardAction: (...a: unknown[]) => shelveCardAction(...a),
  getMoveOptions: vi.fn(async () => OPTIONS),
  getLineJoinOptions: vi.fn(async () => null),
  loadPendingPlacementDraft: vi.fn(async () => []),
  loadArrivals: vi.fn(async () => []),
  lookupCatalog: vi.fn(async () => []),
  refreshSpotlightAction: vi.fn(async () => ({ ok: false, error: "not used" })),
  runHaulPlan: vi.fn(),
  planStateStamp: vi.fn(async () => "s"),
}));
vi.mock("@/app/(ui)/look/actions", () => ({ removeCopy: vi.fn() }));

const card = (name: string): LookupCard => ({
  tcgdexId: `sv09-${name}`,
  name,
  setId: "sv09",
  setName: "Journey Together",
  localId: "017",
  setCardCountOfficial: 159,
  stage: "Basic",
  types: ["Fighting"],
  category: "Pokemon",
  trainerType: null,
  cardClass: "standard",
  imageUrl: null,
  variants: ["normal"],
});
const waiting = (name: string): DraftCard => ({
  id: `id-${name}`,
  existingCopyId: `id-${name}`,
  card: card(name),
  variant: "normal",
  dexVariantRaw: "Normal",
});
const DRAFT = [waiting("Machop"), waiting("Riolu")];

/** A routed plan whose Machop is a duplicate for the bulk box, with every box full. */
function park(boxesFull: boolean) {
  const base = routedPlan(DRAFT.map((d) => ({ ...d, tcgdexId: d.card.tcgdexId })));
  const items: PlanItem[] = flattenPlan(base).map((it) =>
    it.name === "Machop"
      ? { ...it, action: "BULK", destination: "Bulk box", reason: "A duplicate.", boxesFull }
      : it,
  );
  const plan: RunPlanResult = { ...base, groups: groupPlan(items, ["orange"]) };
  window.sessionStorage.setItem(
    "binderops.plan.v1",
    JSON.stringify({
      stamp: "s",
      draft: DRAFT,
      plan,
      done: [],
      cur: 0,
      overrides: {},
      collapsed: [],
      collapsedSubgroups: [],
    }),
  );
}

const spot = () => document.querySelector(".spot") as HTMLElement;
const doneBtn = () =>
  within(spot()).getByRole("button", {
    name: /Done, next card|Pick a box above/,
  }) as HTMLButtonElement;

beforeEach(() => {
  window.sessionStorage.clear();
  shelveCardAction.mockReset();
  shelveCardAction.mockResolvedValue({
    ok: true,
    counts: { routed: 1, lines: 0, slots: 0, decisions: 1, wishlist: 0 },
    stamp: "s2",
    lineDone: false,
  });
});
afterEach(cleanup);

async function mount() {
  const user = userEvent.setup();
  render(createElement(PlanScreen, { stateStamp: "s" }));
  await screen.findAllByText("Machop");
  return user;
}

describe("every box full: the Haul Plan's route to bulk is no dead end", () => {
  it("it says so, Done waits, and Pick a box… adds it to a box anyway; Done writes her Move with overFull", async () => {
    park(true);
    const user = await mount();
    expect(within(spot()).getByRole("alert").textContent).toBe(
      "Every bulk box is full. Pick a box to add it to anyway, or move it somewhere else.",
    );
    expect(doneBtn().disabled).toBe(true);
    expect(doneBtn().textContent).toBe("Pick a box above");
    expect(document.getElementById("plan-row-id-Machop")?.textContent).toContain("Pick a box");
    // The row's box brings it here rather than sending a Done the server will refuse.
    await user.click(screen.getByRole("button", { name: "Shelve Machop" }));
    expect(shelveCardAction).not.toHaveBeenCalled();

    await user.click(within(spot()).getByRole("button", { name: "Pick a box…" }));
    const sheet = await screen.findByRole("dialog", { name: "Move Machop" });
    const boxes = within(within(sheet).getByRole("group", { name: "Which bulk box" }));
    expect(boxes.getByRole("button", { name: /Bulk box/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(within(sheet).getByRole("alert").textContent).toBe(
      "Bulk box is full (1 of 1 cards). Pick another box. Or add it anyway: it will be 1 over.",
    );
    await user.click(within(sheet).getByRole("button", { name: "Add anyway · 1 over" }));
    expect(screen.queryByRole("dialog", { name: "Move Machop" })).toBeNull();

    // Her Move stands; nothing is written until Done.
    expect(shelveCardAction).not.toHaveBeenCalled();
    expect(within(spot()).queryByRole("alert")).toBeNull();
    expect(doneBtn().disabled).toBe(false);
    await user.click(doneBtn());
    await waitFor(() => expect(shelveCardAction).toHaveBeenCalledTimes(1));
    expect(shelveCardAction.mock.calls[0][0]).toMatchObject({
      card: { id: "id-Machop" },
      override: { kind: "bulk", unitId: "d", overFull: true },
    });
  });

  it("a box with room: nothing is asked, and Done shelves it as before", async () => {
    park(false);
    const user = await mount();
    expect(within(spot()).queryByRole("alert")).toBeNull();
    expect(within(spot()).queryByRole("button", { name: "Pick a box…" })).toBeNull();
    await user.click(doneBtn());
    await waitFor(() => expect(shelveCardAction).toHaveBeenCalledTimes(1));
    expect(shelveCardAction.mock.calls[0][0].override).toBeNull();
  });
});

/**
 * The Tech Lead's "no dead ends": a holo swapped in for her normal sends the normal to bulk, and with every box full the
 * plan names no box for it. The row asks the same way, and "Pick a box…" picks the box for the card it swaps out, here
 * in the spotlight; Done sends it as `displacedTo` with `overFull` (the holo still takes the shelf, no Move).
 */
describe("every box full: a swap row's card coming out is no dead end either", () => {
  function parkSwap() {
    const base = routedPlan(DRAFT.map((d) => ({ ...d, tcgdexId: d.card.tcgdexId })));
    const items: PlanItem[] = flattenPlan(base).map((it) =>
      it.name === "Machop"
        ? {
            ...it,
            action: "SWAP",
            // A front-half swap: no line, so no line popup (a plan without the key reads as pre-UIL-117).
            lineProposal: null,
            destination: "KB-001 · Front · Orange",
            reason: "Swaps in for your normal Machop; the normal goes to the bulk box.",
            boxesFull: true,
          }
        : it,
    );
    const plan: RunPlanResult = { ...base, groups: groupPlan(items, ["orange"]) };
    window.sessionStorage.setItem(
      "binderops.plan.v1",
      JSON.stringify({
        stamp: "s",
        draft: DRAFT,
        plan,
        done: [],
        cur: 0,
        overrides: {},
        collapsed: [],
        collapsedSubgroups: [],
      }),
    );
  }

  it("the row offers Pick a box; she adds the swapped-out card to a full box anyway, and Done sends it", async () => {
    parkSwap();
    const user = await mount();
    expect(within(spot()).getByRole("alert").textContent).toBe(
      "Every bulk box is full. Pick a box to add it to anyway, or move it somewhere else.",
    );
    expect(document.getElementById("plan-row-id-Machop")?.textContent).toContain("Pick a box");
    expect(doneBtn().disabled).toBe(true);

    await user.click(within(spot()).getByRole("button", { name: "Pick a box…" }));
    // Not the Move sheet: the holo still takes the shelf; this is where the card it swaps out goes.
    expect(screen.queryByRole("dialog", { name: "Move Machop" })).toBeNull();
    const boxes = within(
      within(spot()).getByRole("group", { name: "Which box for the card it swaps out" }),
    );
    expect(boxes.getByRole("button", { name: /Bulk box/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(within(spot()).getByRole("alert").textContent).toBe(
      "Bulk box is full (1 of 1 cards). Pick another box. Or add it anyway: it will be 1 over.",
    );
    expect(doneBtn().disabled).toBe(true);
    await user.click(boxes.getByRole("button", { name: "Add anyway · 1 over" }));
    expect(within(spot()).queryByRole("alert")).toBeNull();
    expect(spot().textContent).toContain("→ Bulk box · 1 over its limit");
    expect(document.getElementById("plan-row-id-Machop")?.textContent).not.toContain("Pick a box");
    expect(doneBtn().disabled).toBe(false);
    await user.click(doneBtn());
    await waitFor(() => expect(shelveCardAction).toHaveBeenCalledTimes(1));
    expect(shelveCardAction.mock.calls[0][0]).toMatchObject({
      card: { id: "id-Machop" },
      override: null,
      displacedTo: { kind: "bulk", unitId: "d", overFull: true },
    });
  });
});
