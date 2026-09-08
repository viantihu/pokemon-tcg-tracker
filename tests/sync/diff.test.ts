import { describe, it, expect } from "vitest";
import { diff, toPresenceMap, type PresenceCount } from "@/lib/sync/diff";

/**
 * Count-level classification + variant-migration pairing (sync-architecture §1.7).
 * Card ids are real (me04-29 Ampharos, sv10-103 Cynthia's Gabite — verified in the Appendix).
 */

const AMPHAROS = "me04-29";
const GABITE = "sv10-103";

function map(entries: PresenceCount[]) {
  return toPresenceMap(entries);
}

describe("diff — per-key classification", () => {
  it("classifies ADDED / REMOVED / CHANGED / UNCHANGED", () => {
    const desired = map([
      { catalogCardId: GABITE, dexVariantRaw: "Normal", count: 1 }, // unchanged
      { catalogCardId: AMPHAROS, dexVariantRaw: "Holo", count: 2 }, // changed 1 -> 2
      { catalogCardId: AMPHAROS, dexVariantRaw: "Cosmos Holo", count: 1 }, // added
    ]);
    const current = map([
      { catalogCardId: GABITE, dexVariantRaw: "Normal", count: 1 },
      { catalogCardId: AMPHAROS, dexVariantRaw: "Holo", count: 1 },
      { catalogCardId: AMPHAROS, dexVariantRaw: "Reverse Holo", count: 1 }, // removed
    ]);

    const d = diff(desired, current);
    const cls = (id: string, v: string) =>
      d.entries.find((e) => e.catalogCardId === id && e.dexVariantRaw === v)?.class;

    expect(cls(GABITE, "Normal")).toBe("UNCHANGED");
    expect(cls(AMPHAROS, "Holo")).toBe("CHANGED");
    expect(cls(AMPHAROS, "Cosmos Holo")).toBe("ADDED");
    expect(cls(AMPHAROS, "Reverse Holo")).toBe("REMOVED");
  });
});

describe("diff — variant-migration pairing (§1.6)", () => {
  it("pairs a REMOVED variant with an ADDED variant of the SAME card", () => {
    const desired = map([{ catalogCardId: AMPHAROS, dexVariantRaw: "Reverse Holo", count: 1 }]);
    const current = map([{ catalogCardId: AMPHAROS, dexVariantRaw: "Normal", count: 1 }]);

    const d = diff(desired, current);
    expect(d.migrations).toEqual([
      { catalogCardId: AMPHAROS, fromVariantRaw: "Normal", toVariantRaw: "Reverse Holo", count: 1 },
    ]);
    expect(d.counts.variantUpdate).toBe(1);
    expect(d.fastPath).toBe(false); // a variant change can disturb placement → gated
  });

  it("does NOT pair across different cards (the phantom stays a true removal)", () => {
    // me04-29 Normal removed; a DIFFERENT card gains a copy → no pairing.
    const desired = map([{ catalogCardId: GABITE, dexVariantRaw: "Normal", count: 1 }]);
    const current = map([{ catalogCardId: AMPHAROS, dexVariantRaw: "Normal", count: 1 }]);

    const d = diff(desired, current);
    expect(d.migrations).toHaveLength(0);
    expect(d.counts.removed).toBe(1);
    expect(d.counts.added).toBe(1);
  });
});

describe("diff — fast-path rule (sync-ui-spec §B.1)", () => {
  it("is fast-path for additions-only diffs", () => {
    const desired = map([
      { catalogCardId: AMPHAROS, dexVariantRaw: "Holo", count: 2 }, // 1 -> 2 (increase)
      { catalogCardId: GABITE, dexVariantRaw: "Normal", count: 1 }, // new
    ]);
    const current = map([{ catalogCardId: AMPHAROS, dexVariantRaw: "Holo", count: 1 }]);

    expect(diff(desired, current).fastPath).toBe(true);
  });

  it("is NOT fast-path when anything is removed", () => {
    const desired = map([]);
    const current = map([{ catalogCardId: GABITE, dexVariantRaw: "Normal", count: 1 }]);
    expect(diff(desired, current).fastPath).toBe(false);
  });
});

describe("diff — idempotency (§1.7)", () => {
  it("classifies everything UNCHANGED when desired equals current", () => {
    const entries: PresenceCount[] = [
      { catalogCardId: AMPHAROS, dexVariantRaw: "Holo", count: 1 },
      { catalogCardId: AMPHAROS, dexVariantRaw: "Reverse Holo", count: 1 },
      { catalogCardId: GABITE, dexVariantRaw: "Normal", count: 2 },
    ];
    const d = diff(map(entries), map(entries));

    expect(d.entries.every((e) => e.class === "UNCHANGED")).toBe(true);
    expect(d.migrations).toHaveLength(0);
    expect(d.counts.unchanged).toBe(3);
    expect(d.counts.added + d.counts.removed + d.counts.changed).toBe(0);
  });
});
