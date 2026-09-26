// @vitest-environment jsdom
/**
 * UIL-109 — Backfill when a call fails: its words come from the shared family, never the raw error text.
 *
 * The screen's first load and "pick a species" are READS whose actions also throw when the server fails, so
 * they say `LOST.load`, which names all three causes. Its three saves return `{ ok }` for their own failures,
 * so a throw there is a call that never arrived, and they say `LOST.action`. Driven through the REAL screen,
 * with the card pickers stood in for so a pick reaches the handler under test directly.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOST } from "@/app/(ui)/_components/reach";
import { BackfillScreen } from "@/app/(ui)/backfill/BackfillScreen";

const CARD = {
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
  dexVariantRaw: "Normal",
  waiting: 1,
  badge: "Normal · 1 waiting",
};
vi.mock("@/app/(ui)/_components/CardResultsGrid", async () => {
  const { createElement: h } = await import("react");
  return {
    CardResultsGrid: ({
      onPick,
      placeholder,
    }: {
      onPick: (c: unknown) => void;
      placeholder: string;
    }) => h("button", { type: "button", onClick: () => onPick(CARD) }, `Pick · ${placeholder}`),
  };
});

const loadContext = vi.fn();
const resolveLine = vi.fn();
const commitFrontAction = vi.fn();
const commitLineAction = vi.fn();
const commitSpecialtyAction = vi.fn();
vi.mock("@/app/(ui)/backfill/actions", () => ({
  loadContext: (...a: unknown[]) => loadContext(...a),
  resolveLine: (...a: unknown[]) => resolveLine(...a),
  commitFrontAction: (...a: unknown[]) => commitFrontAction(...a),
  commitLineAction: (...a: unknown[]) => commitLineAction(...a),
  commitSpecialtyAction: (...a: unknown[]) => commitSpecialtyAction(...a),
  lookupCatalog: vi.fn(async () => []),
  searchWaiting: vi.fn(async () => []),
}));

const CTX = {
  binders: [{ id: "kb1", name: "KB-001", type: "general", isActive: true }],
  collections: [],
  bands: [{ key: "orange", display: "Orange" }],
  typeColorMap: { Fighting: "orange" },
};
const text = () =>
  [...screen.queryAllByRole("alert"), ...screen.queryAllByRole("status")]
    .map((a) => a.textContent)
    .join(" | ");

beforeEach(() => {
  for (const f of [
    loadContext,
    resolveLine,
    commitFrontAction,
    commitLineAction,
    commitSpecialtyAction,
  ])
    f.mockReset();
  loadContext.mockResolvedValue(CTX);
});
afterEach(cleanup);

describe("UIL-109 · Backfill says a failure in the shared words", () => {
  it("a first load that fails", async () => {
    loadContext.mockReset();
    loadContext.mockRejectedValue(new Error("permission denied for table binder"));
    render(createElement(BackfillScreen));
    // PRE-FIX: the raw error text.
    await waitFor(() => expect(text()).toContain(LOST.load));
    expect(text()).not.toContain("permission denied");
  });

  it("a front-half save that cannot reach the server (its action returns { ok }, so a throw is transport)", async () => {
    commitFrontAction.mockRejectedValue(new TypeError("Failed to fetch"));
    const user = userEvent.setup();
    render(createElement(BackfillScreen));
    await user.click(await screen.findByRole("button", { name: /^Pick · Set \+ number/ }));
    await user.click(screen.getByRole("button", { name: "Save front half" }));
    await waitFor(() => expect(text()).toContain(LOST.action));
    expect(text()).not.toContain("Failed to fetch");
  });

  it("a back-half line save that cannot reach the server", async () => {
    resolveLine.mockResolvedValue({
      rootDexId: 9481,
      speciesName: "Toedscool",
      bandKey: "orange",
      requiredType: "Fighting",
      seedStageIndex: -1,
      stages: [
        {
          stageIndex: 0,
          stage: "Basic",
          dexId: 9481,
          name: "Toedscool",
          sameColorPrintingExists: true,
          specialtyOnly: false,
          suggestedTargetId: "sv09-088",
          alternateTargetIds: [],
        },
      ],
    });
    commitLineAction.mockRejectedValue(new TypeError("Failed to fetch"));
    const user = userEvent.setup();
    render(createElement(BackfillScreen));
    await user.click(await screen.findByRole("button", { name: "Back half" }));
    await user.click(screen.getByRole("button", { name: /^Pick · Pick a species/ }));
    await user.click(await screen.findByRole("button", { name: "Save line" }));
    await waitFor(() => expect(text()).toContain(LOST.action));
    expect(commitLineAction).toHaveBeenCalledTimes(1);
  });

  it("a specialty save that cannot reach the server", async () => {
    loadContext.mockResolvedValue({
      ...CTX,
      binders: [{ id: "sp1", name: "Paldea starters", type: "specialty", isActive: true }],
    });
    commitSpecialtyAction.mockRejectedValue(new TypeError("Failed to fetch"));
    const user = userEvent.setup();
    render(createElement(BackfillScreen));
    await user.click(await screen.findByRole("button", { name: /^Pick · Set \+ number/ }));
    await user.click(screen.getByRole("button", { name: "Save specialty" }));
    await waitFor(() => expect(text()).toContain(LOST.action));
  });

  it("picking a back-half species when the line cannot be resolved", async () => {
    resolveLine.mockRejectedValue(new Error("statement timeout"));
    const user = userEvent.setup();
    render(createElement(BackfillScreen));
    await user.click(await screen.findByRole("button", { name: "Back half" }));
    await user.click(screen.getByRole("button", { name: /^Pick · Pick a species/ }));
    await waitFor(() => expect(text()).toContain(LOST.load));
    expect(text()).not.toContain("statement timeout");
  });
});
