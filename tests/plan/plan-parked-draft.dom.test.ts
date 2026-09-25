// @vitest-environment jsdom
/**
 * UIL-092 part 1, narrowed by UIL-098 part 2 — what a parked Haul Plan sitting brings back.
 *
 * UIL-092's report: "now my entire haul has disappeared." Migration 0018 rewrote 545 copies from `bulk` to
 * `haul`, the stamp (lib/plan/fingerprint.ts) carries copies as a multiset of placement tuples, so her next
 * page load saw a different stamp and `readResume` threw the WHOLE parked payload away. And the parking
 * effect opened with `if (!plan) { clearResume(); return; }`, so a draft not yet run was wiped on reload.
 *
 * Both fixes stand. What changed with UIL-098 part 2 is the row a draft can hold: every row is now a copy
 * her Dex import made, waiting in her haul, so every row is DERIVED state and is re-read from the server
 * queue when the stamp has moved. A hand-typed row parked by an older build cannot be placed any more (the
 * server refuses it), so it is dropped — and NAMED on screen, once, because a typed row existed nowhere but
 * that blob and UIL-092's rule is that her input is never lost silently.
 *
 * Driven through the REAL screen in a DOM, because half of this lives in an effect: `renderToStaticMarkup`
 * never runs effects, so a static render cannot see whether a bare draft gets parked at all.
 */
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanBandGroup } from "@/lib/plan";
import type { DraftCard, LookupCard, RunPlanResult } from "@/app/(ui)/plan/plan-types";
import { PlanScreen, restoreDraft } from "@/app/(ui)/plan/PlanScreen";

vi.mock("@/app/(ui)/plan/actions", () => ({
  shelveCardAction: vi.fn(),
  getMoveOptions: vi.fn(async () => ({ binders: [], collectionsByBinder: {}, bands: [] })),
  getLineJoinOptions: vi.fn(async () => null),
  loadPendingPlacementDraft: vi.fn(async () => []),
  refreshSpotlightAction: vi.fn(async () => ({ ok: false, error: "not used" })),
  runHaulPlan: vi.fn(async () => ({ ok: false, error: "not used" })),
}));

const RESUME_KEY = "binderops.plan.v1";
const PARKED_STAMP = "stamp-before-0018";
/** What the server hands the screen after 0018 moved 545 copies from bulk to haul. */
const MOVED_STAMP = "stamp-after-0018";

const card = (tcgdexId: string, name: string): LookupCard => ({
  tcgdexId,
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

/** A row seeded from the DB queue: a copy her import made, waiting in her haul (UIL-003). */
const queued = (id: string, name: string): DraftCard => ({
  id,
  card: card(`sv09-${name}`, name),
  variant: "normal",
  existingCopyId: id,
  dexVariantRaw: "Normal",
});

/** A row she TYPED on a build before UIL-098 part 2, as it sits in an old parked blob: no copy. */
const legacyTyped = (id: string, name: string): DraftCard =>
  ({ id, card: card(`sv09-${name}`, name), variant: "normal" }) as DraftCard;

const TOEDSCOOL = queued("33333333-3333-4333-8333-333333333333", "Toedscool");
const ROCKRUFF = queued("44444444-4444-4444-8444-444444444444", "Rockruff");
const MEDITITE = legacyTyped("11111111-1111-4111-8111-111111111111", "Meditite");
const MACHOP = legacyTyped("22222222-2222-4222-8222-222222222222", "Machop");

function bandOf(rows: { incomingId: string; name: string }[]): PlanBandGroup {
  return {
    bandKey: "orange",
    count: rows.length,
    subgroups: [
      {
        kind: "basic",
        label: "BASICS",
        rows: rows.map((r) => ({
          incomingId: r.incomingId,
          tcgdexId: `sv09-${r.name}`,
          name: r.name,
          setId: "sv09",
          localId: "017",
          imageUrl: null,
          variant: "normal" as const,
          stage: "Basic",
          isBasic: true,
          bandKey: "orange",
          action: "FRONT" as const,
          destination: "KB-001 · Front · Orange",
          reason: "Front half.",
          needsDecision: false,
        })),
      },
    ],
  };
}

const PLAN: RunPlanResult = {
  groups: [bandOf([{ incomingId: TOEDSCOOL.id, name: "Toedscool" }])],
  bands: [{ key: "orange", count: 1 }],
  summary: { total: 1, decisions: 0, byAction: { FRONT: 1 } },
};

const park = (blob: Record<string, unknown>) =>
  window.sessionStorage.setItem(RESUME_KEY, JSON.stringify(blob));
const parkedBlob = () => {
  const raw = window.sessionStorage.getItem(RESUME_KEY);
  return raw ? (JSON.parse(raw) as Record<string, unknown> & { draft: DraftCard[] }) : null;
};

const base = {
  stamp: PARKED_STAMP,
  draft: [] as DraftCard[],
  plan: PLAN as RunPlanResult | null,
  done: [] as string[],
  cur: 0,
  overrides: {},
  collapsed: [] as string[],
};
/** The fields a blob parked before UIL-098 part 2 also carried. */
const LEGACY_FIELDS = { haulId: "haul-1", source: "bulk-bin", notes: "sunday bulk bin" };

beforeEach(() => window.sessionStorage.clear());
afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe("UIL-092 · a parked draft outlives the plan", () => {
  it("on a stamp change, a row still queued comes back and the stale plan does not", async () => {
    park({ ...base, draft: [TOEDSCOOL] });
    render(createElement(PlanScreen, { stateStamp: MOVED_STAMP, initialPending: [TOEDSCOOL] }));

    // Pre-UIL-092 the whole blob went in the bin here, draft included.
    expect(await screen.findByText("Toedscool")).toBeTruthy();
    // The plan computed against the old state is correctly NOT restored.
    expect(screen.queryByText("RESUMED")).toBeNull();
  });

  it("on a stamp change, a row NO LONGER queued is dropped — it was placed or removed since", async () => {
    park({ ...base, draft: [TOEDSCOOL, ROCKRUFF] });
    render(createElement(PlanScreen, { stateStamp: MOVED_STAMP, initialPending: [ROCKRUFF] }));

    expect(await screen.findByText("Rockruff")).toBeTruthy();
    expect(screen.queryByText("Toedscool")).toBeNull();
  });

  it("survives a reload with no plan yet, because a bare draft is parked at all", async () => {
    // The bug was the parking effect clearing the key whenever no plan existed.
    park({ ...base, stamp: MOVED_STAMP, plan: null, draft: [TOEDSCOOL] });
    render(createElement(PlanScreen, { stateStamp: MOVED_STAMP, initialPending: [TOEDSCOOL] }));

    expect(await screen.findByText("Toedscool")).toBeTruthy();
    await waitFor(() => expect(parkedBlob()).not.toBeNull()); // pre-UIL-092: clearResume() removed it
    expect(parkedBlob()!.draft.map((d) => d.id)).toEqual([TOEDSCOOL.id]);
    expect(parkedBlob()!.plan).toBeNull();
  });
});

describe("UIL-098 · a hand-typed row parked by an older build is dropped, and named", () => {
  it("is taken off the plan and listed by name, with the way to bring it in", async () => {
    park({ ...base, ...LEGACY_FIELDS, draft: [MEDITITE, TOEDSCOOL, MACHOP] });
    render(createElement(PlanScreen, { stateStamp: MOVED_STAMP, initialPending: [TOEDSCOOL] }));

    const notice = await screen.findByRole("status");
    expect(notice.textContent).toContain("2 cards you typed in by hand were taken off this plan");
    expect(notice.textContent).toContain("Meditite, Machop");
    expect(notice.textContent).toContain("add them in Dex, then import on the Sync page");
    // The copy-backed row is still there to place.
    expect(screen.getByText("Toedscool")).toBeTruthy();
  });

  it("is dropped even when the stamp still holds — the server would refuse it either way", async () => {
    park({ ...base, stamp: MOVED_STAMP, plan: null, draft: [MEDITITE, TOEDSCOOL] });
    render(createElement(PlanScreen, { stateStamp: MOVED_STAMP, initialPending: [TOEDSCOOL] }));

    const notice = await screen.findByRole("status");
    expect(notice.textContent).toContain("1 card you typed in by hand was taken off this plan");
    expect(notice.textContent).toContain("Meditite");
    // And it is not re-parked, so the notice is shown once rather than on every reload.
    await waitFor(() => expect(parkedBlob()!.draft.map((d) => d.id)).toEqual([TOEDSCOOL.id]));
  });

  it("the old blob's haul id, source and notes are not written back", async () => {
    park({ ...base, ...LEGACY_FIELDS, stamp: MOVED_STAMP, plan: null, draft: [TOEDSCOOL] });
    render(createElement(PlanScreen, { stateStamp: MOVED_STAMP, initialPending: [TOEDSCOOL] }));

    await screen.findByText("Toedscool");
    await waitFor(() => expect(parkedBlob()).not.toBeNull());
    expect(parkedBlob()).not.toHaveProperty("haulId");
    expect(parkedBlob()).not.toHaveProperty("source");
    expect(parkedBlob()).not.toHaveProperty("notes");
  });

  it("'Got it' dismisses the notice", async () => {
    park({ ...base, draft: [MEDITITE] });
    render(createElement(PlanScreen, { stateStamp: MOVED_STAMP, initialPending: [] }));

    fireEvent.click(await screen.findByRole("button", { name: "Got it" }));
    expect(screen.queryByText(/typed in by hand/)).toBeNull();
  });

  it("shows no notice when nothing typed was parked", async () => {
    park({ ...base, draft: [TOEDSCOOL] });
    render(createElement(PlanScreen, { stateStamp: MOVED_STAMP, initialPending: [TOEDSCOOL] }));

    await screen.findByText("Toedscool");
    expect(screen.queryByText(/typed in by hand/)).toBeNull();
  });
});

describe("restoreDraft, the rule on its own", () => {
  const parked = (draft: DraftCard[], stampMatches = false) => ({
    state: { ...base, draft } as never,
    stampMatches,
  });

  it("keeps her parked ORDER and appends rows that are new since she parked", () => {
    const out = restoreDraft(parked([ROCKRUFF, TOEDSCOOL]), [
      TOEDSCOOL,
      ROCKRUFF,
      queued("55555555-5555-4555-8555-555555555555", "Riolu"),
    ]);
    // She works a physical stack in the order it sits; re-sorting it mid-sitting costs her her place.
    expect(out.draft.map((d) => d.card.name)).toEqual(["Rockruff", "Toedscool", "Riolu"]);
    expect(out.droppedTyped).toEqual([]);
  });

  it("returns the parked draft as it was when the stamp still holds, minus any typed row", () => {
    const out = restoreDraft(parked([TOEDSCOOL, MEDITITE, ROCKRUFF], true), []);
    expect(out.draft.map((d) => d.id)).toEqual([TOEDSCOOL.id, ROCKRUFF.id]);
    expect(out.droppedTyped.map((d) => d.id)).toEqual([MEDITITE.id]);
  });

  it("hands back every typed row on a stamp change too", () => {
    const out = restoreDraft(parked([MEDITITE, TOEDSCOOL, MACHOP]), [TOEDSCOOL]);
    expect(out.draft.map((d) => d.id)).toEqual([TOEDSCOOL.id]);
    expect(out.droppedTyped.map((d) => d.id)).toEqual([MEDITITE.id, MACHOP.id]);
  });

  it("falls back to the server queue when nothing is parked", () => {
    expect(restoreDraft(null, [TOEDSCOOL])).toEqual({ draft: [TOEDSCOOL], droppedTyped: [] });
  });
});
