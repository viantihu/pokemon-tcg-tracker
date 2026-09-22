// @vitest-environment jsdom
/**
 * UIL-084, the display half — "MOVED" is a claim about the DATABASE, and a refused placement must not
 * survive as one.
 *
 * Her report: she overrode Toedscruel to KB-002 · BACK · ORANGE, the spotlight read
 * "MOVED · KB-002 · BACK · ORANGE" and the worklist row showed the Moved chip, and every Done failed
 * with "A line for this species and band already exists". So the screen reported a completed move for
 * a placement the server had rejected and never written — and reloading restored the same false claim,
 * because the override rides in the parked sitting (`ResumeState.overrides`).
 *
 * Driven through the REAL screen in a DOM (QA's rule for a click path): a sitting is parked in
 * sessionStorage with an override already set, the screen resumes from it, Done is clicked, and both
 * what she sees and what is left in storage are asserted. The two failure modes pinned here are the two
 * halves of her report:
 *
 *   1. before the write, neither surface claims the past tense (it reads "Will move" / "Your call");
 *   2. on a REFUSAL the override is dropped — from the screen and from the parked sitting — so a reload
 *      cannot restore it, and the refusal says her placement was not saved.
 *
 * A transport failure is deliberately NOT a refusal: the server never rejected the pick, so it is kept.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MoveDestination } from "@/lib/line/types";
import type { PlanItem } from "@/lib/plan";
import type { DraftCard, RunPlanResult } from "@/app/(ui)/plan/plan-types";
import { PlanScreen } from "@/app/(ui)/plan/PlanScreen";

const shelveCardAction = vi.fn();
const getMoveOptions = vi.fn(async () => ({
  binders: [
    { id: "kb1", name: "KB-001", type: "general" as const },
    { id: "kb2", name: "KB-002", type: "general" as const },
  ],
  collectionsByBinder: {},
  bands: [
    { key: "orange", display: "Orange" },
    { key: "red", display: "Red fire" },
  ],
}));
vi.mock("@/app/(ui)/plan/actions", () => ({
  shelveCardAction: (...a: unknown[]) => shelveCardAction(...a),
  getMoveOptions: () => getMoveOptions(),
  getLineJoinOptions: vi.fn(async () => null),
  loadPendingPlacementDraft: vi.fn(async () => []),
  lookupCatalog: vi.fn(async () => []),
  refreshSpotlightAction: vi.fn(async () => ({ ok: false, error: "not used" })),
  runHaulPlan: vi.fn(async () => ({ ok: false, error: "not used" })),
}));

const STAMP = "stamp-uil-084";
const RESUME_KEY = "binderops.plan.v1";
/** Her own case: the engine sends the extra copy to the front half; she overrides to KB-002 back. */
const OVERRIDE: MoveDestination = {
  kind: "shelf",
  binderId: "kb2",
  half: "back",
  band: "orange",
  lineJoin: { mode: "new" },
};
const REFUSAL =
  "A line for this species and band already exists — reload the screen and join it instead.";

const ITEM: PlanItem = {
  incomingId: "d-cruel",
  tcgdexId: "sv09-089",
  name: "Toedscruel",
  setId: "sv09",
  localId: "089",
  setCardCountOfficial: 159,
  imageUrl: null,
  variant: "normal",
  stage: "Stage1",
  isBasic: false,
  bandKey: "orange",
  action: "FRONT",
  destination: "KB-001 · Front · Orange",
  reason: "The Orange line already has this stage — the extra copy goes to the front half.",
  needsDecision: false,
};

/** A second, unremarkable card: with only one row the screen switches to its all-done view and the
 *  worklist disappears, so the state under test would have nowhere to render. */
const OTHER: PlanItem = {
  ...ITEM,
  incomingId: "d-cool",
  tcgdexId: "sv09-088",
  name: "Toedscool",
  localId: "088",
  isBasic: true,
  destination: "KB-001 · Front · Orange",
};

const DRAFT: DraftCard[] = [
  {
    id: "d-cruel",
    variant: "normal",
    card: {
      tcgdexId: "sv09-089",
      name: "Toedscruel",
      setId: "sv09",
      setName: "Journey Together",
      localId: "089",
      setCardCountOfficial: 159,
      stage: "Stage1",
      types: ["Fighting"],
      category: "Pokemon",
      trainerType: null,
      cardClass: "standard",
      imageUrl: null,
      variants: ["normal"],
    },
  },
  {
    id: "d-cool",
    variant: "normal",
    card: {
      tcgdexId: "sv09-088",
      name: "Toedscool",
      setId: "sv09",
      setName: "Journey Together",
      localId: "088",
      setCardCountOfficial: 159,
      stage: "Basic",
      types: ["Fighting"],
      category: "Pokemon",
      trainerType: null,
      cardClass: "standard",
      imageUrl: null,
      variants: ["normal"],
    },
  },
];

const PLAN: RunPlanResult = {
  groups: [
    {
      bandKey: "orange",
      count: 2,
      subgroups: [{ kind: "nonbasic", label: "STAGE 1 · 2", rows: [ITEM, OTHER] }],
    },
  ],
  bands: [{ key: "orange", count: 2 }],
  summary: { total: 2, decisions: 0, byAction: { FRONT: 2 } },
};

/** Park a sitting that already holds her override, exactly as the screen itself would have parked it. */
function parkWithOverride(overrides: Record<string, MoveDestination> = { "d-cruel": OVERRIDE }) {
  window.sessionStorage.setItem(
    RESUME_KEY,
    JSON.stringify({
      stamp: STAMP,
      haulId: "haul-1",
      source: "bulk-bin",
      notes: "",
      draft: DRAFT,
      plan: PLAN,
      done: [],
      cur: 0,
      overrides,
      collapsed: [],
      collapsedSubgroups: [],
    }),
  );
}

function parked(): { overrides: Record<string, MoveDestination>; done: string[] } {
  return JSON.parse(window.sessionStorage.getItem(RESUME_KEY) ?? "{}");
}

function mount() {
  render(createElement(PlanScreen, { stateStamp: STAMP }));
  return userEvent.setup();
}

/** HER card's row, by name — the fixture holds a second row that must not be mistaken for it. */
const row = () =>
  ([...document.querySelectorAll(".row")].find((r) =>
    r.textContent?.includes("Toedscruel"),
  ) as HTMLElement) ?? null;
const spotlight = () => document.querySelector(".spot") ?? document.body;
const doneButton = () =>
  screen.getByRole("button", { name: /Done, next card/ }) as HTMLButtonElement;

beforeEach(() => {
  window.sessionStorage.clear();
  shelveCardAction.mockReset();
});
afterEach(cleanup);

describe("UIL-084 · before the write, no surface claims the card has moved", () => {
  it("the row reads 'Will move' and the spotlight 'Your call', while both still name the pocket she must use", async () => {
    parkWithOverride();
    mount();

    // The destination she has to act on is the override, on both surfaces (UIL-037, unchanged).
    await waitFor(() => expect(within(row()).getByText(/Will move/)).toBeTruthy());
    expect(row().textContent).toContain("KB-002 · Back · Orange");
    expect(row().textContent).not.toContain("Moved");

    const spot = spotlight() as HTMLElement;
    expect(spot.textContent).toContain("Your call · KB-002 · Back · Orange");
    expect(spot.textContent).toContain("not saved until you press Done");
    expect(spot.textContent).not.toContain("Moved · KB-002");
  });
});

describe("UIL-084 · a REFUSED placement is dropped, from the screen and from the parked sitting", () => {
  it("clears the override, reverts the row to the cascade's own destination, and says the placement was not saved", async () => {
    parkWithOverride();
    expect(parked().overrides["d-cruel"]).toBeDefined(); // the false claim she could reload into
    shelveCardAction.mockResolvedValue({ ok: false, error: REFUSAL });
    const user = mount();

    await waitFor(() => expect(doneButton()).toBeTruthy());
    await user.click(doneButton());

    // The server's own words, plus what it means for her next action.
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(REFUSAL));
    expect(screen.getByRole("alert").textContent).toContain(
      "Your manual placement was not saved — pick a destination again",
    );

    // Nothing claims a move any more, and the row is back to the cascade's destination.
    expect(row().textContent).not.toContain("Will move");
    expect(row().textContent).not.toContain("Moved");
    expect(row().textContent).toContain("KB-001 · Front · Orange");
    expect(row().textContent).not.toContain("KB-002");

    // And the parked sitting cannot restore it — this is why her reload reproduced the dead end.
    await waitFor(() => expect(parked().overrides["d-cruel"]).toBeUndefined());
    expect(parked().done).toEqual([]);
  });

  it("KEEPS the override when the call itself failed — a transport error is not the server refusing her pick", async () => {
    parkWithOverride();
    shelveCardAction.mockRejectedValue(new Error("Failed to fetch"));
    const user = mount();

    await waitFor(() => expect(doneButton()).toBeTruthy());
    await user.click(doneButton());

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).not.toContain("was not saved");
    expect(row().textContent).toContain("Will move");
    expect(parked().overrides["d-cruel"]).toBeDefined();
  });
});

describe("UIL-084 · once the write lands, 'Moved' is true", () => {
  it("promotes both surfaces to the past tense and keeps the override in the parked sitting", async () => {
    parkWithOverride();
    shelveCardAction.mockResolvedValue({
      ok: true,
      haulId: "haul-1",
      counts: { copies: 1, lines: 1, slots: 2, decisions: 1, wishlist: 0, blocks: 0 },
      stamp: STAMP,
    });
    const user = mount();

    await waitFor(() => expect(doneButton()).toBeTruthy());
    await user.click(doneButton());

    // The row keeps her card on screen and now says the true thing.
    await waitFor(() => expect(within(row()).getByText(/^Moved$/)).toBeTruthy());
    expect(row().textContent).not.toContain("Will move");
    expect(screen.queryByRole("alert")).toBeNull();

    // A successful Done advances the spotlight to the next card, so step back to read her card's own
    // panel — the same control she would use — and check the panel makes the past-tense claim too.
    await user.click(screen.getByRole("button", { name: /◀ Back/ }));
    await waitFor(() =>
      expect((spotlight() as HTMLElement).textContent).toContain("Moved · KB-002 · Back · Orange"),
    );
    expect((spotlight() as HTMLElement).textContent).not.toContain(
      "not saved until you press Done",
    );
    expect(screen.getByRole("button", { name: /Shelved ✓/ })).toBeTruthy();

    await waitFor(() => expect(parked().done).toEqual(["d-cruel"]));
    expect(parked().overrides["d-cruel"]).toBeDefined();
  });
});
