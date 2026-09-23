// @vitest-environment jsdom
/**
 * UIL-092 part 1 — a card she TYPED into the Haul Plan is not derived state, and must survive everything
 * that invalidates the plan.
 *
 * Her report, minutes after migration 0018 deployed: "now my entire haul has disappeared." Nothing had
 * disappeared from the database. 0018 rewrote 545 copies from `bulk` to `haul`, the stamp
 * (lib/plan/fingerprint.ts) carries copies as a multiset of `(role, binderId, binderHalf, colorBand,
 * lineSlotId)` tuples, so her next page load saw a different stamp and `readResume` threw the WHOLE parked
 * payload away — the typed rows with it. A typed row exists nowhere but that blob until she commits it.
 *
 * The second path needs no migration at all: the parking effect opened with
 * `if (!plan) { clearResume(); return; }`, so typing ten cards and reloading before pressing Run lost all
 * ten, and actively wiped whatever was parked before.
 *
 * Driven through the REAL screen in a DOM, because half of this lives in an effect: `renderToStaticMarkup`
 * never runs effects, so a static render cannot see whether a bare draft gets parked at all.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanBandGroup } from "@/lib/plan";
import type { DraftCard, LookupCard, RunPlanResult } from "@/app/(ui)/plan/plan-types";
import { PlanScreen, restoreDraft } from "@/app/(ui)/plan/PlanScreen";

vi.mock("@/app/(ui)/plan/actions", () => ({
  shelveCardAction: vi.fn(),
  getMoveOptions: vi.fn(async () => ({ binders: [], collectionsByBinder: {}, bands: [] })),
  getLineJoinOptions: vi.fn(async () => null),
  loadPendingPlacementDraft: vi.fn(async () => []),
  lookupCatalog: vi.fn(async () => []),
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

/** A row she typed: no `existingCopyId`, so nothing about it exists server-side yet. */
const typed = (id: string, name: string): DraftCard => ({
  id,
  card: card(`sv09-${name}`, name),
  variant: "normal",
});

/** A row seeded from the DB queue: derived state, safe to re-read (UIL-003). */
const routed = (id: string, name: string): DraftCard => ({
  id,
  card: card(`sv09-${name}`, name),
  variant: "normal",
  existingCopyId: id,
  dexVariantRaw: "Normal",
});

const MEDITITE = typed("11111111-1111-4111-8111-111111111111", "Meditite");
const MACHOP = typed("22222222-2222-4222-8222-222222222222", "Machop");
const FROM_QUEUE = routed("33333333-3333-4333-8333-333333333333", "Toedscool");

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
  groups: [bandOf([{ incomingId: MEDITITE.id, name: "Meditite" }])],
  bands: [{ key: "orange", count: 1 }],
  summary: { total: 1, decisions: 0, byAction: { FRONT: 1 } },
};

const park = (blob: Record<string, unknown>) =>
  window.sessionStorage.setItem(RESUME_KEY, JSON.stringify(blob));
const parkedBlob = () => {
  const raw = window.sessionStorage.getItem(RESUME_KEY);
  return raw ? (JSON.parse(raw) as { draft: DraftCard[]; plan: unknown }) : null;
};

const base = {
  stamp: PARKED_STAMP,
  haulId: "haul-1",
  source: "bulk-bin",
  notes: "sunday bulk bin",
  draft: [] as DraftCard[],
  plan: PLAN as RunPlanResult | null,
  done: [] as string[],
  cur: 0,
  overrides: {},
  collapsed: [] as string[],
};

beforeEach(() => window.sessionStorage.clear());
afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe("UIL-092 · a typed draft row outlives the plan", () => {
  it("survives a stamp change: the row is still there, the stale plan is not", async () => {
    park({ ...base, draft: [MEDITITE, MACHOP] });
    render(createElement(PlanScreen, { stateStamp: MOVED_STAMP, initialPending: [] }));

    // Pre-fix BOTH of these failed: readResume returned null on the stamp mismatch and the draft
    // re-seeded from initialPending, so her typed cards were simply gone from the screen.
    expect(await screen.findByText("Meditite")).toBeTruthy();
    expect(screen.getByText("Machop")).toBeTruthy();
    // And the plan computed against the old state is correctly NOT restored.
    expect(screen.queryByText("RESUMED")).toBeNull();
  });

  it("survives a reload with no plan yet, because a bare draft is now parked at all", async () => {
    // Nothing stale here — the stamp matches. The bug was the parking effect clearing the key whenever
    // no plan existed, so a draft typed and not yet run was wiped on the way out.
    park({ ...base, stamp: MOVED_STAMP, plan: null, draft: [MEDITITE] });
    render(createElement(PlanScreen, { stateStamp: MOVED_STAMP, initialPending: [] }));

    expect(await screen.findByText("Meditite")).toBeTruthy();
    await waitFor(() => expect(parkedBlob()).not.toBeNull()); // pre-fix: clearResume() removed it
    expect(parkedBlob()!.draft.map((d) => d.id)).toEqual([MEDITITE.id]);
    expect(parkedBlob()!.plan).toBeNull(); // parked without one, which is the whole point
  });

  it("does NOT bring back a typed row she already committed — that would manufacture the double", async () => {
    // The subtle half. `done` only gains a row after the server confirmed the write, so a done typed row
    // is a card already in a binder. Restoring it as actionable would invite her to shelve it twice,
    // which is exactly the second Meditite copy this entry exists to prevent.
    park({ ...base, draft: [MEDITITE, MACHOP], done: [MEDITITE.id] });
    render(createElement(PlanScreen, { stateStamp: MOVED_STAMP, initialPending: [] }));

    expect(await screen.findByText("Machop")).toBeTruthy();
    expect(screen.queryByText("Meditite")).toBeNull();
  });

  it("a DB-backed row is re-read from the server, not restored from the blob", async () => {
    // The mirror image: a routed row IS derived state. If the copy has been placed or removed since she
    // parked, it must not come back — and when it is still queued, the server's copy of it wins.
    park({ ...base, draft: [FROM_QUEUE, MEDITITE] });
    render(createElement(PlanScreen, { stateStamp: MOVED_STAMP, initialPending: [] }));

    expect(await screen.findByText("Meditite")).toBeTruthy();
    expect(screen.queryByText("Toedscool")).toBeNull(); // no longer queued → gone
  });
});

describe("UIL-092 · restoreDraft, the rescue rule on its own", () => {
  const parked = (over: Partial<typeof base> = {}) => ({
    state: { ...base, ...over } as never,
    stampMatches: false,
  });

  it("keeps her parked ORDER and appends rows that are new since she parked", () => {
    const fresh = routed("44444444-4444-4444-8444-444444444444", "Rockruff");
    const out = restoreDraft(parked({ draft: [MEDITITE, FROM_QUEUE] }), [FROM_QUEUE, fresh]);
    // She works a physical stack in the order it sits; re-sorting it mid-sitting costs her her place.
    expect(out.draft.map((d) => d.card.name)).toEqual(["Meditite", "Toedscool", "Rockruff"]);
    expect(out.keptTyped).toBe(1);
  });

  it("returns the parked draft untouched when the stamp still holds", () => {
    const out = restoreDraft(
      { state: { ...base, draft: [MEDITITE, FROM_QUEUE] } as never, stampMatches: true },
      [],
    );
    expect(out.draft.map((d) => d.id)).toEqual([MEDITITE.id, FROM_QUEUE.id]);
  });

  it("falls back to the server queue when nothing is parked", () => {
    expect(restoreDraft(null, [FROM_QUEUE]).draft).toEqual([FROM_QUEUE]);
  });
});
