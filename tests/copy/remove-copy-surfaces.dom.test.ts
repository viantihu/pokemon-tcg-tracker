// @vitest-environment jsdom
/**
 * UIL-089, the click paths — "remove this copy" is on every surface that shows a copy, and on two of them
 * it sits beside a DIFFERENT removal that must not be confused with it.
 *
 * The confusable pair is the point of this file: the Haul Plan queue row's ✕ takes a card off today's
 * sitting and leaves it in the queue, and it deletes nothing. "Not mine" beside it does. If those ever
 * collapse into each other she loses cards she still owns, so each is asserted to call its own thing and
 * not the other's.
 *
 * Collections has the same pair — its "Remove ▸" takes a card off a list and RE-HOMES the copies (UIL-014)
 * — and that one is pinned where its fixtures already live, in tests/coll/collection-fold.test.ts, along
 * with the rule that "Not mine" is only offered where it is unambiguous.
 *
 * Driven through the real components in a DOM, because the confirm step only exists under a click.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoveCopyButton } from "@/app/(ui)/_components/RemoveCopyButton";
import type { DraftCard, DraftPayloadItem, LookupCard } from "@/app/(ui)/plan/plan-types";
import { routedPlan } from "../support/plan-route";
import { PlanScreen } from "@/app/(ui)/plan/PlanScreen";

const removeCopyAction = vi.fn(async () => ({ ok: true as const, lookup: null }));
vi.mock("@/app/(ui)/look/actions", () => ({
  removeCopy: (...a: unknown[]) => removeCopyAction(...(a as [])),
}));
vi.mock("@/app/(ui)/plan/actions", () => ({
  shelveCardAction: vi.fn(),
  getMoveOptions: vi.fn(async () => ({ binders: [], collectionsByBinder: {}, bands: [] })),
  getLineJoinOptions: vi.fn(async () => null),
  loadPendingPlacementDraft: vi.fn(async () => []),
  lookupCatalog: vi.fn(async () => []),
  refreshSpotlightAction: vi.fn(async () => ({ ok: false, error: "not used" })),
  // UIL-114: the page routes what is waiting as it opens.
  runHaulPlan: (p: DraftPayloadItem[]) => runHaulPlan(p),
  planStateStamp: vi.fn(async () => "stamp-routed"),
}));
const runHaulPlan = vi.fn(async (p: DraftPayloadItem[]) => routedPlan(p));

afterEach(() => {
  cleanup();
  removeCopyAction.mockClear();
  window.sessionStorage.clear();
});

describe("UIL-089 · the Remove button asks once, then acts", () => {
  it("the first tap arms it and writes nothing; the second tap writes", async () => {
    // A mis-tap on a phone at a card show would otherwise delete a card with no undo (Sync Undo reverses an
    // import, not a hand removal), so the confirm is load-bearing rather than politeness.
    const onRemove = vi.fn();
    const user = userEvent.setup();
    render(createElement(RemoveCopyButton, { onRemove, what: "Meditite" }));

    await user.click(screen.getByRole("button", { name: /Remove Meditite/i }));
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.getByText(/Remove Meditite\?/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Yes, remove/i }));
    await waitFor(() => expect(onRemove).toHaveBeenCalledTimes(1));
  });

  it('"Keep it" disarms and never writes', async () => {
    const onRemove = vi.fn();
    const user = userEvent.setup();
    render(createElement(RemoveCopyButton, { onRemove, what: "Meditite" }));
    await user.click(screen.getByRole("button", { name: /Remove Meditite/i }));
    await user.click(screen.getByRole("button", { name: /Keep it/i }));
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Remove Meditite/i })).toBeTruthy();
  });

  it("asks nothing else — no reason field, no dropdown (Karvi: no reason is necessary)", async () => {
    const user = userEvent.setup();
    render(createElement(RemoveCopyButton, { onRemove: vi.fn(), what: "Meditite" }));
    await user.click(screen.getByRole("button", { name: /Remove Meditite/i }));
    // The armed state is two buttons and a sentence. Anything she has to fill in is out of scope by ruling.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("stays armed while the write is in flight, so a failure leaves her decision on screen", async () => {
    // Armed first, THEN busy: that is the real sequence, and it also proves the resting button is disabled
    // while something else is writing — a click on it cannot arm a second removal mid-flight.
    const onRemove = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      createElement(RemoveCopyButton, { onRemove, busy: false, what: "Meditite" }),
    );
    await user.click(screen.getByRole("button", { name: /Remove Meditite/i }));
    rerender(createElement(RemoveCopyButton, { onRemove, busy: true, what: "Meditite" }));

    expect(screen.getByRole("button", { name: /Removing…/i })).toBeTruthy();
    expect(screen.getByText(/Remove Meditite\?/)).toBeTruthy(); // her decision is still on screen
    expect(screen.getByRole("button", { name: /Removing…/i })).toHaveProperty("disabled", true);
  });
});

/* ------------------------- the Haul Plan queue row's two removals ------------------------- */

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

/** A queue row: a copy that already exists, waiting to be placed (UIL-003). */
const QUEUED: DraftCard = {
  id: "11111111-1111-4111-8111-111111111111",
  existingCopyId: "11111111-1111-4111-8111-111111111111",
  card: card("Meditite"),
  variant: "normal",
  dexVariantRaw: "Normal",
};

/** A second card, so taking one off leaves a plan to look at rather than the empty state. */
const MACHOP: DraftCard = {
  id: "22222222-2222-4222-8222-222222222222",
  existingCopyId: "22222222-2222-4222-8222-222222222222",
  card: card("Machop"),
  variant: "normal",
  dexVariantRaw: "Normal",
};

describe("UIL-089 / UIL-114 · the Haul Plan keeps its two removals apart, once the haul has run", () => {
  // Since UIL-114 there is no first screen: the plan routes as the page opens, and both removals live in the
  // spotlight on the card she is holding. Machop sorts first, so it is the one in hand.
  it('"Not mine" removes the COPY, and takes the card off the plan', async () => {
    const user = userEvent.setup();
    render(createElement(PlanScreen, { stateStamp: "s", initialPending: [QUEUED, MACHOP] }));
    await screen.findAllByText("Machop");

    await user.click(screen.getByRole("button", { name: /Remove Machop from your collection/i }));
    await user.click(screen.getByRole("button", { name: /Yes, remove/i }));

    await waitFor(() => expect(removeCopyAction).toHaveBeenCalledWith(MACHOP.existingCopyId));
    // The copy it stood for is gone, so the card goes too — leaving it would offer her a card she does not
    // have, and the next queue read would not return it anyway.
    await waitFor(() => expect(screen.queryByText("Machop")).toBeNull());
    expect(screen.getAllByText("Meditite").length).toBeGreaterThan(0);
  });

  it('"Leave for later" takes the card off this PLAN and writes nothing — it stays waiting', async () => {
    // The confusable pair. If these two ever collapse into each other she loses cards she still owns.
    const user = userEvent.setup();
    render(createElement(PlanScreen, { stateStamp: "s", initialPending: [QUEUED, MACHOP] }));
    await screen.findAllByText("Machop");

    await user.click(screen.getByRole("button", { name: "Leave for later" }));
    await waitFor(() => expect(screen.queryByText("Machop")).toBeNull());
    expect(removeCopyAction).not.toHaveBeenCalled(); // nothing was deleted
  });
});
