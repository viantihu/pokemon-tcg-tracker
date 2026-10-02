// @vitest-environment jsdom
/**
 * UIL-053 — the Haul Plan asks "Which collection?" for a specialty card bound for a binder that holds
 * collections, through the REAL screen. Karvi reproduced 13 cards shelved in her specialty binder on no
 * collection's list. The rulings pinned here:
 *   - the spotlight lists the binder's collections as MovePanel's chips, none picked, and Done waits;
 *   - a binder with exactly ONE collection pre-selects it (the Senior BA's ruling); she still presses Done;
 *   - Done sends her pick;
 *   - the row's box brings such a card to the spotlight rather than shelving it unseen.
 * The server half (the refusal, and the pick landing on the collection's list) is
 * tests/plan/specialty-collection-pick.test.ts.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanItem } from "@/lib/plan";
import { groupPlan } from "@/lib/plan/group";
import type { DraftCard, LookupCard, RunPlanResult } from "@/app/(ui)/plan/plan-types";
import { PlanScreen } from "@/app/(ui)/plan/PlanScreen";
import { flattenPlan } from "@/app/(ui)/plan/reroute";
import { routedPlan } from "../support/plan-route";

const shelveCardAction = vi.fn();
const runHaulPlan = vi.fn();
vi.mock("@/app/(ui)/plan/actions", () => ({
  shelveCardAction: (...a: unknown[]) => shelveCardAction(...a),
  getMoveOptions: vi.fn(async () => ({ binders: [], collectionsByBinder: {}, bands: [] })),
  getLineJoinOptions: vi.fn(async () => null),
  loadPendingPlacementDraft: vi.fn(async () => []),
  loadArrivals: vi.fn(async () => []),
  lookupCatalog: vi.fn(async () => []),
  refreshSpotlightAction: vi.fn(async () => ({ ok: false, error: "not used" })),
  runHaulPlan: (...a: unknown[]) => runHaulPlan(...a),
  planStateStamp: vi.fn(async () => "s"),
}));
vi.mock("@/app/(ui)/look/actions", () => ({ removeCopy: vi.fn() }));

const SPEC = "1c000000-0000-0000-0000-00000000c5ec";
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
const DRAFT = [waiting("Charizard"), waiting("Machop")];

/** A routed plan whose Charizard is a specialty card for a binder holding these collections. */
function planWith(
  collections: { id: string; name: string }[],
  draft: DraftCard[] = DRAFT,
): RunPlanResult {
  const base = routedPlan(draft.map((d) => ({ ...d, tcgdexId: d.card.tcgdexId })));
  const items: PlanItem[] = flattenPlan(base).map((it) =>
    it.name === "Charizard"
      ? {
          ...it,
          action: "SPEC",
          destination: "Specialty A",
          collectionPick: { binderId: SPEC, collections },
        }
      : it,
  );
  return { ...base, groups: groupPlan(items, ["orange"]) };
}

/** Park a sitting with that plan, resumed as the page opens. */
function park(collections: { id: string; name: string }[]) {
  const plan = planWith(collections);
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
const done = () =>
  within(spot()).getByRole("button", {
    name: /Done, next card|Pick a collection above/,
  }) as HTMLButtonElement;
const chip = (name: string) => within(spot()).getByRole("button", { name });

beforeEach(() => {
  window.sessionStorage.clear();
  shelveCardAction.mockReset();
  shelveCardAction.mockResolvedValue({
    ok: true,
    counts: { routed: 1, lines: 0, slots: 0, decisions: 1, wishlist: 0 },
    stamp: "s2",
  });
});
afterEach(cleanup);

async function mount() {
  const user = userEvent.setup();
  render(createElement(PlanScreen, { stateStamp: "s" }));
  await screen.findAllByText("Charizard");
  return user;
}

describe("UIL-053 · Which collection?", () => {
  it("lists the binder's collections, picks none, and Done waits for her pick", async () => {
    park([
      { id: "c-zards", name: "Charizards" },
      { id: "c-fire", name: "Fire art" },
    ]);
    const user = await mount();
    // PRE-FIX: no question; Done shelved it into the binder on no collection's list.
    expect(within(spot()).getByText("WHICH COLLECTION?")).toBeTruthy();
    expect(chip("Charizards").getAttribute("aria-pressed")).toBe("false");
    expect(chip("Fire art").getAttribute("aria-pressed")).toBe("false");
    expect(done().disabled).toBe(true);
    expect(done().textContent).toBe("Pick a collection above");
    const row = document.getElementById("plan-row-id-Charizard");
    expect(row?.textContent).toContain("Pick collection");
    expect(document.getElementById("plan-row-id-Machop")?.textContent).not.toContain(
      "Pick collection",
    );

    await user.click(chip("Fire art"));
    expect(chip("Fire art").getAttribute("aria-pressed")).toBe("true");
    expect(spot().textContent).toContain("Specialty A · Fire art");
    expect(done().disabled).toBe(false);
    await user.click(done());
    await waitFor(() => expect(shelveCardAction).toHaveBeenCalledTimes(1));
    expect(shelveCardAction.mock.calls[0][0]).toMatchObject({
      card: { id: "id-Charizard" },
      collectionChoice: "c-fire",
    });
  });

  it("a binder with exactly one collection pre-selects it, and Done sends it", async () => {
    park([{ id: "c-zards", name: "Charizards" }]);
    const user = await mount();
    expect(chip("Charizards").getAttribute("aria-pressed")).toBe("true");
    expect(done().disabled).toBe(false);
    await user.click(done());
    await waitFor(() =>
      expect(shelveCardAction.mock.calls[0]?.[0]).toMatchObject({ collectionChoice: "c-zards" }),
    );
  });

  it("the row's box brings the card to the spotlight instead of shelving it unseen", async () => {
    park([{ id: "c-zards", name: "Charizards" }]);
    const user = await mount();
    await user.click(within(spot()).getByRole("button", { name: "Skip ▶" })); // on to Machop
    expect(spot().querySelector(".nm")?.textContent).toContain("Machop");
    await user.click(screen.getByRole("button", { name: "Shelve Charizard" }));
    expect(spot().querySelector(".nm")?.textContent).toContain("Charizard");
    expect(shelveCardAction).not.toHaveBeenCalled();
  });

  it("a card that joins no collection asks nothing and sends no pick", async () => {
    park([{ id: "c-zards", name: "Charizards" }]);
    const user = await mount();
    await user.click(within(spot()).getByRole("button", { name: "Skip ▶" })); // Machop
    expect(within(spot()).queryByText("WHICH COLLECTION?")).toBeNull();
    await user.click(done());
    await waitFor(() => expect(shelveCardAction).toHaveBeenCalledTimes(1));
    expect(shelveCardAction.mock.calls[0][0].collectionChoice).toBeNull();
  });

  it("a pick the binder no longer offers is not sent: after a re-route it falls back to what is offered", async () => {
    park([
      { id: "c-zards", name: "Charizards" },
      { id: "c-fire", name: "Fire art" },
    ]);
    const user = await mount();
    await user.click(chip("Fire art"));
    // "Fire art" leaves the binder meanwhile; the next re-route (after Machop is left for later) says so.
    runHaulPlan.mockResolvedValueOnce(
      planWith([{ id: "c-zards", name: "Charizards" }], [waiting("Charizard")]),
    );
    await user.click(within(spot()).getByRole("button", { name: "Skip ▶" }));
    await user.click(within(spot()).getByRole("button", { name: "Leave for later" })); // Machop
    await waitFor(() => expect(runHaulPlan).toHaveBeenCalledTimes(1), { timeout: 4000 });
    await waitFor(() =>
      expect(within(spot()).queryByRole("button", { name: "Fire art" })).toBeNull(),
    );
    expect(chip("Charizards").getAttribute("aria-pressed")).toBe("true"); // the only one left
    await user.click(done());
    await waitFor(() => expect(shelveCardAction).toHaveBeenCalledTimes(1));
    expect(shelveCardAction.mock.calls[0][0].collectionChoice).toBe("c-zards");
  });
});

/**
 * 0037 — Karvi, 2026-10-01: "Users should always be able to override all rules." Picking a collection is the
 * recommendation; "Shelve without a collection" is hers, warned in her words, and Done then commits with her override.
 */
describe("0037 · Shelve without a collection", () => {
  it("her choice, with the warning; Done commits it with the override and no collection", async () => {
    park([
      { id: "c-zards", name: "Charizards" },
      { id: "c-fire", name: "Fire art" },
    ]);
    const user = await mount();
    expect(done().disabled).toBe(true);
    const without = chip("Shelve without a collection");
    expect(without.getAttribute("aria-pressed")).toBe("false");
    expect(within(spot()).queryByText("It won't count toward any collection.")).toBeNull();
    await user.click(without);
    expect(chip("Shelve without a collection").getAttribute("aria-pressed")).toBe("true");
    expect(within(spot()).getByText("It won't count toward any collection.")).toBeTruthy();
    expect(spot().textContent).toContain("Specialty A · No collection");
    expect(document.getElementById("plan-row-id-Charizard")?.textContent).not.toContain(
      "Pick collection",
    );
    expect(done().disabled).toBe(false);
    await user.click(done());
    await waitFor(() => expect(shelveCardAction).toHaveBeenCalledTimes(1));
    expect(shelveCardAction.mock.calls[0][0]).toMatchObject({
      card: { id: "id-Charizard" },
      collectionChoice: null,
      noCollection: true,
    });
  });

  it("a binder's ONLY collection is pre-selected, and she can still shelve it without", async () => {
    park([{ id: "c-zards", name: "Charizards" }]);
    const user = await mount();
    expect(chip("Charizards").getAttribute("aria-pressed")).toBe("true");
    await user.click(chip("Shelve without a collection"));
    expect(chip("Charizards").getAttribute("aria-pressed")).toBe("false");
    await user.click(done());
    await waitFor(() => expect(shelveCardAction).toHaveBeenCalledTimes(1));
    expect(shelveCardAction.mock.calls[0][0]).toMatchObject({
      collectionChoice: null,
      noCollection: true,
    });
  });

  it("she changes her mind and picks one: no override is sent", async () => {
    park([
      { id: "c-zards", name: "Charizards" },
      { id: "c-fire", name: "Fire art" },
    ]);
    const user = await mount();
    await user.click(chip("Shelve without a collection"));
    await user.click(chip("Fire art"));
    expect(chip("Shelve without a collection").getAttribute("aria-pressed")).toBe("false");
    expect(within(spot()).queryByText("It won't count toward any collection.")).toBeNull();
    await user.click(done());
    await waitFor(() => expect(shelveCardAction).toHaveBeenCalledTimes(1));
    expect(shelveCardAction.mock.calls[0][0]).toMatchObject({ collectionChoice: "c-fire" });
    expect(shelveCardAction.mock.calls[0][0].noCollection).toBeFalsy();
  });
});
