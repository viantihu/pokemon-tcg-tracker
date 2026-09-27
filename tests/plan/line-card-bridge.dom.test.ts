// @vitest-environment jsdom
/**
 * UIL-117 PR 4, 4a — the Haul Plan's Done on a line card sends her line choice, through the REAL screen. (The line
 * popup replaces the spotlight's controls in 4b; this is the bridge the server rule needs meanwhile.) Pinned:
 *   - a card that starts a line: the spotlight is re-derived from the FIRST card, so its pull checklist is there,
 *     and Done sends a start with exactly the pulls she ticked (none ticked for her);
 *   - a card for an open slot: Done sends the join the plan proposes;
 *   - the row's box on a line card brings it to the spotlight instead of shelving it unseen;
 *   - a plan parked before UIL-117 (a back-half row with no line proposal) is routed again, not resumed.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanItem } from "@/lib/plan";
import type { LineProposal } from "@/lib/line/popup";
import { groupPlan } from "@/lib/plan/group";
import type {
  DraftCard,
  DraftPayloadItem,
  LookupCard,
  RunPlanResult,
} from "@/app/(ui)/plan/plan-types";
import { PlanScreen } from "@/app/(ui)/plan/PlanScreen";
import { flattenPlan } from "@/app/(ui)/plan/reroute";
import { routedPlan } from "../support/plan-route";

const shelveCardAction = vi.fn();
const refreshSpotlightAction = vi.fn();
const runHaulPlan = vi.fn();
vi.mock("@/app/(ui)/plan/actions", () => ({
  shelveCardAction: (...a: unknown[]) => shelveCardAction(...a),
  getMoveOptions: vi.fn(async () => ({ binders: [], collectionsByBinder: {}, bands: [] })),
  getLineJoinOptions: vi.fn(async () => null),
  loadPendingPlacementDraft: vi.fn(async () => []),
  loadArrivals: vi.fn(async () => []),
  lookupCatalog: vi.fn(async () => []),
  refreshSpotlightAction: (...a: unknown[]) => refreshSpotlightAction(...a),
  runHaulPlan: (...a: unknown[]) => runHaulPlan(...a),
  planStateStamp: vi.fn(async () => "s"),
}));
vi.mock("@/app/(ui)/look/actions", () => ({ removeCopy: vi.fn() }));

const card = (name: string): LookupCard => ({
  tcgdexId: `sv03-${name}`,
  name,
  setId: "sv03",
  setName: "Obsidian Flames",
  localId: "027",
  setCardCountOfficial: 197,
  stage: "Stage1",
  types: ["Fire"],
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
const START: LineProposal = { kind: "start", binderId: "kb1", band: "red" };
const ADD: LineProposal = { kind: "add", lineId: "L1", slotId: "S1" };

/** A plan whose rows are back-half cards with these proposals (Charmeleon starts one, Squirtle... etc). */
function planWith(
  rows: { name: string; proposal: LineProposal | null; action: PlanItem["action"] }[],
) {
  const base = routedPlan(rows.map((r) => ({ ...waiting(r.name), tcgdexId: `sv03-${r.name}` })));
  const byName = new Map(rows.map((r) => [r.name, r]));
  const items: PlanItem[] = flattenPlan(base).map((it) => {
    const r = byName.get(it.name)!;
    return { ...it, action: r.action, lineProposal: r.proposal };
  });
  return { ...base, groups: groupPlan(items, ["orange"]) } as RunPlanResult;
}
function park(plan: RunPlanResult, names: string[]) {
  window.sessionStorage.setItem(
    "binderops.plan.v1",
    JSON.stringify({
      stamp: "s",
      draft: names.map(waiting),
      plan,
      done: [],
      cur: 0,
      overrides: {},
      collapsed: [],
      collapsedSubgroups: [],
    }),
  );
}
const spotlightName = () => document.querySelector(".spot .nm")?.textContent ?? "";
const doneButton = () =>
  screen.getByRole("button", { name: /Done, next card/ }) as HTMLButtonElement;

beforeEach(() => {
  window.sessionStorage.clear();
  for (const f of [shelveCardAction, refreshSpotlightAction, runHaulPlan]) f.mockReset();
  shelveCardAction.mockResolvedValue({
    ok: true,
    counts: { routed: 1, lines: 1, slots: 1, decisions: 1, wishlist: 0 },
    stamp: "s2",
  });
  runHaulPlan.mockImplementation(async (p: DraftPayloadItem[]) => routedPlan(p));
});
afterEach(cleanup);

describe("UIL-117 4a · Done on a line card sends her line choice", () => {
  it("a card that starts a line: re-derived from the first card, and Done sends exactly the pulls she ticked", async () => {
    const plan = planWith([{ name: "Charmeleon", proposal: START, action: "NEWLINE" }]);
    park(plan, ["Charmeleon"]);
    refreshSpotlightAction.mockResolvedValue({
      ok: true,
      item: flattenPlan(plan)[0],
      digest: "dg",
      proposedPulls: [
        {
          copyId: "own-charmander",
          name: "Charmander",
          fromLabel: "KB-001 · Front · Red",
          stageIndex: 0,
          fromLine: false,
          needsFetching: false,
        },
      ],
      bandMismatch: null,
    });
    const user = userEvent.setup();
    render(createElement(PlanScreen, { stateStamp: "s" }));
    // PRE-FIX: nothing was re-derived before the first Done, so no pull checklist was on screen.
    const box = await screen.findByRole("checkbox", { name: /Charmander/ });
    expect(refreshSpotlightAction).toHaveBeenCalledTimes(1);
    expect((box as HTMLInputElement).checked).toBe(false); // never ticked for her
    await user.click(box);
    await waitFor(() => expect(doneButton().disabled).toBe(false));
    await user.click(doneButton());
    await waitFor(() => expect(shelveCardAction).toHaveBeenCalledTimes(1));
    expect(shelveCardAction.mock.calls[0][0].lineChoice).toEqual({
      mode: "start",
      binderId: "kb1",
      band: "red",
      pulls: ["own-charmander"],
    });
  });

  it("a card for an open slot: Done sends the join the plan proposes", async () => {
    const plan = planWith([{ name: "Charmeleon", proposal: ADD, action: "FILL" }]);
    park(plan, ["Charmeleon"]);
    refreshSpotlightAction.mockResolvedValue({
      ok: true,
      item: flattenPlan(plan)[0],
      digest: "dg",
      proposedPulls: [],
      bandMismatch: null,
    });
    const user = userEvent.setup();
    render(createElement(PlanScreen, { stateStamp: "s" }));
    await waitFor(() => expect(refreshSpotlightAction).toHaveBeenCalled());
    await waitFor(() => expect(doneButton().disabled).toBe(false));
    await user.click(doneButton());
    await waitFor(() =>
      expect(shelveCardAction.mock.calls[0]?.[0].lineChoice).toEqual({
        mode: "join",
        lineId: "L1",
        slotId: "S1",
      }),
    );
  });

  it("the row's box on a line card brings it to the spotlight instead of shelving it unseen", async () => {
    const plan = planWith([
      { name: "Abra", proposal: null, action: "FRONT" },
      { name: "Charmeleon", proposal: ADD, action: "FILL" },
    ]);
    park(plan, ["Abra", "Charmeleon"]);
    refreshSpotlightAction.mockResolvedValue({ ok: false, error: "not used" });
    const user = userEvent.setup();
    render(createElement(PlanScreen, { stateStamp: "s" }));
    await screen.findAllByText("Abra");
    expect(spotlightName()).toContain("Abra");
    await user.click(screen.getByRole("button", { name: "Shelve Charmeleon" }));
    expect(spotlightName()).toContain("Charmeleon");
    expect(shelveCardAction).not.toHaveBeenCalled();
  });

  it("a plan parked before UIL-117 is routed again, not resumed", async () => {
    // A back-half row with no line proposal at all: the shape every plan had before this change.
    const base = routedPlan([{ ...waiting("Charmeleon"), tcgdexId: "sv03-Charmeleon" }]);
    const old = {
      ...base,
      groups: groupPlan(
        flattenPlan(base).map((it) => ({ ...it, action: "FILL" as const })),
        ["orange"],
      ),
    };
    park(old, ["Charmeleon"]);
    // The page hands in the queue as the server read it, as it does on every open.
    render(createElement(PlanScreen, { stateStamp: "s", initialPending: [waiting("Charmeleon")] }));
    await waitFor(() => expect(runHaulPlan).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("RESUMED")).toBeNull();
  });
});
