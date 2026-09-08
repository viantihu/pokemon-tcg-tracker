import { describe, it, expect } from "vitest";
import {
  applyOverrides,
  consequenceOf,
  fastPathNotification,
  isNoop,
  migrationKey,
  requiresPreview,
  type SyncOverrides,
} from "@/lib/sync/apply";
import {
  reconcile,
  type CopySnapshot,
  type CurrentGroup,
  type ResolvedRow,
} from "@/lib/sync/reconcile";
import { presenceKey } from "@/lib/sync/diff";

/**
 * M9 fast-path gating (sync-ui-spec §B.1) + preview overrides (§B.3), built on the frozen M4
 * reconciler. Real, verified cards only: me04-29 Ampharos, sv10-103 Cynthia's Gabite.
 */

const AMPHAROS = "me04-29";
const GABITE = "sv10-103";

function row(
  catalogCardId: string | null,
  dexVariantRaw: string,
  quantity = 1,
  type = "collection",
): ResolvedRow {
  return {
    type,
    catalogCardId,
    dexVariantRaw,
    quantity,
    raw: {
      dexId: "me4-29",
      setName: "Mega Symphonia",
      series: "Mega Evolution",
      number: "29",
      name: "Ampharos",
      locale: "English",
    },
  };
}

function copy(copyId: string, o: Partial<CopySnapshot> = {}): CopySnapshot {
  return {
    copyId,
    role: "shelved",
    binderId: null,
    binderHalf: null,
    colorBand: null,
    lineSlotId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...o,
  };
}

function group(catalogCardId: string, dexVariantRaw: string, copies: CopySnapshot[]): CurrentGroup {
  return { catalogCardId, dexVariantRaw, copies };
}

const clock = () => new Date("2026-09-07T00:00:00.000Z");

describe("requiresPreview — the fast-path gate (§B.1)", () => {
  it("additions-only import auto-applies (no gate)", () => {
    const plan = reconcile({ rows: [row(GABITE, "Normal", 2)], current: [], clock });
    expect(plan.creates.length).toBe(2);
    expect(plan.retires.length).toBe(0);
    expect(plan.variantUpdates.length).toBe(0);
    expect(plan.fastPath).toBe(true);
    expect(requiresPreview(plan)).toBe(false);
  });

  it("ANY removal forces the preview", () => {
    // Desired drops the Gabite entirely (present in current, absent from the export).
    const plan = reconcile({
      rows: [row(AMPHAROS, "Holo", 1)],
      current: [group(GABITE, "Normal", [copy("c1")]), group(AMPHAROS, "Holo", [copy("c2")])],
      clock,
    });
    expect(plan.retires.length).toBe(1);
    expect(plan.fastPath).toBe(false);
    expect(requiresPreview(plan)).toBe(true);
  });

  it("a variant migration forces the preview even with no net removal", () => {
    const plan = reconcile({
      rows: [row(AMPHAROS, "Holo", 1)],
      current: [group(AMPHAROS, "Reverse Holo", [copy("c1", { role: "shelved", binderId: "b1" })])],
      clock,
    });
    expect(plan.variantUpdates.length).toBe(1);
    expect(requiresPreview(plan)).toBe(true);
  });
});

describe("idempotency — re-importing the same desired state is a no-op", () => {
  it("classifies everything UNCHANGED and produces an empty plan", () => {
    const current = [group(GABITE, "Normal", [copy("c1")]), group(AMPHAROS, "Holo", [copy("c2")])];
    const plan = reconcile({
      rows: [row(GABITE, "Normal", 1), row(AMPHAROS, "Holo", 1)],
      current,
      clock,
    });
    expect(plan.creates.length + plan.retires.length + plan.variantUpdates.length).toBe(0);
    expect(
      isNoop({
        creates: plan.creates.length,
        retires: plan.retires.length,
        variantUpdates: plan.variantUpdates.length,
        parks: 0,
        drops: 0,
        promotions: 0,
        dedupeUpdates: 0,
      }),
    ).toBe(true);
  });
});

describe("retry-only self-heal is purely additive (§A.5)", () => {
  // svi-084 Ralts — a verified real id (dev-spec §5 M1 "RALTS SVI-084 Matsuno example").
  const RALTS = "svi-084";
  it("promotes a resolved entry as ADDED without touching the rest of the collection", () => {
    // A retry reconciles ONLY against the promoted keys (pipeline filters `current`), never the whole
    // collection — else every un-promoted owned card would classify REMOVED. Emulate the filter:
    const fullCollection = [
      group(GABITE, "Normal", [copy("g1")]),
      group(AMPHAROS, "Holo", [copy("a1")]),
    ];
    const promoted = [row(RALTS, "Normal", 2)];
    const promotedKeys = new Set(
      promoted.map((r) => presenceKey(r.catalogCardId!, r.dexVariantRaw)),
    );
    const filtered = fullCollection.filter((g) =>
      promotedKeys.has(presenceKey(g.catalogCardId, g.dexVariantRaw)),
    );

    const plan = reconcile({ rows: promoted, current: filtered, clock });
    expect(plan.creates.length).toBe(2); // the promoted Ralts, unplaced
    expect(plan.retires.length).toBe(0); // Gabite + Ampharos are untouched
    expect(plan.fastPath).toBe(true);
  });
});

describe("fastPathNotification (§B.1 text)", () => {
  it("reads '6 new cards added · 5 waiting on catalog · tap to place'", () => {
    expect(fastPathNotification(6, 5)).toBe(
      "6 new cards added · 5 waiting on catalog · tap to place",
    );
  });
  it("singularises and drops the waiting clause when zero", () => {
    expect(fastPathNotification(1, 0)).toBe("1 new card added · tap to place");
  });
});

describe("consequenceOf — the removal rule (§1.6)", () => {
  it("maps a copy's role/placement to its release consequence", () => {
    expect(consequenceOf(copy("x", { role: "block" }))).toEqual({
      consequence: "block-review",
      needsReview: true,
    });
    expect(consequenceOf(copy("x", { lineSlotId: "s1" }))).toEqual({
      consequence: "line-slot-freed",
      needsReview: false,
    });
    expect(consequenceOf(copy("x", { role: "shelved", binderId: "b1" }))).toEqual({
      consequence: "shelved-cleared",
      needsReview: false,
    });
    expect(consequenceOf(copy("x", { role: "bulk" }))).toEqual({
      consequence: "bulk-removed",
      needsReview: false,
    });
    expect(consequenceOf(copy("x", { role: "shelved" }))).toEqual({
      consequence: "unplaced-removed",
      needsReview: false,
    });
  });
});

describe("applyOverrides — reject a variant migration (§B.3, §D)", () => {
  it("splits a rejected migration into a true retire + a true add", () => {
    const current = [
      group(AMPHAROS, "Reverse Holo", [copy("rev", { role: "shelved", binderId: "b1" })]),
    ];
    const plan = reconcile({ rows: [row(AMPHAROS, "Holo", 1)], current, clock });
    // The pure reconcile pairs Reverse Holo → Holo as a placement-preserving migration.
    expect(plan.variantUpdates).toHaveLength(1);
    const mk = migrationKey(AMPHAROS, "Reverse Holo", "Holo");

    const adjusted = applyOverrides(plan, current, { rejectedMigrations: [mk] });
    expect(adjusted.variantUpdates).toHaveLength(0);
    expect(adjusted.retires).toHaveLength(1);
    expect(adjusted.retires[0]).toMatchObject({ copyId: "rev", consequence: "shelved-cleared" });
    expect(adjusted.creates.some((c) => c.dexVariantRaw === "Holo")).toBe(true);
    expect(requiresPreview(adjusted)).toBe(true); // still gated — a real removal now
  });
});

describe("applyOverrides — which copy leaves on a shrink (§B.3)", () => {
  it("retires the copy she picked instead of the least-committed default", () => {
    const committed = copy("placed", { role: "shelved", binderId: "b1", binderHalf: "front" });
    const loose = copy("bulk", { role: "bulk" });
    const current = [group(GABITE, "Normal", [committed, loose])];
    const plan = reconcile({ rows: [row(GABITE, "Normal", 1)], current, clock });

    // Default: reconcile retires the least-committed (bulk) copy.
    expect(plan.retires).toHaveLength(1);
    expect(plan.retires[0].copyId).toBe("bulk");

    const key = presenceKey(GABITE, "Normal");
    const overrides: SyncOverrides = { retireChoice: { [key]: ["placed"] } };
    const adjusted = applyOverrides(plan, current, overrides);
    expect(adjusted.retires).toHaveLength(1);
    expect(adjusted.retires[0]).toMatchObject({ copyId: "placed", consequence: "shelved-cleared" });
  });

  it("ignores a choice whose count does not match the shrink (defensive)", () => {
    const current = [
      group(GABITE, "Normal", [copy("a", { binderId: "b1" }), copy("b", { role: "bulk" })]),
    ];
    const plan = reconcile({ rows: [row(GABITE, "Normal", 1)], current, clock });
    const key = presenceKey(GABITE, "Normal");
    // Two copyIds for a one-copy shrink → override rejected, default kept.
    const adjusted = applyOverrides(plan, current, { retireChoice: { [key]: ["a", "b"] } });
    expect(adjusted.retires.map((r) => r.copyId)).toEqual(plan.retires.map((r) => r.copyId));
  });

  it("is identity when no overrides are supplied", () => {
    const current = [group(GABITE, "Normal", [copy("a")])];
    const plan = reconcile({ rows: [row(GABITE, "Normal", 2)], current, clock });
    expect(applyOverrides(plan, current, {})).toBe(plan);
    expect(applyOverrides(plan, current, undefined)).toBe(plan);
  });
});
