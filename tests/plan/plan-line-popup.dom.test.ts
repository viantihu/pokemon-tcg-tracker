// @vitest-environment jsdom
/**
 * UIL-117 PR 4 (4b) — the line popup on the Haul Plan, through the REAL screen and the REAL popup (mockup v3
 * section 1). Karvi: "The user must always authorize all moves." Pinned:
 *   - every card headed into a back half wears its badge: green starts, yellow adds, pink could replace;
 *   - the popup opens from the badge, from the row's box and from the spotlight's Done, and nothing is written, and
 *     the box is not ticked, until she confirms (the UX Dev's guard);
 *   - a pull she owns is shown unticked, and only a pull she ticks is sent;
 *   - "Confirm & next": confirming one line card opens the next ("Line card 2 of 2");
 *   - the holo upgrade opens pre-set to Swap, the old copy to the bulk box;
 *   - a colour mismatch asks which wins, neither picked, and "own colour" files it in the front half;
 *   - a refusal keeps the popup open with the reason in it;
 *   - a plan parked before this change is routed again.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanItem } from "@/lib/plan";
import type { LinePopupModel, LineProposal } from "@/lib/line/popup";
import { groupPlan } from "@/lib/plan/group";
import type {
  DraftCard,
  DraftPayloadItem,
  LookupCard,
  RunPlanResult,
} from "@/app/(ui)/plan/plan-types";
import { PlanScreen } from "@/app/(ui)/plan/PlanScreen";
import { flattenPlan } from "@/app/(ui)/plan/reroute";
import { routedPlan } from "../support/plan-route";

const shelveCardAction = vi.fn();
const refreshSpotlightAction = vi.fn();
const runHaulPlan = vi.fn();
vi.mock("@/app/(ui)/plan/actions", () => ({
  shelveCardAction: (...a: unknown[]) => shelveCardAction(...a),
  getMoveOptions: vi.fn(async () => ({
    binders: [{ id: "kb1", name: "KB-001", type: "general" }],
    collectionsByBinder: {},
    bands: [
      { key: "red", display: "Red" },
      { key: "green", display: "Green" },
    ],
  })),
  getLineJoinOptions: vi.fn(async () => null),
  loadPendingPlacementDraft: vi.fn(async () => []),
  loadArrivals: vi.fn(async () => []),
  lookupCatalog: vi.fn(async () => []),
  refreshSpotlightAction: (...a: unknown[]) => refreshSpotlightAction(...a),
  runHaulPlan: (...a: unknown[]) => runHaulPlan(...a),
  planStateStamp: vi.fn(async () => "s"),
}));
vi.mock("@/app/(ui)/look/actions", () => ({ removeCopy: vi.fn() }));
const lineModelAction = vi.fn();
vi.mock("@/app/(ui)/_components/line-popup-actions", () => ({
  lineModelAction: (...a: unknown[]) => lineModelAction(...a),
}));

const identity = (name: string) => ({
  tcgdexId: `sv03-${name}`,
  name,
  setId: "sv03",
  setName: "Obsidian Flames",
  localId: "027",
  setCardCountOfficial: 197,
  imageUrl: null,
  bandKey: "red",
});
const card = (name: string): LookupCard => ({
  ...identity(name),
  stage: "Stage1",
  types: ["Fire"],
  category: "Pokemon",
  trainerType: null,
  cardClass: "standard",
  variants: ["normal"],
});
const waiting = (name: string): DraftCard => ({
  id: `id-${name}`,
  existingCopyId: `id-${name}`,
  card: card(name),
  variant: "normal",
  dexVariantRaw: "Normal",
});
const START: LineProposal = { kind: "start", binderId: "kb1", band: "red" };
const ADD: LineProposal = { kind: "add", lineId: "L1", slotId: "S1" };
const HOLO: LineProposal = { kind: "replace", lineId: "L1", slotId: "S1", defaultKeep: false };
const EXTRA: LineProposal = { kind: "replace", lineId: "L1", slotId: "S1", defaultKeep: true };

const LINE = {
  binderId: "kb1",
  binderName: "KB-001",
  bandKey: "red",
  bandDisplay: "Red",
  locale: "en" as const,
  // Three stages, the last still wanted, so one card going in does not leave the line done (UIL-120's own tests
  // drop the wanted stage).
  total: 3,
};
/** A stage with no card yet: while it is there, a confirm does not leave the line done (UIL-120). */
const WANTED = {
  stageIndex: 2,
  stage: "Stage2",
  state: "wanted" as const,
  card: identity("Charizard"),
};
/** The same popup model with nothing left to chase: the confirm leaves its line done. */
const withNothingLeft = (m: LinePopupModel): LinePopupModel => ({
  ...m,
  stages: m.stages.filter((st) => st.state !== "wanted"),
});
function modelFor(name: string, proposal: LineProposal): LinePopupModel {
  const me = identity(name);
  if (proposal.kind === "start") {
    return {
      mode: "start",
      copyId: `id-${name}`,
      card: { ...me, locale: "en" },
      line: { ...LINE, lineId: null, filledBefore: 0, filledAfter: 1 },
      stages: [
        {
          stageIndex: 0,
          stage: "Basic",
          state: "pullable",
          card: identity("Charmander"),
          pull: { copyId: "own-charmander", fromLabel: "KB-001 · Front · Red" },
        },
        { stageIndex: 1, stage: "Stage1", state: "incoming", card: me },
      ],
      existingLines: [],
    };
  }
  if (proposal.kind === "add") {
    return {
      mode: "add",
      copyId: `id-${name}`,
      card: { ...me, locale: "en" },
      line: {
        ...LINE,
        lineId: "L1",
        bandKey: "green",
        bandDisplay: "Green",
        filledBefore: 1,
        filledAfter: 2,
      },
      stages: [
        { stageIndex: 0, stage: "Basic", state: "here", card: identity("Charmander") },
        { stageIndex: 1, stage: "Stage1", state: "incoming", card: me },
        WANTED,
      ],
      existingLines: [],
    };
  }
  return {
    mode: "replace",
    copyId: `id-${name}`,
    card: { ...me, locale: "en" },
    line: { ...LINE, lineId: "L1", filledBefore: 2, filledAfter: 2 },
    stages: [
      { stageIndex: 0, stage: "Basic", state: "here", card: identity("Charmander") },
      { stageIndex: 1, stage: "Stage1", state: "incoming", card: me },
      WANTED,
    ],
    existingLines: [],
    replace: {
      slotId: "S1",
      stageIndex: 1,
      current: { copyId: "own-normal", card: identity("Charmeleon"), where: "KB-001 · Back · Red" },
      incoming: { copyId: `id-${name}`, card: me, where: "Still in the haul" },
      defaultKeep: proposal.defaultKeep,
      suggestedOutgoing: { kind: "bulk" },
    },
  };
}

/** A parked sitting whose rows carry these line proposals (null = a plain front-half card). */
function park(
  rows: { name: string; proposal: LineProposal | null }[],
  lineNames: Record<string, string> = {},
) {
  const draft = rows.map((r) => waiting(r.name));
  const base = routedPlan(draft.map((d) => ({ ...d, tcgdexId: d.card.tcgdexId })));
  const byName = new Map(rows.map((r) => [r.name, r.proposal]));
  const items: PlanItem[] = flattenPlan(base).map((it) => {
    const proposal = byName.get(it.name) ?? null;
    const action =
      proposal?.kind === "start"
        ? "NEWLINE"
        : proposal?.kind === "add"
          ? "FILL"
          : proposal
            ? "SWAP"
            : "FRONT";
    return { ...it, action, lineProposal: proposal, lineName: lineNames[it.name] ?? null };
  });
  const plan: RunPlanResult = { ...base, groups: groupPlan(items, ["orange"]) };
  window.sessionStorage.setItem(
    "binderops.plan.v1",
    JSON.stringify({
      stamp: "s",
      draft,
      plan,
      done: [],
      cur: 0,
      overrides: {},
      collapsed: [],
      collapsedSubgroups: [],
    }),
  );
  return { plan, items };
}
const popup = () =>
  screen.getByRole("dialog", { name: /Start a line|Add to a line|A copy for a filled slot/ });
const confirmIn = () =>
  within(popup())
    .getAllByRole("button")
    .find((b) => b.classList.contains("btn-primary")) as HTMLButtonElement;
const box = (name: string) => screen.getByRole("button", { name: `Shelve ${name}` });

beforeEach(() => {
  window.sessionStorage.clear();
  for (const f of [shelveCardAction, refreshSpotlightAction, runHaulPlan, lineModelAction])
    f.mockReset();
  shelveCardAction.mockResolvedValue({
    ok: true,
    counts: { routed: 1, lines: 1, slots: 1, decisions: 1, wishlist: 0 },
    stamp: "s2",
    lineDone: false,
  });
  runHaulPlan.mockImplementation(async (p: DraftPayloadItem[]) => routedPlan(p));
  lineModelAction.mockImplementation(async (copyId: string, proposal: LineProposal) => ({
    ok: true,
    model: modelFor(copyId.replace(/^id-/, ""), proposal),
  }));
});
afterEach(cleanup);

async function mount(
  rows: { name: string; proposal: LineProposal | null }[],
  bandMismatch: unknown = null,
  lineNames: Record<string, string> = {},
) {
  const { items } = park(rows, lineNames);
  refreshSpotlightAction.mockImplementation(async ({ card: c }: { card: { id: string } }) => ({
    ok: true,
    item: items.find((it) => it.incomingId === c.id),
    digest: "dg",
    proposedPulls: [],
    bandMismatch,
  }));
  const user = userEvent.setup();
  render(createElement(PlanScreen, { stateStamp: "s" }));
  await screen.findAllByText(rows[0].name);
  return user;
}

describe("UIL-117 4b · the badges", () => {
  it("every card headed into a back half wears its badge; a front-half card wears none", async () => {
    await mount([
      { name: "Abra", proposal: null },
      { name: "Charmeleon", proposal: START },
      { name: "Kadabra", proposal: ADD },
      { name: "Machop", proposal: HOLO },
    ]);
    // PRE-FIX: no badge; the cascade placed every one of these on its own.
    expect(screen.getByRole("button", { name: "＋ Starts a line" }).className).toContain("start");
    expect(screen.getByRole("button", { name: "◆ Adds to a line" }).className).toContain("add");
    expect(screen.getByRole("button", { name: "⇄ Could replace a card" }).className).toContain(
      "replace",
    );
    expect(document.getElementById("plan-row-id-Abra")?.querySelector(".linebadge")).toBeNull();
    // The badge replaces the action pill on a line card (v3); a front-half card keeps its pill.
    expect(document.getElementById("plan-row-id-Charmeleon")?.querySelector(".act")).toBeNull();
    expect(document.getElementById("plan-row-id-Abra")?.querySelector(".act")).not.toBeNull();
  });

  it("names the line by its top stage, as v3 does; a replace stays generic", async () => {
    await mount(
      [
        { name: "Charmeleon", proposal: START },
        { name: "Toedscruel", proposal: ADD },
        { name: "Machop", proposal: HOLO },
      ],
      null,
      { Charmeleon: "Charizard", Toedscruel: "Toedscruel", Machop: "Machoke" },
    );
    expect(screen.getByRole("button", { name: "＋ Starts Charizard line" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "◆ Adds to Toedscruel line" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "⇄ Could replace a card" })).toBeTruthy();
  });
});

describe("UIL-117 4b · the popup", () => {
  it("opens from the badge; the pull she owns is unticked; Cancel writes nothing and ticks nothing", async () => {
    const user = await mount([{ name: "Charmeleon", proposal: START }]);
    await user.click(screen.getByRole("button", { name: "＋ Starts a line" }));
    expect(await screen.findByRole("dialog", { name: "Start a line" })).toBeTruthy();
    expect(within(popup()).getByText("New · this haul")).toBeTruthy();
    expect((within(popup()).getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    await user.click(within(popup()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Start a line" })).toBeNull();
    expect(shelveCardAction).not.toHaveBeenCalled();
    expect(box("Charmeleon").getAttribute("aria-pressed")).toBe("false");
  });

  it("Escape closes it and writes nothing (the app's layer stack)", async () => {
    const user = await mount([{ name: "Charmeleon", proposal: START }]);
    await user.click(screen.getByRole("button", { name: "＋ Starts a line" }));
    await screen.findByRole("dialog", { name: "Start a line" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Start a line" })).toBeNull());
    expect(shelveCardAction).not.toHaveBeenCalled();
  });

  it("opens from the row's box too, and only a pull she ticks is sent", async () => {
    const user = await mount([{ name: "Charmeleon", proposal: START }]);
    await user.click(box("Charmeleon"));
    await screen.findByRole("dialog", { name: "Start a line" });
    expect(box("Charmeleon").getAttribute("aria-pressed")).toBe("false"); // opening ticks nothing
    await user.click(within(popup()).getByRole("checkbox"));
    await waitFor(() => expect(confirmIn().disabled).toBe(false));
    await user.click(confirmIn());
    await waitFor(() => expect(shelveCardAction).toHaveBeenCalledTimes(1));
    expect(shelveCardAction.mock.calls[0][0]).toMatchObject({
      card: { id: "id-Charmeleon" },
      lineChoice: { mode: "start", binderId: "kb1", band: "red", pulls: ["own-charmander"] },
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("opens from the spotlight's Done, which says so", async () => {
    const user = await mount([{ name: "Charmeleon", proposal: ADD }]);
    const done = await screen.findByRole("button", { name: "Confirm its line ▶" });
    await waitFor(() => expect((done as HTMLButtonElement).disabled).toBe(false));
    await user.click(done);
    expect(await screen.findByRole("dialog", { name: "Add to a line" })).toBeTruthy();
    expect(shelveCardAction).not.toHaveBeenCalled();
  });

  it("Confirm & next: confirming one line card opens the next", async () => {
    const user = await mount([
      { name: "Charmeleon", proposal: ADD },
      { name: "Kadabra", proposal: ADD },
    ]);
    await user.click(screen.getAllByRole("button", { name: "◆ Adds to a line" })[0]);
    await screen.findByRole("dialog", { name: "Add to a line" });
    expect(within(popup()).getByText(/Line card 1 of 2/)).toBeTruthy();
    await waitFor(() => expect(confirmIn().disabled).toBe(false));
    expect(confirmIn().textContent).toContain("· next ▶");
    await user.click(confirmIn());
    await waitFor(() => expect(shelveCardAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(popup()).getByText(/Line card 2 of 2/)).toBeTruthy());
    expect(lineModelAction.mock.calls.at(-1)?.[0]).toBe("id-Kadabra");
    // The last one confirms plainly: nothing opens after it (UX review of #392).
    await waitFor(() => expect(confirmIn().textContent).not.toContain("next"));
  });

  it("UIL-120: a confirm that leaves its line DONE closes the popup, and the next line card waits for her tap", async () => {
    // Karvi: "Once the line is complete, it should not open the popup again for the next card automatically."
    shelveCardAction.mockResolvedValue({
      ok: true,
      counts: { routed: 1, lines: 0, slots: 0, decisions: 1, wishlist: 0 },
      stamp: "s2",
      lineDone: true,
    });
    // Her Charmander line has one open slot left, so this Add fills it: the line is done.
    lineModelAction.mockImplementation(async (copyId: string, proposal: LineProposal) => {
      const m = modelFor(copyId.replace(/^id-/, ""), proposal);
      return { ok: true, model: withNothingLeft(m) };
    });
    const user = await mount([
      { name: "Charmeleon", proposal: ADD },
      { name: "Kadabra", proposal: ADD },
    ]);
    await user.click(screen.getAllByRole("button", { name: "◆ Adds to a line" })[0]);
    await screen.findByRole("dialog", { name: "Add to a line" });
    await waitFor(() => expect(confirmIn().disabled).toBe(false));
    // It does not promise a next one it will not open.
    expect(confirmIn().textContent).not.toContain("next");
    await user.click(confirmIn());
    await waitFor(() => expect(shelveCardAction).toHaveBeenCalledTimes(1));
    // PRE-FIX: "Line card 2 of 2" opened by itself.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(lineModelAction.mock.calls.map((c) => c[0])).toEqual(["id-Charmeleon"]);
    // She is still on the plan, and the next line card opens when SHE taps it.
    await user.click(screen.getByRole("button", { name: "◆ Adds to a line" }));
    await waitFor(() => expect(within(popup()).getByText(/Line card 2 of 2/)).toBeTruthy());
  });

  it("UIL-120: a start's button says '· next' until her ticked pull leaves nothing to chase", async () => {
    lineModelAction.mockImplementation(async (copyId: string, proposal: LineProposal) => ({
      ok: true,
      model: withNothingLeft(modelFor(copyId.replace(/^id-/, ""), proposal)),
    }));
    const user = await mount([
      { name: "Charmeleon", proposal: START },
      { name: "Kadabra", proposal: START },
    ]);
    await user.click(screen.getAllByRole("button", { name: "＋ Starts a line" })[0]);
    await screen.findByRole("dialog", { name: "Start a line" });
    await waitFor(() => expect(confirmIn().disabled).toBe(false));
    // The Basic stays in her front half unless she ticks it, so the line would still have that stage to chase.
    expect(confirmIn().textContent).toContain("· next ▶");
    await user.click(within(popup()).getByRole("checkbox"));
    expect(confirmIn().textContent).not.toContain("next");
  });

  it("UIL-120: a Keep on a line that is ALREADY complete stops too (she tested past #402 here)", async () => {
    shelveCardAction.mockResolvedValue({
      ok: true,
      counts: { routed: 1, lines: 0, slots: 0, decisions: 1, wishlist: 0 },
      stamp: "s2",
      lineDone: true,
    });
    lineModelAction.mockImplementation(async (copyId: string, proposal: LineProposal) => ({
      ok: true,
      model: withNothingLeft(modelFor(copyId.replace(/^id-/, ""), proposal)),
    }));
    const user = await mount([
      { name: "Charmeleon", proposal: EXTRA },
      { name: "Kadabra", proposal: EXTRA },
    ]);
    await user.click(screen.getAllByRole("button", { name: "⇄ Could replace a card" })[0]);
    await screen.findByRole("dialog", { name: "A copy for a filled slot" });
    await waitFor(() => expect(confirmIn().disabled).toBe(false));
    // Nothing is left to chase in that line, so the button promises no next card.
    expect(confirmIn().textContent).not.toContain("next");
    await user.click(confirmIn());
    await waitFor(() => expect(shelveCardAction).toHaveBeenCalledTimes(1));
    expect(shelveCardAction.mock.calls[0][0]).toMatchObject({
      lineChoice: { mode: "replace", keep: true },
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(lineModelAction.mock.calls.map((c) => c[0])).toEqual(["id-Charmeleon"]);
  });

  it("UIL-120: a confirm that leaves a stage open still opens the next one, as today", async () => {
    shelveCardAction.mockResolvedValue({
      ok: true,
      counts: { routed: 1, lines: 0, slots: 0, decisions: 1, wishlist: 0 },
      stamp: "s2",
      lineDone: false,
    });
    const user = await mount([
      { name: "Charmeleon", proposal: ADD },
      { name: "Kadabra", proposal: ADD },
    ]);
    await user.click(screen.getAllByRole("button", { name: "◆ Adds to a line" })[0]);
    await screen.findByRole("dialog", { name: "Add to a line" });
    await waitFor(() => expect(confirmIn().disabled).toBe(false));
    await user.click(confirmIn());
    await waitFor(() => expect(within(popup()).getByText(/Line card 2 of 2/)).toBeTruthy());
    expect(lineModelAction.mock.calls.at(-1)?.[0]).toBe("id-Kadabra");
  });

  it("the holo upgrade opens pre-set to Swap, the old copy to the bulk box", async () => {
    const user = await mount([{ name: "Charmeleon", proposal: HOLO }]);
    await user.click(screen.getByRole("button", { name: "⇄ Could replace a card" }));
    await screen.findByRole("dialog", { name: "A copy for a filled slot" });
    await waitFor(() => expect(confirmIn().disabled).toBe(false));
    await user.click(confirmIn());
    await waitFor(() =>
      expect(shelveCardAction.mock.calls[0]?.[0].lineChoice).toEqual({
        mode: "replace",
        lineId: "L1",
        slotId: "S1",
        keep: false,
        outgoing: { kind: "bulk" },
      }),
    );
  });

  it("the card coming out of a swap can go into ANOTHER line (her answer 3: anywhere)", async () => {
    const user = await mount([{ name: "Charmeleon", proposal: HOLO }]);
    await user.click(screen.getByRole("button", { name: "⇄ Could replace a card" }));
    const replace = await screen.findByRole("dialog", { name: "A copy for a filled slot" });
    // PRE-FIX (of this review item): no "Another line…" on the Haul Plan, so it could only go to bulk or a front half.
    await user.click(await within(replace).findByRole("button", { name: "Another line…" }));
    const start = await screen.findByRole("dialog", { name: "Start a line" });
    expect(lineModelAction).toHaveBeenLastCalledWith(
      "own-normal",
      expect.objectContaining({ kind: "start" }),
    );
    await user.click(within(start).getByRole("button", { name: /Start line/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Start a line" })).toBeNull());
    const swap = within(screen.getByRole("dialog", { name: "A copy for a filled slot" }))
      .getAllByRole("button")
      .find((b) => b.classList.contains("btn-primary")) as HTMLButtonElement;
    await waitFor(() => expect(swap.disabled).toBe(false));
    await user.click(swap);
    await waitFor(() => expect(shelveCardAction).toHaveBeenCalledTimes(1));
    expect(shelveCardAction.mock.calls[0][0].lineChoice).toMatchObject({
      mode: "replace",
      keep: false,
      outgoing: { kind: "shelf", half: "back" },
      outgoingLine: { mode: "start" },
    });
  });

  it("an extra copy's Keep says where it is shelved: the front half, as an extra copy goes today", async () => {
    const user = await mount([{ name: "Charmeleon", proposal: EXTRA }]);
    await user.click(screen.getByRole("button", { name: "⇄ Could replace a card" }));
    await screen.findByRole("dialog", { name: "A copy for a filled slot" });
    // PRE-FIX (UX review): the row said "Stays put", though the card is shelved from the haul to the front half.
    expect(within(popup()).getByText(/from this haul → KB-001 · Front · Orange/)).toBeTruthy();
    await waitFor(() => expect(confirmIn().disabled).toBe(false));
    await user.click(confirmIn());
    await waitFor(() =>
      expect(shelveCardAction.mock.calls[0]?.[0].lineChoice).toEqual({
        mode: "replace",
        lineId: "L1",
        slotId: "S1",
        keep: true,
      }),
    );
  });

  it("a KEPT holo gets where it goes, the bulk box pre-selected, and nothing in the line moves", async () => {
    const user = await mount([{ name: "Charmeleon", proposal: HOLO }]);
    await user.click(screen.getByRole("button", { name: "⇄ Could replace a card" }));
    await screen.findByRole("dialog", { name: "A copy for a filled slot" });
    const stays = within(popup()).getByRole("radiogroup", { name: "Which card stays in the line" });
    await user.click(within(stays).getAllByRole("radio")[0]); // Keep the one there now
    await waitFor(() => expect(confirmIn().disabled).toBe(false));
    await user.click(confirmIn());
    await waitFor(() =>
      expect(shelveCardAction.mock.calls[0]?.[0].lineChoice).toMatchObject({
        mode: "replace",
        keep: true,
        incoming: { kind: "bulk" },
      }),
    );
  });

  it("a colour mismatch asks which wins, neither picked; own colour files it in the front half", async () => {
    const own = { kind: "shelf", binderId: "kb1", half: "front", band: "red" };
    const user = await mount([{ name: "Charmeleon", proposal: ADD }], {
      lineSpeciesLabel: "CHARMANDER LINE",
      lineDestination: "KB-001 · Back · Green",
      ownColorDestination: "KB-001 · Front · Red",
      ownColorMoveDestination: own,
    });
    await user.click(screen.getByRole("button", { name: "◆ Adds to a line" }));
    await screen.findByRole("dialog", { name: "Add to a line" });
    const group = within(popup()).getByRole("radiogroup", { name: "Which colour" });
    await waitFor(() => expect(within(group).getAllByRole("radio")).toHaveLength(2));
    for (const r of within(group).getAllByRole("radio"))
      expect(r.getAttribute("aria-checked")).toBe("false");
    expect(confirmIn().disabled).toBe(true); // neither wins by default (UIL-069)
    await user.click(within(group).getByRole("radio", { name: /File by its own colour/ }));
    await user.click(confirmIn());
    await waitFor(() => expect(shelveCardAction).toHaveBeenCalledTimes(1));
    expect(shelveCardAction.mock.calls[0][0]).toMatchObject({ override: own, lineChoice: null });
  });

  it("waits for the card's fresh derivation before it can be confirmed: that is what carries a colour question", async () => {
    const { items } = park([{ name: "Charmeleon", proposal: ADD }]);
    let answer: (v: unknown) => void = () => {};
    refreshSpotlightAction.mockImplementation(() => new Promise((r) => (answer = r)));
    const user = userEvent.setup();
    render(createElement(PlanScreen, { stateStamp: "s" }));
    await screen.findAllByText("Charmeleon");
    await user.click(screen.getByRole("button", { name: "◆ Adds to a line" }));
    // Not the popup yet: nothing can be confirmed before she is asked.
    expect(await screen.findByText("Opening its line…")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Add to a line" })).toBeNull();
    answer({
      ok: true,
      item: items[0],
      digest: "dg",
      proposedPulls: [],
      bandMismatch: {
        lineSpeciesLabel: "CHARMANDER LINE",
        lineDestination: "KB-001 · Back · Green",
        ownColorDestination: "KB-001 · Front · Red",
        ownColorMoveDestination: { kind: "shelf", binderId: "kb1", half: "front", band: "red" },
      },
    });
    await screen.findByRole("dialog", { name: "Add to a line" });
    expect(await within(popup()).findByRole("radiogroup", { name: "Which colour" })).toBeTruthy();
    expect(confirmIn().disabled).toBe(true); // and now it waits for her pick
  });

  it("opens on the FRESH proposal, not the plan's stale forecast (Charmander just started the line)", async () => {
    // The forecast says Charmeleon would START a line; after Charmander started it, the fresh derivation says ADD.
    const { items } = park([{ name: "Charmeleon", proposal: START }]);
    refreshSpotlightAction.mockResolvedValue({
      ok: true,
      item: { ...items[0], action: "FILL", lineProposal: ADD },
      digest: "dg",
      proposedPulls: [],
      bandMismatch: null,
    });
    const user = userEvent.setup();
    render(createElement(PlanScreen, { stateStamp: "s" }));
    await screen.findAllByText("Charmeleon");
    await user.click(screen.getByRole("button", { name: "＋ Starts a line" }));
    // PRE-FIX (UX review): the popup opened on the forecast's START, which would have started a second line.
    expect(await screen.findByRole("dialog", { name: "Add to a line" })).toBeTruthy();
    expect(lineModelAction).toHaveBeenLastCalledWith("id-Charmeleon", ADD);
  });

  it("closes when the fresh derivation says the card no longer goes into a line", async () => {
    const { items } = park([{ name: "Charmeleon", proposal: ADD }]);
    refreshSpotlightAction.mockResolvedValue({
      ok: true,
      item: { ...items[0], action: "FRONT", lineProposal: null },
      digest: "dg",
      proposedPulls: [],
      bandMismatch: null,
    });
    const user = userEvent.setup();
    render(createElement(PlanScreen, { stateStamp: "s" }));
    await screen.findAllByText("Charmeleon");
    await user.click(screen.getByRole("button", { name: "◆ Adds to a line" }));
    await waitFor(() => expect(refreshSpotlightAction).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("Opening its line…")).toBeNull());
    expect(screen.queryByRole("dialog", { name: "Add to a line" })).toBeNull();
    expect(await screen.findByRole("button", { name: "Done, next card" })).toBeTruthy();
  });

  it("a confirmed line write re-routes the rest, so their badges follow it", async () => {
    const user = await mount([
      { name: "Charmander", proposal: START },
      { name: "Charmeleon", proposal: START },
    ]);
    await user.click(screen.getAllByRole("button", { name: "＋ Starts a line" })[0]);
    await screen.findByRole("dialog", { name: "Start a line" });
    await waitFor(() => expect(confirmIn().disabled).toBe(false));
    await user.click(confirmIn());
    await waitFor(() => expect(shelveCardAction).toHaveBeenCalledTimes(1));
    // The batched re-route asks the server again about the one still waiting.
    await waitFor(() => expect(runHaulPlan).toHaveBeenCalled(), { timeout: 4000 });
    expect((runHaulPlan.mock.calls.at(-1)![0] as DraftPayloadItem[]).map((d) => d.id)).toEqual([
      "id-Charmeleon",
    ]);
    // Settle before reading the screen (QA): the re-route and the spotlight's fresh check are both still in flight
    // when runHaulPlan is called. Its answer here files Charmeleon in a front half, so its badge goes with it.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "＋ Starts a line" })).toBeNull();
      expect(screen.queryByText("Checking this card against your shelves…")).toBeNull();
    });
    expect(
      document.getElementById("plan-row-id-Charmeleon")?.querySelector(".linebadge"),
    ).toBeNull();
  });

  it("a refusal keeps the popup open with the reason in it", async () => {
    shelveCardAction.mockResolvedValue({
      ok: false,
      error: "That line slot no longer exists — reload the screen and pick again.",
    });
    const user = await mount([{ name: "Charmeleon", proposal: ADD }]);
    await user.click(screen.getByRole("button", { name: "◆ Adds to a line" }));
    await screen.findByRole("dialog", { name: "Add to a line" });
    await waitFor(() => expect(confirmIn().disabled).toBe(false));
    await user.click(confirmIn());
    expect(
      await within(popup()).findByText(
        "That line slot no longer exists — reload the screen and pick again.",
      ),
    ).toBeTruthy();
  });

  it("a plan parked before this change is routed again, not resumed", async () => {
    const base = routedPlan([{ ...waiting("Charmeleon"), tcgdexId: "sv03-Charmeleon" }]);
    const old = {
      ...base,
      groups: groupPlan(
        flattenPlan(base).map((it) => ({ ...it, action: "FILL" as const })),
        ["orange"],
      ),
    };
    window.sessionStorage.setItem(
      "binderops.plan.v1",
      JSON.stringify({
        stamp: "s",
        draft: [waiting("Charmeleon")],
        plan: old,
        done: [],
        cur: 0,
        overrides: {},
        collapsed: [],
        collapsedSubgroups: [],
      }),
    );
    render(createElement(PlanScreen, { stateStamp: "s", initialPending: [waiting("Charmeleon")] }));
    await waitFor(() => expect(runHaulPlan).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("RESUMED")).toBeNull();
  });
});
