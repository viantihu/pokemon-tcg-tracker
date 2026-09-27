// @vitest-environment jsdom
/**
 * UIL-127a — a brand-new account has no binder, and the two screens that place cards say so.
 *
 * Backfill used to show "Loading binders…" forever; Haul Plan showed a plan whose every card went nowhere. Both now
 * show one notice with the way to Settings. Driven through the REAL screens: Backfill with a context holding no
 * binder, Haul Plan resumed from a parked sitting whose plan says the account has none.
 */
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftCard, RunPlanResult } from "@/app/(ui)/plan/plan-types";
import { NO_BINDER } from "@/lib/plan/no-binder";

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

const loadContext = vi.fn();
vi.mock("@/app/(ui)/backfill/actions", () => ({
  loadContext: (...a: unknown[]) => loadContext(...a),
  resolveLine: vi.fn(),
  commitFrontAction: vi.fn(),
  commitLineAction: vi.fn(),
  commitSpecialtyAction: vi.fn(),
  lookupCatalog: vi.fn(async () => []),
  searchWaiting: vi.fn(async () => []),
}));

import { BackfillScreen } from "@/app/(ui)/backfill/BackfillScreen";
import { PlanScreen } from "@/app/(ui)/plan/PlanScreen";

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

function expectNotice() {
  const notice = screen.getByText(NO_BINDER.notice).closest('[role="status"]')!;
  expect(notice).toBeTruthy();
  const link = screen.getByRole("link", { name: NO_BINDER.link });
  expect(link.getAttribute("href")).toBe("/settings");
}

describe("UIL-127a · Backfill with no binder", () => {
  it("says to add one in Settings, instead of loading forever", async () => {
    loadContext.mockResolvedValue({ binders: [], collections: [], bands: [], typeColorMap: {} });
    render(createElement(BackfillScreen));
    await screen.findByText(NO_BINDER.notice);
    expectNotice();
    expect(document.body.textContent).not.toContain("Loading binders");
  });
});

describe("UIL-127a · Haul Plan with no binder", () => {
  const STAMP = "stamp-uil-127a";
  const DRAFT: DraftCard[] = [
    {
      id: "d1",
      existingCopyId: "d1",
      variant: "normal",
      card: {
        tcgdexId: "sv01-181",
        name: "Nest Ball",
        setId: "sv01",
        setName: "Scarlet & Violet",
        localId: "181",
        setCardCountOfficial: 198,
        stage: null,
        types: [],
        category: "Trainer",
        trainerType: "Item",
        cardClass: "standard",
        imageUrl: null,
        variants: ["normal"],
      },
    },
  ];
  const plan = (noBinders: boolean): RunPlanResult => ({
    groups: [
      {
        bandKey: "white",
        count: 1,
        subgroups: [
          {
            kind: "nonbasic",
            label: "TRAINER · 1",
            rows: [
              {
                incomingId: "d1",
                tcgdexId: "sv01-181",
                name: "Nest Ball",
                setId: "sv01",
                localId: "181",
                setCardCountOfficial: 198,
                imageUrl: null,
                variant: "normal",
                stage: null,
                isBasic: false,
                bandKey: "white",
                action: "FRONT",
                destination: "Front · White",
                reason: "Front half.",
                needsDecision: false,
              },
            ],
          },
        ],
      },
    ],
    bands: [{ key: "white", count: 1 }],
    summary: { total: 1, decisions: 0, byAction: { FRONT: 1 } },
    noBinders,
  });
  const park = (p: RunPlanResult) =>
    window.sessionStorage.setItem(
      "binderops.plan.v1",
      JSON.stringify({
        stamp: STAMP,
        draft: DRAFT,
        plan: p,
        done: [],
        cur: 0,
        overrides: {},
        collapsed: [],
        collapsedSubgroups: [],
      }),
    );

  it("says to add one in Settings, above the cards waiting", async () => {
    park(plan(true));
    render(createElement(PlanScreen, { stateStamp: STAMP }));
    await screen.findAllByText(/Nest Ball/);
    expectNotice();
  });

  it("an account with a binder sees no such notice", async () => {
    park(plan(false));
    render(createElement(PlanScreen, { stateStamp: STAMP }));
    await screen.findAllByText(/Nest Ball/);
    expect(screen.queryByText(NO_BINDER.notice)).toBeNull();
  });
});
