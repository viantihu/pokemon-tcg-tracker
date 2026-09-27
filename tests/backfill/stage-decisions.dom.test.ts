// @vitest-environment jsdom
/**
 * UIL-117 PR 5 (5a), the screen half — every stage of a Backfill line opens UNDECIDED and the line saves only once
 * she has decided them all; "Leave empty" and "Hunt" reach the server as `hunt: false` / `hunt: true`; a terminated
 * line hunts nothing (the Senior BA's Q1). Driven through the REAL BackfillScreen, with the card pickers stood in
 * for so a pick reaches its handler directly.
 *
 * PRE-FIX the screen opened every stage with a same-colour printing as a hunt (BackfillScreen's `defaultEntry`) and
 * the seed stage as Filled, so a save put stages on her wishlist she never chose (UIL-119's second path).
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackfillScreen } from "@/app/(ui)/backfill/BackfillScreen";
import type { ResolvedBackLine } from "@/lib/backfill";

const CHARMANDER = {
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
    }) =>
      h("button", { type: "button", onClick: () => onPick(CHARMANDER) }, `Pick · ${placeholder}`),
  };
});

const resolveLine = vi.fn();
const commitLineAction = vi.fn();
vi.mock("@/app/(ui)/backfill/actions", () => ({
  loadContext: vi.fn(async () => ({
    binders: [{ id: "kb1", name: "KB-001", type: "general", isActive: true }],
    collections: [],
    bands: [{ key: "red", display: "Red" }],
    typeColorMap: { Fire: "red" },
  })),
  resolveLine: (...a: unknown[]) => resolveLine(...a),
  commitLineAction: (...a: unknown[]) => commitLineAction(...a),
  commitFrontAction: vi.fn(),
  commitSpecialtyAction: vi.fn(),
  lookupCatalog: vi.fn(async () => []),
  searchWaiting: vi.fn(async () => []),
}));

const stageInfo = (i: number, stage: string, dexId: number, name: string, printing = true) => ({
  stageIndex: i,
  stage,
  dexId,
  name,
  sameColorPrintingExists: printing,
  specialtyOnly: false,
  suggestedTargetId: printing ? `sv03-02${6 + i}` : null,
  alternateTargetIds: [],
});
/** Charmander's line: Basic and Stage 1 can be hunted in Red; the Stage 2 has no Red printing. */
const LINE: ResolvedBackLine = {
  rootDexId: 4,
  speciesName: "Charmander",
  bandKey: "red",
  requiredType: "Fire",
  seedStageIndex: 0,
  stages: [
    stageInfo(0, "Basic", 4, "Charmander"),
    stageInfo(1, "Stage1", 5, "Charmeleon"),
    stageInfo(2, "Stage2", 6, "Charizard", false),
  ],
};

beforeEach(() => {
  resolveLine.mockReset().mockResolvedValue(LINE);
  commitLineAction.mockReset().mockResolvedValue({
    ok: true,
    counts: { placed: 1, lines: 1, slots: 3, blocks: 0, wishlist: 1, decisions: 1 },
  });
});
afterEach(cleanup);

async function openLine() {
  const user = userEvent.setup();
  render(createElement(BackfillScreen));
  await user.click(await screen.findByRole("button", { name: "Back half" }));
  await user.click(screen.getByRole("button", { name: /^Pick · Pick a species/ }));
  await screen.findByRole("group", { name: "Basic decision" });
  return user;
}
const group = (stage: string) => screen.getByRole("group", { name: `${stage} decision` });
const choice = (stage: string, name: string) =>
  within(group(stage)).getByRole("button", { name }) as HTMLButtonElement;
const saveButton = () => screen.getByRole("button", { name: "Save line" }) as HTMLButtonElement;

describe("UIL-117 PR 5 · every Backfill stage is her decision", () => {
  it("every stage opens undecided, the one she picked the species by too, and Save waits", async () => {
    await openLine();
    for (const stage of ["Basic", "Stage1", "Stage2"]) {
      const pressed = within(group(stage))
        .getAllByRole("button")
        .filter((b) => b.getAttribute("aria-pressed") === "true");
      expect(pressed).toEqual([]);
    }
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText("Decide every stage (3 left), then save the line.")).toBeTruthy();
  });

  it("a stage no card can fill opens undecided too: nothing pre-sets Block (never auto-blocks)", async () => {
    await openLine();
    // PRE-FIX: a stage with no same-colour printing opened as a Block, and Save wrote the block for her.
    expect(choice("Stage2", "Block").getAttribute("aria-pressed")).toBe("false");
    const row = group("Stage2").closest(".lf") as HTMLElement;
    expect(row.querySelector(".f.und")?.textContent).toBe("Charizard");
    expect(row.querySelector(".f.blk")).toBeNull();
  });

  it("Save waits until the last stage is decided", async () => {
    const user = await openLine();
    await user.click(choice("Basic", "Filled"));
    await user.click(screen.getByRole("button", { name: "Pick · Which card?" }));
    await user.click(choice("Stage1", "Hunt"));
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText("Decide every stage (1 left), then save the line.")).toBeTruthy();
    await user.click(choice("Stage2", "Leave empty"));
    expect(saveButton().disabled).toBe(false);
  });

  it("Hunt and Leave empty reach the server as hunt: true and hunt: false, with the seed card", async () => {
    const user = await openLine();
    await user.click(choice("Basic", "Filled"));
    await user.click(screen.getByRole("button", { name: "Pick · Which card?" }));
    await user.click(choice("Stage1", "Hunt"));
    await user.click(choice("Stage2", "Leave empty"));
    await user.click(saveButton());

    await waitFor(() => expect(commitLineAction).toHaveBeenCalledTimes(1));
    const sent = commitLineAction.mock.calls[0][0];
    expect(sent.seedTcgdexId).toBe("sv03-026");
    expect(sent.stages).toEqual([
      expect.objectContaining({ stageIndex: 0, decision: "filled", filledTcgdexId: "sv03-026" }),
      expect.objectContaining({ stageIndex: 1, decision: "placeholder", hunt: true }),
      expect.objectContaining({ stageIndex: 2, decision: "placeholder", hunt: false }),
    ]);
    expect(
      await screen.findByText(
        "Saved the Red Charmander line (3 slots, 1 on your wishlist, 1 left empty, 0 blocks).",
      ),
    ).toBeTruthy();
  });

  it("a stage with no same-colour printing cannot be hunted, and can still be left empty", async () => {
    await openLine();
    expect(choice("Stage2", "Hunt").disabled).toBe(true);
    expect(choice("Stage2", "Leave empty").disabled).toBe(false);
  });

  it("a terminated line hunts nothing: Hunt is off, and a stage she hunted goes back to undecided", async () => {
    const user = await openLine();
    await user.click(choice("Basic", "Leave empty"));
    await user.click(choice("Stage1", "Hunt"));
    await user.click(choice("Stage2", "Block"));
    expect(saveButton().disabled).toBe(false);

    await user.click(screen.getByRole("checkbox"));
    // The controls stay (Q1); Hunt is off everywhere, and her hunt is undone for her to decide again.
    for (const stage of ["Basic", "Stage1", "Stage2"]) {
      expect(choice(stage, "Hunt").disabled).toBe(true);
      expect(choice(stage, "Leave empty").disabled).toBe(false);
    }
    expect(choice("Stage1", "Hunt").getAttribute("aria-pressed")).toBe("false");
    expect(choice("Basic", "Leave empty").getAttribute("aria-pressed")).toBe("true");
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText("Decide every stage (1 left), then save the line.")).toBeTruthy();
  });
});
