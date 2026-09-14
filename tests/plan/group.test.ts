/**
 * Placement-plan grouping/ordering (dev-spec §5 M6 — the phase's real unit test).
 *
 * The grouping is FUNCTIONAL: the plan is worked top-to-bottom in this exact order, mirroring the
 * physical sort. These tests pin the order down —
 *   colour band in rainbow order → basics before non-basics → action order within a sub-group —
 * plus the structural invariants (every band present even at zero cards, empty Pink reserved,
 * unknown bands never dropped, stable tiebreak).
 */

import { describe, expect, it } from "vitest";
import { ACTION_ORDER, groupPlan, type PlanActionKind, type PlanItem } from "@/lib/plan";

const BANDS = [
  "red",
  "orange",
  "yellow",
  "olive",
  "green",
  "dark_blue",
  "light_blue",
  "purple",
  "pink",
  "white",
] as const;

let seq = 0;
function item(over: Partial<PlanItem> & { bandKey: string; action: PlanActionKind }): PlanItem {
  seq += 1;
  return {
    incomingId: over.incomingId ?? `c${seq}`,
    tcgdexId: over.tcgdexId ?? `set-${seq}`,
    name: over.name ?? `Card ${seq}`,
    setId: null,
    localId: null,
    // Display-only (UIL-016); grouping is by band/basic/action and never reads it.
    imageUrl: null,
    variant: "normal",
    stage: over.isBasic ? "Basic" : "Stage1",
    isBasic: over.isBasic ?? false,
    destination: "",
    reason: "",
    needsDecision: false,
    ...over,
  };
}

describe("groupPlan", () => {
  it("returns every band in the supplied rainbow order, empty bands included", () => {
    // A single card in the last band; every earlier band must still appear, in order.
    const groups = groupPlan([item({ bandKey: "white", action: "FRONT", isBasic: true })], BANDS);
    expect(groups.map((g) => g.bandKey)).toEqual(BANDS);
    // The empty Pink band is present and reserved (count 0, no sub-groups).
    const pink = groups.find((g) => g.bandKey === "pink")!;
    expect(pink.count).toBe(0);
    expect(pink.subgroups).toHaveLength(0);
  });

  it("orders bands regardless of input order", () => {
    const groups = groupPlan(
      [
        item({ bandKey: "white", action: "FRONT" }),
        item({ bandKey: "red", action: "FRONT" }),
        item({ bandKey: "purple", action: "FRONT" }),
      ],
      BANDS,
    );
    const nonEmpty = groups.filter((g) => g.count > 0).map((g) => g.bandKey);
    expect(nonEmpty).toEqual(["red", "purple", "white"]);
  });

  it("puts basics before non-basics within a band", () => {
    const groups = groupPlan(
      [
        item({ bandKey: "red", action: "FRONT", isBasic: false, name: "Stage1" }),
        item({ bandKey: "red", action: "FRONT", isBasic: true, name: "Basic" }),
      ],
      BANDS,
    );
    const red = groups.find((g) => g.bandKey === "red")!;
    expect(red.subgroups.map((s) => s.kind)).toEqual(["basic", "nonbasic"]);
    expect(red.subgroups[0].rows[0].name).toBe("Basic");
  });

  it("orders rows inside a sub-group by ACTION_ORDER", () => {
    // Feed every action in reverse, expect the canonical work order back.
    const reversed = [...ACTION_ORDER].reverse();
    const rows = reversed.map((action) => item({ bandKey: "red", action, isBasic: false }));
    const groups = groupPlan(rows, BANDS);
    const red = groups.find((g) => g.bandKey === "red")!;
    const nonbasic = red.subgroups.find((s) => s.kind === "nonbasic")!;
    expect(nonbasic.rows.map((r) => r.action)).toEqual([...ACTION_ORDER]);
  });

  it("is a stable sort: equal actions keep input order", () => {
    const rows = [
      item({ bandKey: "green", action: "FRONT", incomingId: "first", isBasic: true }),
      item({ bandKey: "green", action: "FRONT", incomingId: "second", isBasic: true }),
      item({ bandKey: "green", action: "FRONT", incomingId: "third", isBasic: true }),
    ];
    const groups = groupPlan(rows, BANDS);
    const green = groups.find((g) => g.bandKey === "green")!;
    expect(green.subgroups[0].rows.map((r) => r.incomingId)).toEqual(["first", "second", "third"]);
  });

  it("labels sub-groups per the prototype (White = TRAINERS · ITEMS, colours = STAGE 1 · 2)", () => {
    const groups = groupPlan(
      [
        item({ bandKey: "white", action: "FRONT", isBasic: true }),
        item({ bandKey: "white", action: "FRONT", isBasic: false }),
        item({ bandKey: "olive", action: "NEWLINE", isBasic: false }),
      ],
      BANDS,
    );
    const white = groups.find((g) => g.bandKey === "white")!;
    expect(white.subgroups.map((s) => s.label)).toEqual(["BASICS", "TRAINERS · ITEMS"]);
    const olive = groups.find((g) => g.bandKey === "olive")!;
    expect(olive.subgroups[0].label).toBe("STAGE 1 · 2");
  });

  it("never drops a card whose band is missing from the rainbow order", () => {
    const groups = groupPlan(
      [item({ bandKey: "red", action: "FRONT" }), item({ bandKey: "chartreuse", action: "FRONT" })],
      BANDS,
    );
    // Known bands first in rainbow order, the unknown band appended at the very end.
    expect(groups[groups.length - 1].bandKey).toBe("chartreuse");
    expect(groups.find((g) => g.bandKey === "chartreuse")!.count).toBe(1);
  });

  it("counts every row in a band across its sub-groups", () => {
    const groups = groupPlan(
      [
        item({ bandKey: "red", action: "NEWLINE", isBasic: false }),
        item({ bandKey: "red", action: "FRONT", isBasic: true }),
        item({ bandKey: "red", action: "BULK", isBasic: true }),
      ],
      BANDS,
    );
    const red = groups.find((g) => g.bandKey === "red")!;
    expect(red.count).toBe(3);
    const rowTotal = red.subgroups.reduce((n, s) => n + s.rows.length, 0);
    expect(rowTotal).toBe(3);
  });
});
