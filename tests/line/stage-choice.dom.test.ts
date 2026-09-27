// @vitest-environment jsdom
/**
 * UIL-121 — her choice for each unfilled stage, and for a short complete line's third pocket, on screen
 * (StageChoice / ThirdPocketChoice). Karvi, 2026-09-27: nothing is written or chosen for her. The suggestion is SHOWN
 * and never selected; every choice is hers, and is reported to the popup exactly as she made it.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StageChoice, ThirdPocketChoice } from "@/app/(ui)/_components/StageChoice";
import type {
  FillerCardOption,
  LinePopupStage,
  StageDecision,
  StageOption,
} from "@/lib/line/popup";

const card = (tcgdexId: string, localId: string, bandKey = "red") => ({
  tcgdexId,
  name: "Charmeleon",
  setId: "sv03",
  setName: "Obsidian Flames",
  localId,
  setCardCountOfficial: 197,
  imageUrl: null,
  bandKey,
});
const SUGGESTED = card("sv03-027", "027");
const STAGE: LinePopupStage = {
  stageIndex: 1,
  stage: "Stage1",
  state: "wanted",
  card: null,
  dexId: 5,
  suggestion: { card: SUGGESTED, special: false },
};
const OPTIONS: StageOption[] = [
  { card: SUGGESTED, sameColour: true, special: false, priceMarket: 0.1 },
  { card: card("sv03-228", "228"), sameColour: true, special: true, priceMarket: 30 },
  {
    card: card("sv08-012", "012", "dark_blue"),
    sameColour: false,
    special: false,
    priceMarket: 0.2,
  },
];
const BULK: FillerCardOption[] = [
  { copyId: "c-bulk", card: { ...card("sv01-001", "001"), name: "Sprigatito" }, where: "Bulk box" },
];

afterEach(cleanup);

function renderStage(value: StageDecision | null = null) {
  const onChange = vi.fn();
  const loadOptions = vi.fn(async () => OPTIONS);
  const loadBulk = vi.fn(async () => BULK);
  const view = render(
    createElement(StageChoice, {
      stage: STAGE,
      lineLocale: "en",
      value,
      onChange,
      loadOptions,
      loadBulk,
    }),
  );
  return { onChange, loadOptions, loadBulk, view, user: userEvent.setup() };
}

describe("StageChoice · the suggestion is shown, never chosen", () => {
  it("nothing is selected until she picks: the stage says Choose, and nothing is reported", () => {
    const { onChange } = renderStage();
    expect(screen.getByText(/Stage 1 · Choose/)).toBeTruthy();
    expect(screen.getByText(/Suggested: Charmeleon 027\/197/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Chase this" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Chase this: a chase of the suggested card", async () => {
    const { onChange, user } = renderStage();
    await user.click(screen.getByRole("button", { name: "Chase this" }));
    expect(onChange).toHaveBeenCalledWith({ kind: "chase", catalogCardId: "sv03-027" });
  });

  it("a stage with no same-colour printing suggests nothing and says she can still pick", () => {
    const onChange = vi.fn();
    render(
      createElement(StageChoice, {
        stage: { ...STAGE, suggestion: null },
        lineLocale: "en",
        value: null,
        onChange,
        loadOptions: async () => [],
        loadBulk: async () => [],
      }),
    );
    expect(screen.queryByRole("button", { name: "Chase this" })).toBeNull();
    expect(screen.getByText(/No printing in this line's colour/)).toBeTruthy();
  });

  it("a special suggestion says where it lives", () => {
    render(
      createElement(StageChoice, {
        stage: { ...STAGE, suggestion: { card: SUGGESTED, special: true } },
        lineLocale: "en",
        value: null,
        onChange: vi.fn(),
        loadOptions: async () => [],
        loadBulk: async () => [],
      }),
    );
    expect(screen.getByText(/Special: lives in the specialty binder/)).toBeTruthy();
  });
});

describe("StageChoice · her other choices", () => {
  it("Pick another: the printings load on first open; another colour is tagged; her pick is a chase of it", async () => {
    const { onChange, loadOptions, user } = renderStage();
    expect(loadOptions).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Pick another" }));
    await waitFor(() =>
      expect(screen.getByRole("group", { name: /Printings for the Stage 1 slot/ })).toBeTruthy(),
    );
    expect(loadOptions).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Different colour")).toBeTruthy();
    expect(screen.getByText("Special")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Charmeleon 012\/197/ }));
    expect(onChange).toHaveBeenCalledWith({ kind: "chase", catalogCardId: "sv08-012" });
  });

  it("a placeholder card: her name, set and number, in the LINE's language; nothing else travels", async () => {
    const { onChange, user } = renderStage();
    await user.click(screen.getByRole("button", { name: /Make a placeholder card/ }));
    const form = screen.getByRole("group", { name: "Make a placeholder card" });
    expect(form.textContent).toMatch(/this line's language \(English\)/);
    const [name, set, number] = Array.from(form.querySelectorAll("input"));
    await user.clear(name);
    await user.type(name, "Charmeleon ex");
    await user.type(set, "Promo");
    await user.type(number, "P9");
    await user.click(screen.getByRole("button", { name: "Chase this placeholder card" }));
    expect(onChange).toHaveBeenCalledWith({
      kind: "chase",
      newStandIn: { name: "Charmeleon ex", setName: "Promo", localId: "P9", language: "en" },
    });
  });

  it("on a Japanese line the placeholder card is Japanese", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      createElement(StageChoice, {
        stage: STAGE,
        lineLocale: "ja",
        value: null,
        onChange,
        loadOptions: async () => [],
        loadBulk: async () => [],
      }),
    );
    await user.click(screen.getByRole("button", { name: /Make a placeholder card/ }));
    expect(screen.getByText(/this line's language \(Japanese\)/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Chase this placeholder card" }));
    expect(onChange.mock.calls[0][0].newStandIn.language).toBe("ja");
  });

  it("a placeholder card needs a name", async () => {
    const { user } = renderStage();
    await user.click(screen.getByRole("button", { name: /Make a placeholder card/ }));
    const [name] = Array.from(
      screen.getByRole("group", { name: "Make a placeholder card" }).querySelectorAll("input"),
    );
    await user.clear(name);
    expect(
      (screen.getByRole("button", { name: "Chase this placeholder card" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("Leave empty", async () => {
    const { onChange, user } = renderStage();
    await user.click(screen.getByRole("button", { name: "Leave empty" }));
    expect(onChange).toHaveBeenCalledWith({ kind: "empty" });
  });

  it("Fill the pocket: a basic energy, or a card from her bulk box (the box loads on first open)", async () => {
    const { onChange, loadBulk, user } = renderStage();
    await user.click(screen.getByRole("button", { name: "Fill the pocket" }));
    await user.click(screen.getByRole("button", { name: /A basic energy/ }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: "filler", filler: { material: "energy" } });
    await user.click(screen.getByRole("button", { name: "Fill the pocket" }));
    expect(loadBulk).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /A card from your bulk box/ }));
    await user.click(await screen.findByRole("button", { name: /Sprigatito 001\/197/ }));
    expect(onChange).toHaveBeenLastCalledWith({
      kind: "filler",
      filler: { material: "card", copyId: "c-bulk" },
    });
  });

  it("what she chose is said in the header", () => {
    renderStage({ kind: "chase", catalogCardId: "sv03-027" });
    expect(screen.getByText(/Stage 1 · Chasing Charmeleon 027\/197/)).toBeTruthy();
    cleanup();
    renderStage({ kind: "empty" });
    expect(screen.getByText(/Stage 1 · Left empty/)).toBeTruthy();
    cleanup();
    renderStage({ kind: "filler", filler: { material: "energy" } });
    expect(screen.getByText(/Stage 1 · Filler: a basic energy/)).toBeTruthy();
  });

  it("a list that fails to load says so, in place", async () => {
    const user = userEvent.setup();
    render(
      createElement(StageChoice, {
        stage: STAGE,
        lineLocale: "en",
        value: null,
        onChange: vi.fn(),
        loadOptions: async () => {
          throw new Error("The printings could not be loaded.");
        },
        loadBulk: async () => [],
      }),
    );
    await user.click(screen.getByRole("button", { name: "Pick another" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The printings could not be loaded.",
    );
  });
});

describe("Backfill's filler comes from her haul (fillerFrom)", () => {
  it("the stage and the third pocket say the haul, not the bulk box", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      createElement(StageChoice, {
        stage: STAGE,
        lineLocale: "en",
        value: { kind: "filler", filler: { material: "card", copyId: "c-bulk" } },
        onChange,
        loadOptions: async () => [],
        loadBulk: async () => BULK,
        fillerFrom: "haul",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Fill the pocket" }));
    expect(screen.getByRole("button", { name: /A spare card from your haul/ })).toBeTruthy();
    expect(screen.queryByText(/bulk box/)).toBeNull();
    cleanup();
    render(
      createElement(ThirdPocketChoice, {
        value: { material: "card", copyId: "c-bulk" },
        onChange,
        loadBulk: async () => BULK,
        fillerFrom: "haul",
      }),
    );
    expect(screen.getByText(/Third pocket · A spare card from your haul/)).toBeTruthy();
  });
});

describe("ThirdPocketChoice · a complete short line's last pocket", () => {
  it("nothing chosen until she picks: energy, a card from her bulk box, or empty", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(createElement(ThirdPocketChoice, { value: null, onChange, loadBulk: async () => BULK }));
    expect(screen.getByText(/Third pocket · Choose/)).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /A basic energy/ }));
    expect(onChange).toHaveBeenLastCalledWith({ material: "energy" });
    await user.click(screen.getByRole("button", { name: /Leave it empty/ }));
    expect(onChange).toHaveBeenLastCalledWith({ material: "empty" });
    await user.click(screen.getByRole("button", { name: /A card from your bulk box/ }));
    await user.click(await screen.findByRole("button", { name: /Sprigatito/ }));
    expect(onChange).toHaveBeenLastCalledWith({ material: "card", copyId: "c-bulk" });
  });
});
