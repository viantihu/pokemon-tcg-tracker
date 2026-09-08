import { describe, it, expect } from "vitest";
import {
  buildDesiredPresence,
  deriveVariantFlag,
  reconcile,
  type CopySnapshot,
  type CurrentGroup,
  type ResolvedRow,
} from "@/lib/sync/reconcile";

/**
 * PresenceGroup count-delta reconciliation (sync-architecture §1.4–§1.7). The headline acceptance
 * test is the phantom-variant fix trace (Deliverable 2), reproduced exactly.
 *
 * Real, verified cards only: me04-29 Ampharos (owned Holo + Reverse Holo in her export), sv10-103
 * Cynthia's Gabite (Destined Rivals). No fabricated numbers, no real Dex CSV.
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

describe("deriveVariantFlag (§1.4 — nine Dex variants → five app flags)", () => {
  it("maps subtypes to their base flag and keeps identity in the raw string", () => {
    expect(deriveVariantFlag("Normal")).toBe("normal");
    expect(deriveVariantFlag("Holo")).toBe("holo");
    expect(deriveVariantFlag("Reverse Holo")).toBe("reverse");
    expect(deriveVariantFlag("Poké Ball Holo")).toBe("reverse");
    expect(deriveVariantFlag("Friend Ball Holo")).toBe("reverse");
    expect(deriveVariantFlag("Quick Ball Holo")).toBe("reverse");
    expect(deriveVariantFlag("Cosmos Holo")).toBe("holo");
    // Stamped-promo overlays have no flag: base display, non-destructive (raw string kept).
    expect(deriveVariantFlag("Trick or Trade 2023")).toBe("normal");
    expect(deriveVariantFlag("Expansion Stamp")).toBe("normal");
  });
});

describe("scope filter FIRST (§1.2) — wishlist rows never import as owned", () => {
  it("drops standard_v2 rows before building desired presence", () => {
    const rows = [
      row(GABITE, "Normal", 1, "collection"),
      row(AMPHAROS, "Holo", 1, "standard_v2"), // Okubo Wishlist etc. — must NOT become owned
    ];
    const { desired } = buildDesiredPresence(rows);
    // Only the collection row survives.
    expect([...desired.values()].map((v) => v.catalogCardId)).toEqual([GABITE]);
  });

  it("never creates a copy for a wishlist row", () => {
    const rows = [row(GABITE, "Normal", 1, "collection"), row(AMPHAROS, "Holo", 1, "standard_v2")];
    const plan = reconcile({ rows, current: [], clock });
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0].catalogCardId).toBe(GABITE);
  });
});

describe("phantom-variant fix trace (Deliverable 2) — reproduces EXACTLY", () => {
  it("drops the phantom Normal and leaves Holo + Reverse Holo placement untouched", () => {
    // BEFORE: Holo in a line slot, Reverse Holo shelved, phantom Normal unplaced.
    const current: CurrentGroup[] = [
      group(AMPHAROS, "Holo", [
        copy("A101", {
          role: "shelved",
          binderId: "b1",
          binderHalf: "back",
          lineSlotId: "slot-amp",
        }),
      ]),
      group(AMPHAROS, "Reverse Holo", [
        copy("A102", { role: "shelved", binderId: "b2", binderHalf: "back" }),
      ]),
      group(AMPHAROS, "Normal", [copy("A103")]), // unplaced phantom
    ];
    // She deleted the stray Normal in Dex and re-exported: only Holo + Reverse Holo remain.
    const rows = [row(AMPHAROS, "Holo", 1), row(AMPHAROS, "Reverse Holo", 1)];

    const plan = reconcile({ rows, current, clock });

    // Phantom retired; it was unplaced, so the removal releases nothing.
    expect(plan.retires).toEqual([
      {
        kind: "retire",
        copyId: "A103",
        catalogCardId: AMPHAROS,
        dexVariantRaw: "Normal",
        consequence: "unplaced-removed",
        needsReview: false,
      },
    ]);
    // Nothing added, nothing migrated, and the two real copies are UNCHANGED (untouched).
    expect(plan.creates).toHaveLength(0);
    expect(plan.variantUpdates).toHaveLength(0);
    expect(plan.unchanged).toBe(2);
    const touched = new Set(plan.retires.map((r) => r.copyId));
    expect(touched.has("A101")).toBe(false);
    expect(touched.has("A102")).toBe(false);
  });
});

describe("variant-migration carries placement (§1.6 counter-example)", () => {
  it("a Normal→Reverse Holo change updates the copy in place, keeping its line slot", () => {
    const current = [
      group(AMPHAROS, "Normal", [
        copy("A201", { binderId: "b1", binderHalf: "back", lineSlotId: "slot-amp" }),
      ]),
    ];
    // Dex now reports the same card as Reverse Holo (not deleted — changed).
    const rows = [row(AMPHAROS, "Reverse Holo", 1)];

    const plan = reconcile({ rows, current, clock });

    expect(plan.variantUpdates).toEqual([
      {
        kind: "variant_update",
        copyId: "A201",
        catalogCardId: AMPHAROS,
        fromVariantRaw: "Normal",
        toVariantRaw: "Reverse Holo",
        toVariant: "reverse",
        placementPreserved: true,
      },
    ]);
    expect(plan.retires).toHaveLength(0);
    expect(plan.creates).toHaveLength(0);
  });
});

describe("removal rule (§1.6) — least-committed retired first, consequences correct", () => {
  it("retires bulk + shelved before the line-slot holder on a 3→1 shrink", () => {
    const current = [
      group(AMPHAROS, "Holo", [
        copy("c-bulk", { role: "bulk" }),
        copy("c-shelved", { role: "shelved", binderId: "b1", binderHalf: "back" }),
        copy("c-line", {
          role: "shelved",
          binderId: "b1",
          binderHalf: "back",
          lineSlotId: "slot-amp",
        }),
      ]),
    ];
    const plan = reconcile({ rows: [row(AMPHAROS, "Holo", 1)], current, clock });

    const retired = plan.retires.map((r) => r.copyId).sort();
    expect(retired).toEqual(["c-bulk", "c-shelved"]);
    const byId = Object.fromEntries(plan.retires.map((r) => [r.copyId, r.consequence]));
    expect(byId["c-bulk"]).toBe("bulk-removed");
    expect(byId["c-shelved"]).toBe("shelved-cleared");
    // The line-slot holder survives.
    expect(plan.retires.find((r) => r.copyId === "c-line")).toBeUndefined();
  });

  it("frees a line slot when a line-slot copy must be retired", () => {
    const current = [
      group(AMPHAROS, "Holo", [
        copy("c-line", { binderId: "b1", binderHalf: "back", lineSlotId: "slot-amp" }),
      ]),
    ];
    const plan = reconcile({ rows: [], current, clock });
    expect(plan.retires[0]).toMatchObject({
      copyId: "c-line",
      consequence: "line-slot-freed",
      needsReview: false,
    });
  });

  it("flags a repurposed binder block for review and never auto-reverts it", () => {
    const current = [
      group(AMPHAROS, "Holo", [
        copy("c-block", { role: "block", binderId: "b1", binderHalf: "back" }),
      ]),
    ];
    const plan = reconcile({ rows: [], current, clock });
    expect(plan.retires[0]).toMatchObject({
      copyId: "c-block",
      consequence: "block-review",
      needsReview: true,
    });
  });

  it("tiebreaks equally-committed copies by retiring the most recently created first (§1.6)", () => {
    const current = [
      group(AMPHAROS, "Holo", [
        copy("c-old", { role: "bulk", createdAt: "2026-01-01T00:00:00.000Z" }),
        copy("c-new", { role: "bulk", createdAt: "2026-06-01T00:00:00.000Z" }),
      ]),
    ];
    const plan = reconcile({ rows: [row(AMPHAROS, "Holo", 1)], current, clock });
    expect(plan.retires.map((r) => r.copyId)).toEqual(["c-new"]);
  });
});

describe("idempotency (§1.7) — re-importing the same CSV twice is a no-op", () => {
  const rows = [row(GABITE, "Normal", 2), row(AMPHAROS, "Holo", 1)];
  const current = [
    group(GABITE, "Normal", [copy("g1"), copy("g2")]),
    group(AMPHAROS, "Holo", [copy("a1")]),
  ];

  it("produces an empty plan when current already equals desired", () => {
    const plan = reconcile({ rows, current, clock });
    expect(plan.creates).toHaveLength(0);
    expect(plan.retires).toHaveLength(0);
    expect(plan.variantUpdates).toHaveLength(0);
    expect(plan.unchanged).toBe(2);
    expect(plan.fastPath).toBe(true);
  });

  it("is deterministic across repeated runs", () => {
    const a = reconcile({ rows, current, clock });
    const b = reconcile({ rows, current, clock });
    expect(b).toEqual(a);
  });
});
