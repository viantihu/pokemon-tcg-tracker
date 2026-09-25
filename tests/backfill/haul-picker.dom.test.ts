// @vitest-environment jsdom
/**
 * UIL-098, the screen half — driven through the REAL BackfillScreen in a DOM (QA's rule for a click path).
 *
 * Backfill's card-she-owns pickers offer only what is waiting in her haul, one tile per printing + Dex
 * variant with how many wait; what this form has already picked is subtracted, so a tile never offers the
 * same copy twice; nothing waiting says "import it first"; a save sends the Dex variant, never a chosen
 * one. And the Senior BA's ruling (a): when the server refuses a LINE because a card it names is not
 * waiting, her entries STAY on screen, so she can import the card and save the line again.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackfillScreen, NOT_WAITING_EMPTY } from "@/app/(ui)/backfill/BackfillScreen";
import type { BackfillContextPayload, WaitingCard } from "@/app/(ui)/backfill/backfill-types";
import type { ResolvedBackLine } from "@/lib/backfill";
import type { LookupCard } from "@/app/(ui)/plan/plan-types";
import * as actions from "@/app/(ui)/backfill/actions";

vi.mock("@/app/(ui)/backfill/actions", () => ({
  commitFrontAction: vi.fn(),
  commitLineAction: vi.fn(),
  commitSpecialtyAction: vi.fn(),
  loadContext: vi.fn(),
  lookupCatalog: vi.fn(),
  resolveLine: vi.fn(),
  searchWaiting: vi.fn(),
}));

const CHARMANDER: LookupCard = {
  tcgdexId: "sv03-026",
  name: "Charmander",
  setId: "sv03",
  setName: "Obsidian Flames",
  localId: "026",
  setCardCountOfficial: 197,
  stage: "Basic",
  types: ["Fire"],
  category: "Pokemon",
  trainerType: null,
  cardClass: "standard",
  imageUrl: null,
  variants: ["normal", "reverse"],
};
const waiting = (dexVariantRaw: string, n: number): WaitingCard => ({
  ...CHARMANDER,
  dexVariantRaw,
  waiting: n,
  badge: `${dexVariantRaw} · ${n} waiting`,
});

const CTX: BackfillContextPayload = {
  binders: [{ id: "b1", name: "Binder 1", type: "general", isActive: true }],
  collections: [],
  bands: [{ key: "red", display: "Red" }],
  typeColorMap: { Fire: "red" },
};

const LINE: ResolvedBackLine = {
  rootDexId: 4,
  speciesName: "Charmander",
  bandKey: "red",
  requiredType: "Fire",
  seedStageIndex: 0,
  stages: [
    {
      stageIndex: 0,
      stage: "Basic",
      dexId: 4,
      name: "Charmander",
      sameColorPrintingExists: true,
      specialtyOnly: false,
      suggestedTargetId: "sv03-026",
      alternateTargetIds: [],
    },
  ],
};

const m = vi.mocked(actions);
const REFUSAL =
  "Charmander (Normal) is not waiting in your haul. Add it in Dex, import it on the Sync page, then save this line.";

beforeEach(() => {
  vi.clearAllMocks();
  m.loadContext.mockResolvedValue(CTX);
  m.searchWaiting.mockResolvedValue([waiting("Normal", 1), waiting("Reverse Holo", 2)]);
  m.lookupCatalog.mockResolvedValue([CHARMANDER]);
  m.resolveLine.mockResolvedValue(LINE);
});
afterEach(cleanup);

async function typeInto(user: ReturnType<typeof userEvent.setup>, box: HTMLElement, q: string) {
  await user.clear(box);
  await user.type(box, q);
}
const tiles = () => [...document.querySelectorAll(".cgrid button")] as HTMLElement[];

describe("UIL-098 · Backfill picks from her haul", () => {
  it("tiles are one per Dex variant, with how many wait, from the WAITING search (not the catalog)", async () => {
    const user = userEvent.setup();
    render(createElement(BackfillScreen));
    await typeInto(user, await screen.findByLabelText("Card lookup"), "Char");

    await waitFor(() => expect(tiles()).toHaveLength(2));
    expect(m.searchWaiting).toHaveBeenCalledWith("Char");
    expect(m.lookupCatalog).not.toHaveBeenCalled();
    expect(tiles().map((t) => t.textContent)).toEqual([
      expect.stringContaining("Normal · 1 waiting"),
      expect.stringContaining("Reverse Holo · 2 waiting"),
    ]);
  });

  it("a picked copy is subtracted: the last Normal is gone from the tiles, the Reverse Holo count drops", async () => {
    const user = userEvent.setup();
    render(createElement(BackfillScreen));
    const box = await screen.findByLabelText("Card lookup");
    await typeInto(user, box, "Char");
    await waitFor(() => expect(tiles()).toHaveLength(2));
    await user.click(tiles()[0]); // Normal, the only one waiting
    await typeInto(user, box, "Char");
    // The Normal is gone at once: its one waiting copy is on this form.
    await waitFor(() => expect(tiles()).toHaveLength(1));
    expect(tiles()[0].textContent).toContain("Reverse Holo · 2 waiting");
    await user.click(tiles()[0]); // one of the two Reverse Holos

    await typeInto(user, box, "Char");
    await waitFor(() => expect(tiles()).toHaveLength(1));
    expect(tiles()[0].textContent).toContain("Reverse Holo · 1 waiting");
    // The rows show Dex's variant, not a picker.
    expect(screen.getByText("Waiting from sync · Normal")).toBeTruthy();
    expect(screen.getByText("Waiting from sync · Reverse Holo")).toBeTruthy();
  });

  it("nothing waiting says to import the card first", async () => {
    m.searchWaiting.mockResolvedValue([]);
    const user = userEvent.setup();
    render(createElement(BackfillScreen));
    await typeInto(user, await screen.findByLabelText("Card lookup"), "Pikachu");
    expect(await screen.findByText(NOT_WAITING_EMPTY)).toBeTruthy();
  });

  it("the save sends each card's Dex variant — there is no variant to choose", async () => {
    m.commitFrontAction.mockResolvedValue({
      ok: true,
      counts: { placed: 1, lines: 0, slots: 0, blocks: 0, wishlist: 0, decisions: 1 },
    });
    const user = userEvent.setup();
    render(createElement(BackfillScreen));
    await typeInto(user, await screen.findByLabelText("Card lookup"), "Char");
    await waitFor(() => expect(tiles()).toHaveLength(2));
    await user.click(tiles()[1]);
    await user.click(screen.getByRole("button", { name: "Save front half" }));

    expect(m.commitFrontAction).toHaveBeenCalledWith({
      binderId: "b1",
      half: "front",
      cards: [{ tcgdexId: "sv03-026", dexVariantRaw: "Reverse Holo" }],
    });
    expect(await screen.findByText("Saved 1 card(s) to the front half.")).toBeTruthy();
  });
});

describe("UIL-098 · a refused line keeps what she entered", () => {
  it("the refusal is shown, and the line form, its FILLED card and Save line are all still there", async () => {
    m.commitLineAction.mockResolvedValue({ ok: false, error: REFUSAL });
    const user = userEvent.setup();
    render(createElement(BackfillScreen));
    await user.click(await screen.findByRole("button", { name: "Back half" }));

    // Start the line from the CATALOG species picker…
    await typeInto(user, screen.getByLabelText("Card lookup"), "Char");
    await waitFor(() => expect(tiles()).toHaveLength(1));
    expect(m.lookupCatalog).toHaveBeenCalled();
    await user.click(tiles()[0]);

    // …then pick the Basic she owns from her HAUL, in the stage's own picker.
    const stageBox = await screen.findByLabelText("Card lookup");
    await typeInto(user, stageBox, "Char");
    await waitFor(() => expect(tiles()).toHaveLength(2));
    expect(m.searchWaiting).toHaveBeenCalled();
    await user.click(tiles()[0]);
    await user.click(screen.getByRole("button", { name: "Save line" }));

    expect(await screen.findByText(REFUSAL)).toBeTruthy();
    // Nothing she entered was dropped (the UIL-092 lesson).
    const form = document.querySelector(".lineform") as HTMLElement;
    expect(form).not.toBeNull();
    expect(within(form).getByText("Waiting from sync · Normal")).toBeTruthy();
    expect(within(form).getByRole("button", { name: "Save line" })).toBeTruthy();
    expect(m.commitLineAction).toHaveBeenCalledWith(
      expect.objectContaining({
        stages: [
          expect.objectContaining({
            decision: "filled",
            filledTcgdexId: "sv03-026",
            filledDexVariantRaw: "Normal",
          }),
        ],
      }),
    );
  });
});
