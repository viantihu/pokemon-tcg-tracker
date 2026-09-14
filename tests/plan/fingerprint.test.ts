/**
 * The plan state stamp (UIL-006) — what makes resuming a cached plan safe rather than merely fast.
 *
 * Her rule is "the only time the haul plan needs to reload is if there's been a change in the sync".
 * Honouring that means caching the run, and caching is only safe if the stamp reliably moves whenever
 * any cascade input does. A stamp that missed a change would silently show a plan computed against
 * state that no longer exists — worse than making her re-run. So every input gets a test, and the two
 * that a naive count-based stamp would miss — an in-place binder capacity edit (v1) and an in-place
 * copy move or slot/line state change (v2, UIL-006 follow-up) — get called out explicitly.
 */
import { describe, expect, it } from "vitest";
import { planFingerprint, type StampCopyPlacement, type PlanFingerprintParts } from "@/lib/plan";

/** A shelved copy in a binder half. Distinct-placement tuples are what the copy digest groups on. */
const shelved = (over: Partial<StampCopyPlacement> = {}): StampCopyPlacement => ({
  role: "shelved",
  binderId: "b1",
  binderHalf: "front",
  colorBand: "red",
  lineSlotId: null,
  ...over,
});

const bulk = (over: Partial<StampCopyPlacement> = {}): StampCopyPlacement => ({
  role: "bulk",
  binderId: null,
  binderHalf: null,
  colorBand: null,
  lineSlotId: null,
  ...over,
});

const BASE: PlanFingerprintParts = {
  copies: [
    shelved({ binderHalf: "front" }),
    shelved({ binderHalf: "back", lineSlotId: "slot-1" }),
    bulk(),
    bulk(),
    bulk(),
  ],
  pendingCopyIds: ["copy-a", "copy-b", "copy-c"],
  snapshotId: "snap-1",
  lines: [
    { id: "line-1", status: "open", colorBand: "red" },
    { id: "line-2", status: "capped", colorBand: "light_blue" },
  ],
  slots: [
    { id: "slot-1", state: "filled", copyId: "copy-x", targetCatalogCardId: "cc-1" },
    { id: "slot-2", state: "placeholder", copyId: null, targetCatalogCardId: "cc-2" },
    { id: "slot-3", state: "block", copyId: null, targetCatalogCardId: null },
  ],
  binders: [
    { id: "b1", type: "general", pages: 40, pocketsPerPage: 9, backHalfStartPage: 21 },
    { id: "b2", type: "specialty", pages: 30, pocketsPerPage: 9, backHalfStartPage: null },
  ],
  collections: [{ id: "c1", targetCount: 7 }],
  typeMap: [
    { cardType: "Fire", band: "red" },
    { cardType: "Water", band: "light_blue" },
  ],
  decisionCount: 5,
};

const stamp = (over: Partial<PlanFingerprintParts> = {}) => planFingerprint({ ...BASE, ...over });

describe("planFingerprint is stable for unchanged state", () => {
  it("is deterministic", () => {
    expect(stamp()).toBe(stamp());
  });

  it("stamps the shape version so an old cached plan is dropped on deploy", () => {
    expect(stamp()).toContain('"v":2');
  });

  it("does not depend on the ORDER of sets it was handed", () => {
    expect(
      stamp({
        copies: [...BASE.copies].reverse(),
        lines: [...BASE.lines].reverse(),
        slots: [...BASE.slots].reverse(),
        binders: [...BASE.binders].reverse(),
        typeMap: [...BASE.typeMap].reverse(),
      }),
    ).toBe(stamp());
  });

  it("DOES depend on the order of the pending queue — the plan's rows are worked in it", () => {
    expect(stamp({ pendingCopyIds: ["copy-c", "copy-b", "copy-a"] })).not.toBe(stamp());
  });

  it("is blind to two copies swapping WITHIN one placement tuple — the cascade is too", () => {
    // The two bulk copies are identical placements; reordering them changes nothing that routes.
    const swapped = [BASE.copies[0], BASE.copies[1], bulk(), bulk(), bulk()];
    expect(stamp({ copies: swapped })).toBe(stamp());
  });
});

describe("planFingerprint moves when a cascade input moves", () => {
  const cases: [string, Partial<PlanFingerprintParts>][] = [
    ["a haul commit or sync add adds a copy", { copies: [...BASE.copies, bulk()] }],
    ["a sync retire removes a copy", { copies: BASE.copies.slice(1) }],
    ["the pending queue gains a card", { pendingCopyIds: [...BASE.pendingCopyIds, "copy-d"] }],
    ["the pending queue loses a card", { pendingCopyIds: ["copy-a", "copy-b"] }],
    ["a sync apply overwrites the undo snapshot", { snapshotId: "snap-2" }],
    ["an undo consumes the snapshot", { snapshotId: null }],
    [
      "a line is created",
      { lines: [...BASE.lines, { id: "line-3", status: "open", colorBand: "green" }] },
    ],
    [
      "a slot is added",
      {
        slots: [
          ...BASE.slots,
          { id: "slot-4", state: "placeholder", copyId: null, targetCatalogCardId: null },
        ],
      },
    ],
    [
      "a binder is added",
      {
        binders: [
          ...BASE.binders,
          { id: "b3", type: "general", pages: 20, pocketsPerPage: 9, backHalfStartPage: 11 },
        ],
      },
    ],
    ["a binder is deleted", { binders: [BASE.binders[0]] }],
    ["a collection's membership changes", { collections: [{ id: "c1", targetCount: 8 }] }],
    ["a collection is added", { collections: [...BASE.collections, { id: "c2", targetCount: 1 }] }],
    [
      "a type is remapped to another band",
      { typeMap: [{ cardType: "Fire", band: "orange" }, BASE.typeMap[1]] },
    ],
    ["a user move or decision writes an audit row", { decisionCount: 6 }],
  ];

  for (const [label, over] of cases) {
    it(label, () => {
      expect(stamp(over)).not.toBe(stamp());
    });
  }

  /**
   * The case that justifies carrying whole binder rows rather than a count. Editing a binder's pages,
   * pockets or divider changes capacity — which steers front-half suggestion and new-line assignment —
   * without changing how many binders exist.
   */
  it("an IN-PLACE binder capacity edit, which a row count would miss entirely", () => {
    const countUnchanged = { ...BASE.binders[0], pages: 60 };
    const edited = stamp({ binders: [countUnchanged, BASE.binders[1]] });
    expect(edited).not.toBe(stamp());
    // Same number of binders — a count-based stamp would have called this unchanged.
    expect(BASE.binders.length).toBe(2);
  });

  it("a divider edit alone, same page and pocket counts", () => {
    const redivided = { ...BASE.binders[0], backHalfStartPage: 11 };
    expect(stamp({ binders: [redivided, BASE.binders[1]] })).not.toBe(stamp());
  });

  it("clearing a divider (the UIL-001 zero-back-half case) also moves it", () => {
    const noDivider = { ...BASE.binders[0], backHalfStartPage: null };
    expect(stamp({ binders: [noDivider, BASE.binders[1]] })).not.toBe(stamp());
  });
});

/**
 * The UIL-006 follow-up (the v2 gap). Both edits below are reachable from the M7 line screen, leave
 * every ROW COUNT unchanged, and change what an incoming card routes to. v1 counted copies, lines and
 * slots and so missed all of them; each gets a test that a count-based stamp would have failed.
 */
describe("planFingerprint moves on an IN-PLACE edit that leaves counts unchanged", () => {
  it("a copy moved front → back (same count, same role) — changes the duplicate/pull routing", () => {
    // resolveDuplicate + the pull-from-front-half hint both read binder_half, so this must move.
    const moved = [
      shelved({ binderHalf: "back" }), // was "front"
      BASE.copies[1],
      bulk(),
      bulk(),
      bulk(),
    ];
    expect(BASE.copies.length).toBe(moved.length); // count unchanged
    expect(stamp({ copies: moved })).not.toBe(stamp());
  });

  it("a copy moved shelved → bulk — drops it from the duplicate check", () => {
    // resolveDuplicate only considers role: 'shelved'; demoting one changes what a dup routes to.
    const moved = [bulk(), BASE.copies[1], bulk(), bulk(), bulk()]; // copies[0] was shelved
    expect(BASE.copies.length).toBe(moved.length); // count unchanged
    expect(stamp({ copies: moved })).not.toBe(stamp());
  });

  it("a copy pulled OFF a line (line_slot_id cleared) — count and role unchanged", () => {
    const moved = [
      BASE.copies[0],
      shelved({ binderHalf: "back", lineSlotId: null }), // was slot-1
      bulk(),
      bulk(),
      bulk(),
    ];
    expect(BASE.copies.length).toBe(moved.length);
    expect(stamp({ copies: moved })).not.toBe(stamp());
  });

  it("a copy's color_band remapped in place", () => {
    const moved = [shelved({ colorBand: "orange" }), BASE.copies[1], bulk(), bulk(), bulk()];
    expect(stamp({ copies: moved })).not.toBe(stamp());
  });

  it("a slot flipped filled → placeholder (same slot count) — the cascade routes FILL vs FRONT on it", () => {
    const flipped = BASE.slots.map((s) =>
      s.id === "slot-1" ? { ...s, state: "placeholder", copyId: null } : s,
    );
    expect(flipped.length).toBe(BASE.slots.length); // count unchanged
    expect(stamp({ slots: flipped })).not.toBe(stamp());
  });

  it("a slot's filling copy changes (copy_id) with state still filled", () => {
    const swapped = BASE.slots.map((s) => (s.id === "slot-1" ? { ...s, copyId: "copy-y" } : s));
    expect(stamp({ slots: swapped })).not.toBe(stamp());
  });

  it("a placeholder slot's wishlist target changes", () => {
    const retargeted = BASE.slots.map((s) =>
      s.id === "slot-2" ? { ...s, targetCatalogCardId: "cc-9" } : s,
    );
    expect(stamp({ slots: retargeted })).not.toBe(stamp());
  });

  it("a line status open → capped (same line count) — decision resolution caps a line in place", () => {
    const capped = BASE.lines.map((l) => (l.id === "line-1" ? { ...l, status: "capped" } : l));
    expect(capped.length).toBe(BASE.lines.length); // count unchanged
    expect(stamp({ lines: capped })).not.toBe(stamp());
  });

  it("a line status open → terminated also moves it", () => {
    const terminated = BASE.lines.map((l) =>
      l.id === "line-1" ? { ...l, status: "terminated" } : l,
    );
    expect(stamp({ lines: terminated })).not.toBe(stamp());
  });
});

describe("planFingerprint edge shapes", () => {
  it("handles an empty everything without collapsing distinct states together", () => {
    const empty = planFingerprint({
      copies: [],
      pendingCopyIds: [],
      snapshotId: null,
      lines: [],
      slots: [],
      binders: [],
      collections: [],
      typeMap: [],
      decisionCount: 0,
    });
    expect(empty).toContain('"v":2');
    expect(empty).not.toBe(stamp());
  });

  it("does not confuse a null divider with a zero divider", () => {
    const a = stamp({
      binders: [
        { id: "b1", type: "general", pages: 40, pocketsPerPage: 9, backHalfStartPage: null },
      ],
    });
    const b = stamp({
      binders: [{ id: "b1", type: "general", pages: 40, pocketsPerPage: 9, backHalfStartPage: 0 }],
    });
    expect(a).not.toBe(b);
  });

  it("does not confuse an unbound slot (null copy) with one bound to a copy named 'null'", () => {
    const a = stamp({
      slots: [{ id: "slot-1", state: "filled", copyId: null, targetCatalogCardId: null }],
    });
    const b = stamp({
      slots: [{ id: "slot-1", state: "filled", copyId: "null", targetCatalogCardId: null }],
    });
    expect(a).not.toBe(b);
  });

  it("distinguishes a queue of one from a queue whose single id contains the separator", () => {
    expect(stamp({ pendingCopyIds: ["a|b"] })).not.toBe(stamp({ pendingCopyIds: ["a", "b"] }));
  });
});
