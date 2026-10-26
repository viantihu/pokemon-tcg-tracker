// @vitest-environment jsdom
/**
 * "Wrong card?" on the Haul Plan's spotlight (Karvi, 2026-10-26): the sync matched a copy to the wrong card, and she
 * fixes it where she finds out. Pinned through the REAL screen in a DOM:
 *   - the button is on a waiting card's spotlight, beside "Leave for later" and "Not mine", and not on a shelved one;
 *   - picking the right card rematches THAT copy and routes the plan again with the new card, spotlight kept;
 *   - a refusal (the card was shelved in another tab) is said in the sheet, and nothing changes on the screen;
 *   - the sheet offers the stand-in form, worded as a rematch (the twin rule itself is pinned in tests/copy/rematch).
 */
import { createElement } from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftCard, DraftPayloadItem, LookupCard } from "@/app/(ui)/plan/plan-types";
import { PlanScreen } from "@/app/(ui)/plan/PlanScreen";
import { routedPlan } from "../support/plan-route";

const runHaulPlan = vi.fn();
const rematchCopyAction = vi.fn();
const rematchToStandInAction = vi.fn();
const lookupCatalog = vi.fn();
vi.mock("@/app/(ui)/plan/actions", () => ({
  shelveCardAction: vi.fn(),
  getMoveOptions: vi.fn(async () => ({ binders: [], collectionsByBinder: {}, bands: [] })),
  getLineJoinOptions: vi.fn(async () => null),
  loadPendingPlacementDraft: vi.fn(async () => []),
  lookupCatalog: (...a: unknown[]) => lookupCatalog(...a),
  refreshSpotlightAction: vi.fn(async () => ({ ok: false, error: "not used" })),
  runHaulPlan: (...a: unknown[]) => runHaulPlan(...a),
  planStateStamp: vi.fn(async () => "stamp-routed"),
  loadStandInCardTypes: vi.fn(async () => ["Fire", "Grass"]),
  rematchCopyAction: (...a: unknown[]) => rematchCopyAction(...a),
  rematchToStandInAction: (...a: unknown[]) => rematchToStandInAction(...a),
}));
vi.mock("@/app/(ui)/look/actions", () => ({ removeCopy: vi.fn() }));

const card = (name: string, localId = "017"): LookupCard => ({
  tcgdexId: `sv09-${name}`,
  name,
  setId: "sv09",
  setName: "Journey Together",
  localId,
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
const HAUL = [waiting("Abra"), waiting("Kadabra")];

const spotlightName = () => document.querySelector(".spot")?.textContent ?? "";
const lastRoute = () => {
  const calls = runHaulPlan.mock.calls;
  return (calls[calls.length - 1][0] as DraftPayloadItem[]).map((d) => [d.id, d.tcgdexId]);
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  runHaulPlan.mockReset();
  runHaulPlan.mockImplementation(async (p: DraftPayloadItem[]) => routedPlan(p));
  rematchCopyAction.mockReset();
  rematchToStandInAction.mockReset();
  lookupCatalog.mockReset();
  lookupCatalog.mockResolvedValue([card("Alakazam", "065")]);
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function mount() {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(createElement(PlanScreen, { stateStamp: "s", initialPending: HAUL }));
  await screen.findAllByText("Abra");
  return user;
}

/** Open the sheet and type a search that finds Alakazam. */
async function searchFromSheet(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Wrong card?" }));
  await user.type(screen.getByPlaceholderText("Find the real card…"), "Alakazam");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  return screen.findByRole("option", { name: /Alakazam/ });
}

describe("Wrong card? on the spotlight", () => {
  it("offers it beside the two ways a card leaves the plan", async () => {
    await mount();
    expect(screen.getByRole("button", { name: "Wrong card?" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Leave for later" })).toBeTruthy();
  });

  it("rematches THAT copy to the card she picks, and routes the plan again with it", async () => {
    rematchCopyAction.mockResolvedValue({ ok: true, card: card("Alakazam", "065") });
    const user = await mount();
    expect(spotlightName()).toContain("Abra");
    const calls = runHaulPlan.mock.calls.length;

    await user.click(await searchFromSheet(user));

    expect(rematchCopyAction).toHaveBeenCalledWith("id-Abra", "sv09-Alakazam");
    // The sheet closes and the plan routes again with the NEW card for that copy; the other copy is untouched.
    await waitFor(() => expect(runHaulPlan.mock.calls.length).toBe(calls + 1));
    expect(lastRoute()).toEqual([
      ["id-Abra", "sv09-Alakazam"],
      ["id-Kadabra", "sv09-Kadabra"],
    ]);
    expect(screen.queryByText("WRONG CARD?")).toBeNull();
    await waitFor(() => expect(spotlightName()).toContain("Alakazam"));
    expect(screen.getByText(/Rematched · Abra → Alakazam/)).toBeTruthy();
  });

  it("says a refusal in the sheet, and the card on the screen does not change", async () => {
    rematchCopyAction.mockResolvedValue({
      ok: false,
      error: "That card has already been shelved, so it cannot be rematched here.",
    });
    const user = await mount();
    const calls = runHaulPlan.mock.calls.length;

    await user.click(await searchFromSheet(user));

    const sheet = screen.getByText("WRONG CARD?").closest(".dsheet") as HTMLElement;
    expect(await within(sheet).findByText(/already been shelved/)).toBeTruthy();
    expect(runHaulPlan.mock.calls.length).toBe(calls);
    expect(spotlightName()).toContain("Abra");
  });

  it("closes without changing anything", async () => {
    const user = await mount();
    await user.click(screen.getByRole("button", { name: "Wrong card?" }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("WRONG CARD?")).toBeNull();
    expect(rematchCopyAction).not.toHaveBeenCalled();
  });

  it("offers the stand-in form in the sheet, worded as a rematch", async () => {
    const user = await mount();
    await user.click(screen.getByRole("button", { name: "Wrong card?" }));
    expect(
      await screen.findByText("Not in the catalog? Create a stand-in and rematch to it"),
    ).toBeTruthy();
  });
});
