// @vitest-environment jsdom
/**
 * UIL-116 — the Haul Plan has no decisions bar. Karvi: "completely irrelevant to the user."
 *
 * The bar under the progress count read "N decisions flagged (resolve in Lines · M7)" (yellow) or "No
 * decisions flagged · ready to commit" (green), and it held the only "◀ Edit haul". What she acts on is not
 * lost: a card that needs a decision still says so on its own row and in the spotlight, and decisions are
 * worked on the Lines screen, whose banner stays. "◀ Edit haul" went with the first screen (UIL-114). Driven through the
 * REAL screen, resumed from a parked sitting with one card that needs a decision.
 */
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanItem } from "@/lib/plan";
import type { DraftCard, RunPlanResult } from "@/app/(ui)/plan/plan-types";
import { PlanScreen } from "@/app/(ui)/plan/PlanScreen";

vi.mock("@/app/(ui)/plan/actions", () => ({
  shelveCardAction: vi.fn(),
  getMoveOptions: vi.fn(async () => ({ binders: [], collectionsByBinder: {}, bands: [] })),
  getLineJoinOptions: vi.fn(async () => null),
  loadPendingPlacementDraft: vi.fn(async () => []),
  lookupCatalog: vi.fn(async () => []),
  refreshSpotlightAction: vi.fn(async () => ({ ok: false, error: "not used" })),
  runHaulPlan: vi.fn(async () => ({ ok: false, error: "not used" })),
}));
vi.mock("@/app/(ui)/look/actions", () => ({ removeCopy: vi.fn() }));

const STAMP = "stamp-uil-116";
const card = (id: string, name: string) => ({
  tcgdexId: id,
  name,
  setId: "sv09",
  setName: "Journey Together",
  localId: id.slice(-3),
  setCardCountOfficial: 159,
  stage: "Stage1",
  types: ["Fighting"],
  category: "Pokemon" as const,
  trainerType: null,
  cardClass: "standard" as const,
  imageUrl: null,
  variants: ["normal" as const],
});
const DRAFT: DraftCard[] = [
  { id: "d1", existingCopyId: "d1", variant: "normal", card: card("sv09-089", "Toedscruel") },
  { id: "d2", existingCopyId: "d2", variant: "normal", card: card("sv09-088", "Toedscool") },
];
const item = (d: DraftCard, needsDecision: boolean): PlanItem => ({
  incomingId: d.id,
  tcgdexId: d.card.tcgdexId,
  name: d.card.name,
  setId: "sv09",
  localId: d.card.localId as string,
  setCardCountOfficial: 159,
  imageUrl: null,
  variant: "normal",
  stage: "Stage1",
  isBasic: false,
  bandKey: "orange",
  action: "FRONT",
  destination: "KB-001 · Front · Orange",
  reason: "Front half.",
  needsDecision,
});
const PLAN: RunPlanResult = {
  groups: [
    {
      bandKey: "orange",
      count: 2,
      subgroups: [
        {
          kind: "nonbasic",
          label: "STAGE 1 · 2",
          rows: [item(DRAFT[0], true), item(DRAFT[1], false)],
        },
      ],
    },
  ],
  bands: [{ key: "orange", count: 2 }],
  summary: { total: 2, decisions: 1, byAction: { FRONT: 2 } },
};

beforeEach(() => {
  window.sessionStorage.setItem(
    "binderops.plan.v1",
    JSON.stringify({
      stamp: STAMP,
      draft: DRAFT,
      plan: PLAN,
      done: [],
      cur: 0,
      overrides: {},
      collapsed: [],
      collapsedSubgroups: [],
    }),
  );
});
afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe("UIL-116 · the Haul Plan has no decisions bar", () => {
  it("says nothing about decisions flagged, in either state", async () => {
    render(createElement(PlanScreen, { stateStamp: STAMP }));
    await screen.findAllByText(/Toedscruel/);
    // PRE-FIX: "1 decision flagged (resolve in Lines · M7)".
    expect(document.body.textContent).not.toMatch(/decisions? flagged/i);
    expect(document.body.textContent).not.toMatch(/ready to commit/i);
  });

  it("a card that needs a decision still says so, on its row and in the spotlight, with no build label", async () => {
    render(createElement(PlanScreen, { stateStamp: STAMP }));
    await screen.findAllByText(/Toedscruel/);
    expect(screen.getAllByText("Decide").length).toBeGreaterThan(0);
    expect(screen.getByText("Needs a decision")).toBeTruthy();
    expect(screen.getByText(/Confirm or override it on the Lines screen/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\bM7\b/);
  });

  it("has no ◀ Edit haul: UIL-114 removed the first screen it went back to", async () => {
    render(createElement(PlanScreen, { stateStamp: STAMP }));
    await screen.findAllByText(/Toedscruel/);
    expect(screen.queryByRole("button", { name: /Edit haul/ })).toBeNull();
  });
});
