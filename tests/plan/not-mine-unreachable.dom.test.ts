// @vitest-environment jsdom
/**
 * UIL-106 (2) — the Haul Plan's "Not mine", and the Remove button itself, when the call cannot reach the
 * server at all.
 *
 * A server action THROWS when the app was redeployed under an open page or the connection dropped. "Not
 * mine" set `shelving` and awaited the removal with nothing to catch a throw, so `shelving` never cleared
 * and nothing said why — and `shelveCard` refuses while `shelving` is set, so every Done after it did
 * nothing, silently. Driven through the REAL screen in a DOM with the removal scripted to reject, then the
 * plan run and Done pressed, which is where she would have felt it.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanItem } from "@/lib/plan";
import type { DraftCard, LookupCard, RunPlanResult } from "@/app/(ui)/plan/plan-types";
import { LOST } from "@/app/(ui)/_components/reach";
import { RemoveCopyButton } from "@/app/(ui)/_components/RemoveCopyButton";
import { PlanScreen } from "@/app/(ui)/plan/PlanScreen";

const removeCopy = vi.fn();
vi.mock("@/app/(ui)/look/actions", () => ({
  removeCopy: (...a: unknown[]) => removeCopy(...a),
}));
const shelveCardAction = vi.fn();
const runHaulPlan = vi.fn();
vi.mock("@/app/(ui)/plan/actions", () => ({
  shelveCardAction: (...a: unknown[]) => shelveCardAction(...a),
  getMoveOptions: vi.fn(async () => ({ binders: [], collectionsByBinder: {}, bands: [] })),
  getLineJoinOptions: vi.fn(async () => null),
  loadPendingPlacementDraft: vi.fn(async () => []),
  lookupCatalog: vi.fn(async () => []),
  refreshSpotlightAction: vi.fn(async () => ({ ok: false, error: "not used" })),
  runHaulPlan: (...a: unknown[]) => runHaulPlan(...a),
}));

const LOST_CALL = () => new TypeError("Failed to fetch");

const card = (name: string, localId: string): LookupCard => ({
  tcgdexId: `sv09-${localId}`,
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
const queued = (id: string, name: string, localId: string): DraftCard => ({
  id,
  existingCopyId: id,
  card: card(name, localId),
  variant: "normal",
  dexVariantRaw: "Normal",
});
const MEDITITE = queued("11111111-1111-4111-8111-111111111111", "Meditite", "017");
const MAKUHITA = queued("22222222-2222-4222-8222-222222222222", "Makuhita", "018");

const item = (d: DraftCard): PlanItem => ({
  incomingId: d.id,
  tcgdexId: d.card.tcgdexId,
  name: d.card.name,
  setId: "sv09",
  localId: d.card.localId as string,
  setCardCountOfficial: 159,
  imageUrl: null,
  variant: "normal",
  stage: "Basic",
  isBasic: true,
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
      subgroups: [{ kind: "basic", label: "BASIC · 2", rows: [item(MEDITITE), item(MAKUHITA)] }],
    },
  ],
  bands: [{ key: "orange", count: 2 }],
  summary: { total: 2, decisions: 0, byAction: { FRONT: 2 } },
};

const alerts = () =>
  screen
    .queryAllByRole("alert")
    .map((a) => a.textContent)
    .join(" | ");

beforeEach(() => {
  removeCopy.mockReset();
  shelveCardAction.mockReset();
  runHaulPlan.mockReset();
  runHaulPlan.mockResolvedValue(PLAN);
  shelveCardAction.mockResolvedValue({ ok: false, error: "stop here" });
  window.sessionStorage.clear();
});
afterEach(cleanup);

describe("UIL-106 · 'Not mine' that cannot reach the server", () => {
  it("says so, keeps the row, and Done still works afterwards", async () => {
    removeCopy.mockRejectedValue(LOST_CALL());
    const user = userEvent.setup();
    render(createElement(PlanScreen, { stateStamp: "s", initialPending: [MEDITITE, MAKUHITA] }));
    await screen.findByText("Meditite");

    await user.click(screen.getByRole("button", { name: /Remove Meditite from your collection/ }));
    await user.click(screen.getByRole("button", { name: /Yes, remove/ }));

    await waitFor(() => expect(alerts()).toContain(LOST.action));
    // It may have gone through, so the row stays until a reload says otherwise; the button is not left armed.
    expect(screen.getByText("Meditite")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Remove Meditite from your collection/ }),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Run the plan/ }));
    await user.click(await screen.findByRole("button", { name: /Done, next card/ }));
    // PRE-FIX: `shelving` was never cleared, so `shelveCard` returned before calling the server — silently.
    await waitFor(() => expect(shelveCardAction).toHaveBeenCalledTimes(1));
  });
});

describe("UIL-106 · the Remove button is never left armed", () => {
  it("a removal that throws still disarms it", async () => {
    const onRemove = vi.fn(async () => {
      throw LOST_CALL();
    });
    const user = userEvent.setup();
    render(createElement(RemoveCopyButton, { onRemove, what: "Meditite" }));

    await user.click(screen.getByRole("button", { name: /Remove Meditite/ }));
    await user.click(screen.getByRole("button", { name: /Yes, remove/ }));

    await waitFor(() => expect(onRemove).toHaveBeenCalledTimes(1));
    // PRE-FIX: the throw skipped `setArmed(false)`, so "Yes, remove / Keep it" sat there for ever.
    await waitFor(() => expect(screen.queryByRole("button", { name: /Yes, remove/ })).toBeNull());
    expect(screen.getByRole("button", { name: /Remove Meditite/ })).toBeTruthy();
  });
});
