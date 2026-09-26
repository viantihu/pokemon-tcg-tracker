// @vitest-environment jsdom
/**
 * UIL-115 — "Search haul", through the REAL Haul Plan screen. Karvi: "I'm loading hundreds of cards at a
 * time." The rulings pinned here:
 *   - results lead with the card's image (her visual-search principle), in the app's usual tiles, each
 *     saying where the card goes;
 *   - shelved cards are included, marked Done;
 *   - picking a tile puts the card in the spotlight and scrolls its row into view, unfolding its band;
 *   - at most 60 tiles at once, with "Show more".
 * The matching rule itself is tests/plan/haul-search.test.ts.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftCard, DraftPayloadItem, LookupCard } from "@/app/(ui)/plan/plan-types";
import { PlanScreen } from "@/app/(ui)/plan/PlanScreen";
import { routedPlan } from "../support/plan-route";

const shelveCardAction = vi.fn();
vi.mock("@/app/(ui)/plan/actions", () => ({
  shelveCardAction: (...a: unknown[]) => shelveCardAction(...a),
  getMoveOptions: vi.fn(async () => ({
    binders: [
      { id: "kb1", name: "KB-001", type: "general" as const },
      { id: "kb2", name: "KB-002", type: "general" as const },
    ],
    collectionsByBinder: {},
    bands: [{ key: "orange", display: "Orange" }],
  })),
  getLineJoinOptions: vi.fn(async () => null),
  loadPendingPlacementDraft: vi.fn(async () => []),
  loadArrivals: vi.fn(async () => []),
  lookupCatalog: vi.fn(async () => []),
  refreshSpotlightAction: vi.fn(async () => ({ ok: false, error: "not used" })),
  runHaulPlan: vi.fn(async (p: DraftPayloadItem[]) => routedPlan(p)),
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
const HAUL = ["Abra", "Kadabra", "Alakazam", "Machop"].map(waiting);

const spotlightName = () => document.querySelector(".spot .nm")?.textContent ?? "";
const tiles = () =>
  within(screen.getByRole("list", { name: "Cards in this haul that match" })).getAllByRole(
    "listitem",
  );
const searchBox = () => screen.getByRole("searchbox", { name: "Search haul" });

let scrolled: string[] = [];
beforeEach(() => {
  scrolled = [];
  // jsdom has no layout, so no scrollIntoView: record which element was asked to scroll.
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.id);
  };
  shelveCardAction.mockReset();
  shelveCardAction.mockResolvedValue({
    ok: true,
    counts: { routed: 1, lines: 0, slots: 0, decisions: 0, wishlist: 0 },
    stamp: "stamp-after-shelve",
  });
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

async function mount(initialPending = HAUL) {
  const user = userEvent.setup();
  render(createElement(PlanScreen, { stateStamp: "s", initialPending }));
  await screen.findAllByText(initialPending[0].card.name);
  return user;
}

describe("UIL-115 · Search haul", () => {
  it("finds cards as they are typed, as image-led tiles that say where each goes", async () => {
    const user = await mount();
    // PRE-FIX: there is no search box on the Haul Plan at all.
    await user.type(searchBox(), "ka");
    expect(tiles().map((t) => t.querySelector(".cn")?.textContent)).toEqual([
      "Alakazam",
      "Kadabra",
    ]);
    for (const t of tiles()) {
      expect(t.querySelector(".face")).not.toBeNull(); // the card's face leads the tile
      expect(t.textContent).toContain("KB-001 · Front · Orange");
      expect(t.textContent).toContain("017/159");
    }
    expect(screen.getByText("2 cards match")).toBeTruthy();
  });

  it("includes a card she has already shelved, marked Done", async () => {
    const user = await mount();
    await user.click(screen.getByRole("button", { name: /Done, next card/ })); // Abra
    await waitFor(() => expect(shelveCardAction).toHaveBeenCalledTimes(1));
    await user.type(searchBox(), "abra");
    const abra = tiles().find((t) => t.querySelector(".cn")?.textContent === "Abra");
    expect(abra?.textContent).toContain("Done");
    const kadabra = tiles().find((t) => t.querySelector(".cn")?.textContent === "Kadabra");
    expect(kadabra?.textContent).not.toContain("Done");
  });

  it("picking a tile puts the card in the spotlight and scrolls its row into view", async () => {
    const user = await mount();
    expect(spotlightName()).toContain("Abra");
    await user.type(searchBox(), "machop");
    await user.click(tiles()[0]);
    expect(spotlightName()).toContain("Machop");
    await waitFor(() => expect(scrolled).toEqual(["plan-row-id-Machop"]));
    // The query stays, so she can pick the next one.
    expect((searchBox() as HTMLInputElement).value).toBe("machop");
  });

  it("a card in a band she has folded: the band opens so its row can be seen", async () => {
    const user = await mount();
    await user.click(document.querySelector(".bandhead") as HTMLElement); // fold the band
    expect(document.getElementById("plan-row-id-Machop")).toBeNull();
    await user.type(searchBox(), "machop");
    await user.click(tiles()[0]);
    await waitFor(() => expect(document.getElementById("plan-row-id-Machop")).not.toBeNull());
    await waitFor(() => expect(scrolled).toEqual(["plan-row-id-Machop"]));
  });

  it("shows 60 at a time, and Show more adds the rest", async () => {
    const many = Array.from({ length: 130 }, (_, i) => waiting(`Mon${String(i).padStart(3, "0")}`));
    const user = await mount(many);
    await user.type(searchBox(), "mon");
    expect(tiles()).toHaveLength(60);
    expect(screen.getByText("130 cards match · showing 60")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Show more (70 more)" }));
    expect(tiles()).toHaveLength(120);
    await user.click(screen.getByRole("button", { name: "Show more (10 more)" }));
    expect(tiles()).toHaveLength(130);
    expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();
    // A new query starts from 60 again, even one with more than 60 matches.
    await user.clear(searchBox());
    await user.type(searchBox(), "mon0"); // Mon000 to Mon099
    expect(tiles()).toHaveLength(60);
    expect(screen.getByText("100 cards match · showing 60")).toBeTruthy();
  });

  it("says so when nothing matches, and Clear puts the plan back as it was", async () => {
    const user = await mount();
    await user.type(searchBox(), "zzz");
    expect(screen.getByText("No card in this haul matches “zzz”.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect((searchBox() as HTMLInputElement).value).toBe("");
    expect(screen.queryByText(/No card in this haul matches/)).toBeNull();
    expect(screen.queryByRole("list", { name: "Cards in this haul that match" })).toBeNull();
  });

  it("a card she moved shows where she moved it, as its row does", async () => {
    window.sessionStorage.setItem(
      "binderops.plan.v1",
      JSON.stringify({
        stamp: "s",
        draft: HAUL,
        plan: routedPlan(HAUL.map((d) => ({ ...d, tcgdexId: d.card.tcgdexId }))),
        done: [],
        cur: 0,
        overrides: {
          "id-Machop": { kind: "shelf", binderId: "kb2", half: "back", band: "orange" },
        },
        collapsed: [],
        collapsedSubgroups: [],
      }),
    );
    const user = await mount();
    const row = () => document.getElementById("plan-row-id-Machop");
    await waitFor(() => expect(row()?.textContent).toContain("KB-002"));
    await user.type(searchBox(), "machop");
    expect(tiles()[0].textContent).toContain("KB-002");
    expect(tiles()[0].textContent).not.toContain("KB-001 · Front · Orange");
  });
});
