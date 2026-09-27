// @vitest-environment jsdom
/**
 * UIL-125 — on a phone the Haul Plan's spotlight no longer covers more than half the screen. It was pinned
 * (`position: sticky`, up to 56vh) at ≤720px: at 375×812 it covered 456 of 812px once she scrolled (the list kept
 * about 3 rows), slid over the sticky haul bar, and cut "Confirm its line ▶" off inside its own scroll. Now it sits
 * above the list and scrolls with the page, as it already did at 721–1080px, and picking a card from the list brings
 * it back into view below the pinned haul bar.
 *
 * jsdom has no layout, so the layout claim is pinned on the stylesheet itself, and the "brings it back" claim is
 * driven through the REAL screen with the phone query, the scroll call and the two positions stood in for.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanItem } from "@/lib/plan";
import type { DraftCard, RunPlanResult } from "@/app/(ui)/plan/plan-types";
import { PlanScreen } from "@/app/(ui)/plan/PlanScreen";
import { shelveCardAction } from "@/app/(ui)/plan/actions";

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

const STAMP = "stamp-uil-125";
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
const item = (d: DraftCard): PlanItem => ({
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
  needsDecision: false,
});
const PLAN: RunPlanResult = {
  groups: [
    {
      bandKey: "orange",
      count: 2,
      subgroups: [{ kind: "nonbasic", label: "STAGE 1 · 2", rows: DRAFT.map(item) }],
    },
  ],
  bands: [{ key: "orange", count: 2 }],
  summary: { total: 2, decisions: 0, byAction: { FRONT: 2 } },
};

const realMatchMedia = window.matchMedia;
/** A parked sitting on this plan, so the screen resumes it. */
function park(plan: RunPlanResult) {
  window.sessionStorage.setItem(
    "binderops.plan.v1",
    JSON.stringify({
      stamp: STAMP,
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
beforeEach(() => park(PLAN));
afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  window.matchMedia = realMatchMedia;
});

/** A phone (or not), the spotlight's top at `spotTop`, and the haul bar's bottom at 100px. */
async function mountAt(opts: { phone: boolean; spotTop: number }) {
  window.matchMedia = vi.fn((q: string) => ({
    matches: opts.phone && q === "(max-width: 720px)",
  })) as unknown as typeof window.matchMedia;
  const user = userEvent.setup();
  render(createElement(PlanScreen, { stateStamp: STAMP }));
  await screen.findAllByText(/Toedscruel/);
  const spot = document.querySelector("aside.spot") as HTMLElement;
  const bar = document.querySelector(".haulbar") as HTMLElement;
  const scroll = vi.fn();
  spot.scrollIntoView = scroll;
  spot.getBoundingClientRect = () => ({ top: opts.spotTop }) as DOMRect;
  bar.getBoundingClientRect = () => ({ bottom: 100 }) as DOMRect;
  return { user, scroll, spot };
}
const inHand = (spot: HTMLElement) => spot.querySelector(".hand .nm")?.textContent;

describe("UIL-125 · the spotlight on a phone", () => {
  it("is not pinned at ≤720px: no sticky, no max-height, no scroll of its own", () => {
    const css = readFileSync("app/globals.css", "utf8");
    // Every `.spot` rule inside a `@media (max-width: 720px)` block.
    const rules: string[] = [];
    let at = css.indexOf("@media (max-width: 720px)");
    while (at >= 0) {
      let depth = 0;
      let end = css.indexOf("{", at);
      for (let i = end; i < css.length; i++) {
        if (css[i] === "{") depth++;
        if (css[i] === "}" && --depth === 0) {
          end = i;
          break;
        }
      }
      const block = css.slice(at, end);
      for (const m of block.matchAll(/(^|\n)\s*\.spot\s*\{([^}]*)\}/g)) rules.push(m[2]);
      at = css.indexOf("@media (max-width: 720px)", end);
    }
    expect(rules.length).toBeGreaterThan(0);
    // PRE-FIX: `position: sticky; top: 0; z-index: 8; max-height: 56vh; overflow: auto;`
    for (const body of rules) {
      expect(body).not.toMatch(/position:\s*sticky/);
      expect(body).not.toMatch(/max-height/);
      expect(body).not.toMatch(/overflow:\s*auto/);
    }
    expect(rules.join("\n")).toMatch(/position:\s*static/);
  });

  it("picking a card from the list brings the spotlight back when it has scrolled under the haul bar", async () => {
    const { user, scroll, spot } = await mountAt({ phone: true, spotTop: -300 });
    await user.click(document.getElementById("plan-row-d2") as HTMLElement);
    expect(inHand(spot)).toBe("Toedscool");
    // PRE-FIX (nothing to bring back: it was pinned) there is no call at all.
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
  });

  it("leaves the page where it is when the spotlight is already in view", async () => {
    const { user, scroll, spot } = await mountAt({ phone: true, spotTop: 140 });
    await user.click(document.getElementById("plan-row-d2") as HTMLElement);
    expect(inHand(spot)).toBe("Toedscool");
    expect(scroll).not.toHaveBeenCalled();
  });

  it("does nothing extra above a phone's width, where the spotlight is pinned beside the list", async () => {
    const { user, scroll, spot } = await mountAt({ phone: false, spotTop: -300 });
    await user.click(document.getElementById("plan-row-d2") as HTMLElement);
    expect(inHand(spot)).toBe("Toedscool");
    expect(scroll).not.toHaveBeenCalled();
  });

  it("a card that needs a collection pick: its row box brings the spotlight back too, and shelves nothing", async () => {
    // Its box does not shelve it unseen (UIL-053): it puts the card in her hand, where she picks the collection.
    // On a phone that hand has scrolled away, so the box brings it back, the same as tapping the row (QA on #409).
    const [first, second] = DRAFT.map(item);
    park({
      ...PLAN,
      groups: [
        {
          ...PLAN.groups[0],
          subgroups: [
            {
              ...PLAN.groups[0].subgroups[0],
              rows: [
                first,
                {
                  ...second,
                  action: "SPEC",
                  destination: "Specialty A",
                  collectionPick: {
                    binderId: "sp",
                    collections: [
                      { id: "c1", name: "Starters" },
                      { id: "c2", name: "Grass" },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    const { user, scroll, spot } = await mountAt({ phone: true, spotTop: -300 });
    await user.click(screen.getByRole("button", { name: "Shelve Toedscool" }));
    expect(inHand(spot)).toBe("Toedscool");
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(vi.mocked(shelveCardAction)).not.toHaveBeenCalled();
  });
});
