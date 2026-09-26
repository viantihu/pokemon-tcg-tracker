// @vitest-environment jsdom
/**
 * UIL-114 part C — cards that arrive while the Haul Plan is open join it, automatically.
 *
 * The rulings, pinned through the REAL screen in a DOM:
 *   - the page asks on focus and every 30 s (the timing itself is tests/plan/arrival-watch.test.ts);
 *   - an arrival joins the plan with no tap, badged "New", and named with where it goes;
 *   - the spotlight never changes card by itself, even when an arrival sorts ahead of it;
 *   - a card she left for later is not brought back by the next check;
 *   - a check that cannot reach the server says nothing, but two in a row say so once, quietly.
 */
import { createElement } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftCard, DraftPayloadItem, LookupCard } from "@/app/(ui)/plan/plan-types";
import { ARRIVALS_LOST, PlanScreen } from "@/app/(ui)/plan/PlanScreen";
import { routedPlan } from "../support/plan-route";

const runHaulPlan = vi.fn();
const loadArrivals = vi.fn();
const shelveCardAction = vi.fn();
const loadPendingPlacementDraft = vi.fn();
vi.mock("@/app/(ui)/plan/actions", () => ({
  shelveCardAction: (...a: unknown[]) => shelveCardAction(...a),
  getMoveOptions: vi.fn(async () => ({ binders: [], collectionsByBinder: {}, bands: [] })),
  getLineJoinOptions: vi.fn(async () => null),
  loadPendingPlacementDraft: (...a: unknown[]) => loadPendingPlacementDraft(...a),
  loadArrivals: (...a: unknown[]) => loadArrivals(...a),
  lookupCatalog: vi.fn(async () => []),
  refreshSpotlightAction: vi.fn(async () => ({ ok: false, error: "not used" })),
  runHaulPlan: (...a: unknown[]) => runHaulPlan(...a),
  planStateStamp: vi.fn(async () => "stamp-routed"),
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
const HAUL = [waiting("Abra"), waiting("Kadabra"), waiting("Alakazam")];

const routes = () =>
  runHaulPlan.mock.calls.map((c) => (c[0] as DraftPayloadItem[]).map((d) => d.id));
const spotlightName = () => document.querySelector(".spot .nm")?.textContent ?? "";
/**
 * The next 30 s check, then the batched re-route it schedules, each in its OWN act: the check's new draft
 * must render before the re-route reads it, as it always has in a browser 1.5 s later. So this steps to
 * each tick by the clock rather than by a fixed 30 s, which would fold a later tick and its re-route
 * into one act.
 */
let mountedAt = 0;
let checks = 0;
async function nextCheck() {
  checks += 1;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(Math.max(0, mountedAt + checks * 30_000 + 200 - Date.now()));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_600);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  runHaulPlan.mockReset();
  runHaulPlan.mockImplementation(async (p: DraftPayloadItem[]) => routedPlan(p));
  loadArrivals.mockReset();
  loadArrivals.mockResolvedValue([]);
  shelveCardAction.mockReset();
  shelveCardAction.mockResolvedValue({
    ok: true,
    counts: { routed: 1, lines: 0, slots: 0, decisions: 0, wishlist: 0 },
    stamp: "stamp-after-shelve",
  });
  loadPendingPlacementDraft.mockReset();
  loadPendingPlacementDraft.mockResolvedValue([]);
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const mount = (initialPending = HAUL) => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  mountedAt = Date.now();
  checks = 0;
  render(createElement(PlanScreen, { stateStamp: "s", initialPending }));
  return user;
};

describe("UIL-114 · live arrivals", () => {
  it("an arrival joins the plan by itself, badged New and named with where it goes", async () => {
    mount();
    await screen.findAllByText("Abra");
    loadArrivals.mockResolvedValueOnce([waiting("Machop")]);
    await nextCheck();

    // PRE-FIX: nothing asks; Machop reaches the page only on a reload.
    await waitFor(() => expect(routes()).toHaveLength(2));
    expect(routes()[1]).toEqual(["id-Abra", "id-Kadabra", "id-Alakazam", "id-Machop"]);
    expect(
      await screen.findByText(/1 new card joined the plan: Machop → KB-001 · Front · Orange/),
    ).toBeTruthy();
    const row = screen.getAllByText("Machop")[0].closest(".row");
    expect(row?.textContent).toContain("New");
  });

  it("asks with every card it holds, so nothing it already has comes back twice", async () => {
    mount();
    await screen.findAllByText("Abra");
    await nextCheck();
    expect(loadArrivals).toHaveBeenCalledTimes(1);
    expect(loadArrivals.mock.calls[0][0]).toEqual(["id-Abra", "id-Kadabra", "id-Alakazam"]);
    expect(routes()).toHaveLength(1); // nothing arrived, so nothing re-routes
  });

  it("the spotlight stays on her card even when an arrival sorts ahead of it", async () => {
    const user = mount();
    await screen.findAllByText("Abra");
    await user.click(screen.getByRole("button", { name: "Skip ▶" }));
    await user.click(screen.getByRole("button", { name: "Skip ▶" }));
    expect(spotlightName()).toBe("Kadabra");
    loadArrivals.mockResolvedValueOnce([waiting("Aipom")]); // sorts first, A to Z
    await nextCheck();
    await screen.findByText(/1 new card joined the plan: Aipom/);
    expect(spotlightName()).toBe("Kadabra");
  });

  it("a card she left for later is not brought back by the next check", async () => {
    const user = mount();
    await screen.findAllByText("Abra");
    await user.click(screen.getByRole("button", { name: "Leave for later" })); // Abra
    // The server still has Abra waiting, which is the point of "Leave for later".
    loadArrivals.mockResolvedValue([waiting("Abra")]);
    await nextCheck();
    await nextCheck();
    expect(loadArrivals.mock.calls[0][0]).toContain("id-Abra");
    expect(screen.queryByText("Abra")).toBeNull();
    expect(screen.queryByText(/joined the plan/)).toBeNull();
  });

  it("the New badge goes once the card is shelved, from its row and the spotlight", async () => {
    const user = mount([waiting("Abra"), waiting("Onix")]);
    await screen.findAllByText("Abra");
    loadArrivals.mockResolvedValueOnce([waiting("Machop")]); // A to Z: Abra, Machop, Onix
    await nextCheck();
    await screen.findByText(/joined the plan: Machop/);
    await user.click(screen.getByRole("button", { name: "Skip ▶" }));
    await waitFor(() => expect(spotlightName()).toBe("MachopNew"));
    expect(document.querySelectorAll(".newcard")).toHaveLength(2); // its row and the spotlight
    await user.click(screen.getByRole("button", { name: /Done, next card/ })); // Machop
    await waitFor(() => expect(shelveCardAction).toHaveBeenCalledTimes(1));
    // Onix is still waiting, so the plan (not the finish line) is what is on screen.
    await waitFor(() => expect(spotlightName()).toBe("Onix"));
    expect(screen.getAllByText("Machop").length).toBeGreaterThan(0);
    expect(document.querySelector(".newcard")).toBeNull();
    await user.click(screen.getByRole("button", { name: "◀ Back" }));
    await waitFor(() => expect(spotlightName()).toBe("Machop")); // shelved: no badge in the spotlight either
  });

  it("with nothing on the page, an arrival is routed as the page would on open", async () => {
    mount([]);
    await screen.findByText(/Nothing is waiting to be placed/);
    loadArrivals.mockResolvedValueOnce([waiting("Machop")]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await screen.findAllByText("Machop");
    expect(routes()).toEqual([["id-Machop"]]);
  });

  it("asks when she comes back to the page", async () => {
    mount();
    await screen.findAllByText("Abra");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(loadArrivals).toHaveBeenCalledTimes(1);
  });

  it("a check that cannot reach the server says nothing, and the next one still asks", async () => {
    mount();
    await screen.findAllByText("Abra");
    loadArrivals.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await nextCheck();
    expect(screen.queryByRole("alert")).toBeNull();
    loadArrivals.mockResolvedValueOnce([waiting("Machop")]);
    await nextCheck();
    expect(await screen.findByText(/joined the plan: Machop/)).toBeTruthy();
  });

  it("does not ask while the page is still routing, when an arrival would miss the route in flight", async () => {
    runHaulPlan.mockImplementationOnce(() => new Promise(() => {}));
    mount();
    expect(screen.getByText("Routing 3 cards…")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(loadArrivals).not.toHaveBeenCalled();
  });

  it("nothing is New on a new haul, and the old note is gone", async () => {
    const user = mount([waiting("Abra")]);
    await screen.findAllByText("Abra");
    loadArrivals.mockResolvedValueOnce([waiting("Machop")]);
    await nextCheck();
    await screen.findByText(/joined the plan: Machop/);
    await user.click(screen.getByRole("button", { name: /Done, next card/ })); // Abra
    await waitFor(() => expect(spotlightName()).toBe("MachopNew"));
    await user.click(screen.getByRole("button", { name: "Leave for later" })); // Machop
    // The queue a new haul re-reads still has Machop, which she left for later.
    loadPendingPlacementDraft.mockResolvedValue([waiting("Machop")]);
    await user.click(await screen.findByRole("button", { name: "Start a new haul" }));
    await waitFor(() => expect(routes()).toContainEqual(["id-Machop"]));
    await screen.findAllByText("Machop");
    expect(document.querySelector(".newcard")).toBeNull();
    expect(screen.queryByText(/joined the plan/)).toBeNull();
  });

  it("two failed checks in a row say so once, quietly; a check that works clears it", async () => {
    mount();
    await screen.findAllByText("Abra");
    const lost = () => new TypeError("Failed to fetch"); // what a retired action ID looks like here
    loadArrivals.mockRejectedValueOnce(lost());
    await nextCheck();
    expect(screen.queryByText(ARRIVALS_LOST)).toBeNull(); // one miss is not worth a word
    loadArrivals.mockRejectedValueOnce(lost());
    await nextCheck();
    // PRE-FIX: silence, every 30 s, for as long as the tab stays open.
    expect(await screen.findByText(ARRIVALS_LOST)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull(); // a note, not an error
    loadArrivals.mockRejectedValueOnce(lost());
    await nextCheck();
    expect(screen.getAllByText(ARRIVALS_LOST)).toHaveLength(1); // still the one note
    await nextCheck(); // this one reaches the server
    await waitFor(() => expect(screen.queryByText(ARRIVALS_LOST)).toBeNull());
    // And the count starts again: one miss after a check that worked is still not worth a word.
    loadArrivals.mockRejectedValueOnce(lost());
    await nextCheck();
    expect(screen.queryByText(ARRIVALS_LOST)).toBeNull();
  });
});
