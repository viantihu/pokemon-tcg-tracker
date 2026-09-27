// @vitest-environment jsdom
/**
 * UIL-117 C (C1), the screen half — every stage of a Backfill line opens UNDECIDED and the line saves only once she
 * has decided them all: "I have it" (from her haul), Chase (her wishlist add), Leave empty (on no wishlist), or Filler
 * (a basic energy, or a spare card from her haul). A complete line shorter than three pockets asks what fills the
 * third; a line mixing languages asks her to confirm what it will read as. Driven through the REAL BackfillScreen,
 * with the card pickers stood in for so a pick reaches its handler directly.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackfillScreen } from "@/app/(ui)/backfill/BackfillScreen";
import type { ResolvedBackLine } from "@/lib/backfill";

const card = (tcgdexId: string, name: string) => ({
  tcgdexId,
  name,
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
});
/** What each picker hands back, by its placeholder: the species picker, the card she has, and a spare card. */
const picks = vi.hoisted(() => ({ next: new Map<string, unknown>() }));
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
      h(
        "button",
        { type: "button", onClick: () => onPick(picks.next.get(placeholder)) },
        `Pick · ${placeholder}`,
      ),
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
/** Charmander's line: Basic and Stage 1 can be chased in Red; the Stage 2 has no Red printing. */
const THREE: ResolvedBackLine = {
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
const TWO: ResolvedBackLine = { ...THREE, stages: THREE.stages.slice(0, 2) };

beforeEach(() => {
  picks.next = new Map<string, unknown>([
    ["Pick a species in this line (any stage)…", card("sv03-026", "Charmander")],
    ["Which card?", card("sv03-026", "Charmander")],
    ["Which spare card fills it?", card("sv03-141", "Scizor")],
  ]);
  resolveLine.mockReset().mockResolvedValue(THREE);
  commitLineAction.mockReset().mockResolvedValue({
    ok: true,
    counts: { placed: 1, lines: 1, slots: 3, blocks: 1, wishlist: 1, decisions: 1 },
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
const group = (name: string) => screen.getByRole("group", { name });
const choice = (stage: string, name: string) =>
  within(group(`${stage} decision`)).getByRole("button", { name }) as HTMLButtonElement;
const saveButton = () => screen.getByRole("button", { name: "Save line" }) as HTMLButtonElement;
const row = (stage: string) => group(`${stage} decision`).closest(".lf") as HTMLElement;

describe("UIL-117 C · every Backfill stage is her choice", () => {
  it("every stage opens undecided, a stage no card can fill too, and Save waits", async () => {
    await openLine();
    for (const stage of ["Basic", "Stage1", "Stage2"]) {
      const pressed = within(group(`${stage} decision`))
        .getAllByRole("button")
        .filter((b) => b.getAttribute("aria-pressed") === "true");
      expect(pressed).toEqual([]);
    }
    expect(row("Stage2").querySelector(".f.und")?.textContent).toBe("Charizard");
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText("Decide every stage (3 left), then save the line.")).toBeTruthy();
  });

  it("a stage with no same-colour printing cannot be chased, and says why on the row", async () => {
    await openLine();
    expect(choice("Stage2", "Chase").disabled).toBe(true);
    expect(
      within(row("Stage2")).getByText(/Chase is off: no same-colour printing to chase\./),
    ).toBeTruthy();
    expect(choice("Stage2", "Leave empty").disabled).toBe(false);
    expect(choice("Stage2", "Filler").disabled).toBe(false);
  });

  it("each choice reaches the server as the shared rule's words, with the seed card", async () => {
    const user = await openLine();
    await user.click(choice("Basic", "I have it"));
    await user.click(within(row("Basic")).getByRole("button", { name: "Pick · Which card?" }));
    await user.click(choice("Stage1", "Chase"));
    await user.click(choice("Stage2", "Filler"));
    await user.click(within(group("Filler")).getByRole("button", { name: "A spare card" }));
    await user.click(
      within(row("Stage2")).getByRole("button", { name: "Pick · Which spare card fills it?" }),
    );
    expect(screen.getByText("Every stage decided. This line will read as open.")).toBeTruthy();
    await user.click(saveButton());

    await waitFor(() => expect(commitLineAction).toHaveBeenCalledTimes(1));
    const sent = commitLineAction.mock.calls[0][0];
    expect(sent.seedTcgdexId).toBe("sv03-026");
    expect(sent).not.toHaveProperty("thirdPocket"); // a chased stage: not complete, no third pocket
    expect(sent.stages.map((s: { choice: unknown }) => s.choice)).toEqual([
      { kind: "have", tcgdexId: "sv03-026", dexVariantRaw: "Normal" },
      { kind: "chase", catalogCardId: "sv03-027" },
      {
        kind: "filler",
        filler: { material: "card", tcgdexId: "sv03-141", dexVariantRaw: "Normal" },
      },
    ]);
  });

  it("Leave empty and an energy filler leave nothing chased: the line will read as closed", async () => {
    const user = await openLine();
    await user.click(choice("Basic", "Leave empty"));
    await user.click(choice("Stage1", "Leave empty"));
    await user.click(choice("Stage2", "Filler")); // a basic energy is the filler's default
    expect(screen.getByText("Every stage decided. This line will read as closed.")).toBeTruthy();
    await user.click(saveButton());
    await waitFor(() => expect(commitLineAction).toHaveBeenCalledTimes(1));
    expect(commitLineAction.mock.calls[0][0].stages[2].choice).toEqual({
      kind: "filler",
      filler: { material: "energy" },
    });
  });

  it("a filler card waits for its pick before the line can be saved", async () => {
    const user = await openLine();
    await user.click(choice("Basic", "Leave empty"));
    await user.click(choice("Stage1", "Leave empty"));
    await user.click(choice("Stage2", "Filler"));
    await user.click(within(group("Filler")).getByRole("button", { name: "A spare card" }));
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText("Pick the card for the Stage 2 stage from your haul.")).toBeTruthy();
  });
});

describe("UIL-121 Q4 · a complete short line asks what fills its third pocket", () => {
  beforeEach(() => resolveLine.mockResolvedValue(TWO));

  it("only once every stage is a card she has; Save waits for her pick, and it is sent", async () => {
    picks.next.set("Which card?", card("sv03-026", "Charmander"));
    const user = await openLine();
    expect(screen.queryByRole("group", { name: "Third pocket" })).toBeNull();
    await user.click(choice("Basic", "I have it"));
    await user.click(within(row("Basic")).getByRole("button", { name: "Pick · Which card?" }));
    await user.click(choice("Stage1", "I have it"));
    await user.click(within(row("Stage1")).getByRole("button", { name: "Pick · Which card?" }));
    expect(screen.getByRole("group", { name: "Third pocket" })).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText("Choose what fills the third pocket.")).toBeTruthy();

    await user.click(within(group("Third pocket")).getByRole("button", { name: "Basic energy" }));
    await user.click(saveButton());
    await waitFor(() => expect(commitLineAction).toHaveBeenCalledTimes(1));
    expect(commitLineAction.mock.calls[0][0].thirdPocket).toEqual({ material: "energy" });
  });

  it("goes away when a stage is no longer a card she has", async () => {
    const user = await openLine();
    await user.click(choice("Basic", "I have it"));
    await user.click(choice("Stage1", "I have it"));
    expect(screen.getByRole("group", { name: "Third pocket" })).toBeTruthy();
    await user.click(choice("Stage1", "Leave empty"));
    expect(screen.queryByRole("group", { name: "Third pocket" })).toBeNull();
  });
});

describe("the Senior BA's ruling · a line mixing languages asks her to confirm", () => {
  beforeEach(() => resolveLine.mockResolvedValue(TWO));

  it("names the languages and what it will read as; Save waits for her tick, and it is sent", async () => {
    const user = await openLine();
    await user.click(choice("Basic", "I have it"));
    await user.click(within(row("Basic")).getByRole("button", { name: "Pick · Which card?" }));
    picks.next.set("Which card?", card("ja:sv3-027", "Charmeleon"));
    await user.click(choice("Stage1", "I have it"));
    await user.click(within(row("Stage1")).getByRole("button", { name: "Pick · Which card?" }));
    await user.click(within(group("Third pocket")).getByRole("button", { name: "Leave empty" }));

    expect(
      screen.getByText(
        "This line mixes English and Japanese cards; it will read as English. Save it that way.",
      ),
    ).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    await user.click(screen.getByRole("checkbox"));
    await user.click(saveButton());
    await waitFor(() => expect(commitLineAction).toHaveBeenCalledTimes(1));
    expect(commitLineAction.mock.calls[0][0].mixedLanguageOk).toBe(true);
  });
});
