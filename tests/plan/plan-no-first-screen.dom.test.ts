// @vitest-environment jsdom
/**
 * UIL-114 — the Haul Plan has no first screen, and a card can leave the plan once the haul has run.
 *
 * Karvi: remove the Haul Plan's first screen; "Not mine" becomes available once the haul has actually run.
 * The Senior BA's conditions, pinned here through the REAL screen in a DOM:
 *   - it routes what is waiting as it opens, showing "Routing N cards…" meanwhile;
 *   - a resumed sitting whose stamp matches does NOT re-run the cascade (it costs seconds at her size);
 *   - a card taken off the plan leaves at once, and ONE re-route runs a moment after the last press;
 *   - the re-route keeps her shelved cards and her spotlight card, and names any waiting card it moved;
 *   - "Updating…" while it runs, nothing blocked; a failed re-route leaves a usable plan and says so.
 */
import { createElement } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftCard, DraftPayloadItem, LookupCard } from "@/app/(ui)/plan/plan-types";
import { PlanScreen, REROUTE_FAILED } from "@/app/(ui)/plan/PlanScreen";
import { flattenPlan } from "@/app/(ui)/plan/reroute";
import { groupPlan } from "@/lib/plan/group";
import { routedPlan } from "../support/plan-route";

const runHaulPlan = vi.fn();
const shelveCardAction = vi.fn();
vi.mock("@/app/(ui)/plan/actions", () => ({
  shelveCardAction: (...a: unknown[]) => shelveCardAction(...a),
  getMoveOptions: vi.fn(async () => ({ binders: [], collectionsByBinder: {}, bands: [] })),
  getLineJoinOptions: vi.fn(async () => null),
  loadPendingPlacementDraft: vi.fn(async () => []),
  lookupCatalog: vi.fn(async () => []),
  refreshSpotlightAction: vi.fn(async () => ({ ok: false, error: "not used" })),
  runHaulPlan: (...a: unknown[]) => runHaulPlan(...a),
  planStateStamp: vi.fn(async () => "stamp-routed"),
}));
const removeCopy = vi.fn();
vi.mock("@/app/(ui)/look/actions", () => ({ removeCopy: (...a: unknown[]) => removeCopy(...a) }));

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
const HAUL = [waiting("Abra"), waiting("Kadabra"), waiting("Alakazam")];

const routes = () =>
  runHaulPlan.mock.calls.map((c) => (c[0] as DraftPayloadItem[]).map((d) => d.id));
const spotlightName = () => document.querySelector(".spot")?.textContent ?? "";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  runHaulPlan.mockReset();
  runHaulPlan.mockImplementation(async (p: DraftPayloadItem[]) => routedPlan(p));
  shelveCardAction.mockReset();
  removeCopy.mockReset();
  removeCopy.mockResolvedValue({ ok: true, lookup: null });
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const mount = (initialPending = HAUL, stateStamp = "s") => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(createElement(PlanScreen, { stateStamp, initialPending }));
  return user;
};

describe("UIL-114 · no first screen", () => {
  it("routes what is waiting as it opens, saying so while it routes", async () => {
    let answer: (v: unknown) => void = () => {};
    runHaulPlan.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    mount();
    // PRE-FIX: the first screen, with its queue and a "Run the plan ▶" button.
    expect(screen.getByText("Routing 3 cards…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Run the plan/ })).toBeNull();
    await act(async () =>
      answer(routedPlan(HAUL.map((d) => ({ ...d, tcgdexId: d.card.tcgdexId })))),
    );
    await screen.findAllByText("Abra");
    expect(routes()).toEqual([["id-Abra", "id-Kadabra", "id-Alakazam"]]);
    expect(screen.queryByRole("button", { name: /Edit haul/ })).toBeNull();
  });

  it("a resumed sitting whose stamp still matches is NOT routed again", async () => {
    window.sessionStorage.setItem(
      "binderops.plan.v1",
      JSON.stringify({
        stamp: "s",
        draft: HAUL,
        plan: routedPlan(HAUL.map((d) => ({ ...d, tcgdexId: d.card.tcgdexId }))),
        done: [],
        cur: 0,
        overrides: {},
        collapsed: [],
        collapsedSubgroups: [],
      }),
    );
    mount();
    expect(await screen.findByText("RESUMED")).toBeTruthy();
    expect(runHaulPlan).not.toHaveBeenCalled();
  });

  it("with nothing waiting, it says where cards come from", async () => {
    mount([]);
    expect(await screen.findByText(/Nothing is waiting to be placed/)).toBeTruthy();
    expect(runHaulPlan).not.toHaveBeenCalled();
  });
});

describe("UIL-114 · a card leaving the plan once it has run", () => {
  it("leaves at once, and the rest re-routes ONCE, a moment after the last press", async () => {
    const user = mount();
    await screen.findAllByText("Abra");
    expect(spotlightName()).toContain("Abra");

    await user.click(screen.getByRole("button", { name: "Leave for later" })); // Abra
    await user.click(screen.getByRole("button", { name: "Leave for later" })); // then Alakazam slides in
    // Gone from the plan straight away; no second round trip per press.
    expect(screen.queryByText("Abra")).toBeNull();
    expect(routes()).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    await waitFor(() => expect(routes()).toHaveLength(2));
    // One batched re-route, of what is still waiting.
    expect(routes()[1]).toEqual(["id-Kadabra"]);
  });

  it("says 'Updating…' while it re-routes, and the plan stays usable", async () => {
    const user = mount();
    await screen.findAllByText("Abra");
    let answer: (v: unknown) => void = () => {};
    runHaulPlan.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    await user.click(screen.getByRole("button", { name: "Leave for later" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(await screen.findByText("Updating…")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /Done, next card/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
    await act(async () =>
      answer(
        routedPlan([
          {
            id: "id-Kadabra",
            tcgdexId: "sv09-Kadabra",
            variant: "normal",
            existingCopyId: "id-Kadabra",
          },
          {
            id: "id-Alakazam",
            tcgdexId: "sv09-Alakazam",
            variant: "normal",
            existingCopyId: "id-Alakazam",
          },
        ]),
      ),
    );
    await waitFor(() => expect(screen.queryByText("Updating…")).toBeNull());
  });

  it("keeps the spotlight on its CARD when the re-route reorders the plan, and names the card that moved", async () => {
    const user = mount();
    await screen.findAllByText("Abra");
    // With Abra gone, the re-route turns Alakazam into a bulk card, which sorts it after Kadabra.
    runHaulPlan.mockImplementationOnce(async (p: DraftPayloadItem[]) => {
      const base = routedPlan(p);
      const items = flattenPlan(base).map((it) =>
        it.incomingId === "id-Alakazam"
          ? { ...it, isBasic: false, action: "BULK" as const, destination: "Bulk box" }
          : it,
      );
      return { ...base, groups: groupPlan(items, ["orange"]) };
    });
    await user.click(screen.getByRole("button", { name: "Leave for later" })); // Abra; Alakazam slides in
    expect(spotlightName()).toContain("Alakazam");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(
      await screen.findByText(/1 card got a new home after that change: Alakazam → Bulk box/),
    ).toBeTruthy();
    // Never changes card by itself: still Alakazam, though Kadabra now sorts first.
    expect(spotlightName()).toContain("Alakazam");
  });

  it("a card she has SHELVED is never routed again, and stays on the page", async () => {
    shelveCardAction.mockResolvedValue({
      ok: true,
      counts: { routed: 1, lines: 0, slots: 0, decisions: 0, wishlist: 0 },
      stamp: "stamp-after-shelve",
    });
    const user = mount();
    await screen.findAllByText("Abra");
    await user.click(screen.getByRole("button", { name: /Done, next card/ })); // Abra shelved
    await waitFor(() => expect(shelveCardAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(spotlightName()).toContain("Alakazam"));
    await user.click(screen.getByRole("button", { name: "Leave for later" })); // Alakazam off
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    await waitFor(() => expect(routes()).toHaveLength(2));
    expect(routes()[1]).toEqual(["id-Kadabra"]); // not Abra: its placement is written
    await waitFor(() => expect(screen.getAllByText("Abra").length).toBeGreaterThan(0));
  });

  it("a card taken off while a re-route runs stays off when that re-route lands", async () => {
    const user = mount();
    await screen.findAllByText("Abra");
    let answer: (v: unknown) => void = () => {};
    runHaulPlan.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    await user.click(screen.getByRole("button", { name: "Leave for later" })); // Abra
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    await screen.findByText("Updating…");
    await user.click(screen.getByRole("button", { name: "Leave for later" })); // Alakazam, mid-flight
    // The re-route in flight was asked about Alakazam too; its answer must not bring it back.
    await act(async () =>
      answer(
        routedPlan([
          {
            id: "id-Kadabra",
            tcgdexId: "sv09-Kadabra",
            variant: "normal",
            existingCopyId: "id-Kadabra",
          },
          {
            id: "id-Alakazam",
            tcgdexId: "sv09-Alakazam",
            variant: "normal",
            existingCopyId: "id-Alakazam",
          },
        ]),
      ),
    );
    await waitFor(() => expect(screen.getAllByText("Kadabra").length).toBeGreaterThan(0));
    expect(screen.queryByText("Alakazam")).toBeNull();
  });

  it("a failed re-route keeps the plan she has, and says so", async () => {
    const user = mount();
    await screen.findAllByText("Abra");
    runHaulPlan.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await user.click(screen.getByRole("button", { name: "Leave for later" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(await screen.findByText(REROUTE_FAILED)).toBeTruthy();
    expect(screen.getAllByText("Kadabra").length).toBeGreaterThan(0);
  });

  it("'Not mine' removes the copy first, then takes the card off and re-routes", async () => {
    const user = mount();
    await screen.findAllByText("Abra");
    await user.click(screen.getByRole("button", { name: /Remove Abra from your collection/ }));
    await user.click(screen.getByRole("button", { name: /Yes, remove/ }));
    await waitFor(() => expect(removeCopy).toHaveBeenCalledWith("id-Abra"));
    await waitFor(() => expect(screen.queryByText("Abra")).toBeNull());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    await waitFor(() =>
      expect(routes()).toEqual([
        ["id-Abra", "id-Kadabra", "id-Alakazam"],
        ["id-Kadabra", "id-Alakazam"],
      ]),
    );
  });
});
