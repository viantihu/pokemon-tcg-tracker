/**
 * Placement-plan grouping/ordering (dev-spec §5 M6 — the phase's real unit test).
 *
 * The grouping is FUNCTIONAL: the plan is worked top-to-bottom in this exact order, mirroring the
 * physical sort. These tests pin the order down —
 *   colour band in rainbow order → basics before non-basics → name A–Z within a sub-group (UIL-076) —
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
    // Display-only (UIL-016); grouping is by band/basic/name and never reads it.
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

  /* UIL-076 — "the cards must be in alphabetical order." Rows inside a sub-group sort by name; the
   * cascade action is still on every row as its chip but no longer decides where the row sits. */
  describe("orders rows inside a sub-group A–Z by name (UIL-076)", () => {
    it("sorts by name even when that contradicts the action order the rows used to follow", () => {
      // Every action in canonical work order, each given a name that runs the OTHER way (Zubat is a
      // PULL, Abra is a BULK). Pre-fix this came back in ACTION_ORDER, i.e. Z→A.
      const namesZtoA = ["Zubat", "Vulpix", "Onix", "Mew", "Growlithe", "Eevee", "Abra"];
      const rows = ACTION_ORDER.map((action, i) =>
        item({ bandKey: "red", action, isBasic: false, name: namesZtoA[i] }),
      );
      const groups = groupPlan(rows, BANDS);
      const red = groups.find((g) => g.bandKey === "red")!;
      const nonbasic = red.subgroups.find((s) => s.kind === "nonbasic")!;
      expect(nonbasic.rows.map((r) => r.name)).toEqual([...namesZtoA].reverse());
      // And the actions came along for the ride, in reverse — proof the sort key really changed.
      expect(nonbasic.rows.map((r) => r.action)).toEqual([...ACTION_ORDER].reverse());
    });

    it("is case- and accent-insensitive, so Flabébé and a lower-cased name file where they belong", () => {
      const rows = [
        item({ bandKey: "green", action: "FRONT", isBasic: true, name: "zubat" }),
        item({ bandKey: "green", action: "FRONT", isBasic: true, name: "Flabébé" }),
        item({ bandKey: "green", action: "FRONT", isBasic: true, name: "Abra" }),
        item({ bandKey: "green", action: "FRONT", isBasic: true, name: "farfetch'd" }),
      ];
      const groups = groupPlan(rows, BANDS);
      const green = groups.find((g) => g.bandKey === "green")!;
      expect(green.subgroups[0].rows.map((r) => r.name)).toEqual([
        "Abra",
        "farfetch'd",
        "Flabébé",
        "zubat",
      ]);
    });

    it("puts a base name before its suffixed form (Charizard, then Charizard ex)", () => {
      const rows = [
        item({ bandKey: "red", action: "SPEC", isBasic: false, name: "Charizard ex" }),
        item({ bandKey: "red", action: "FRONT", isBasic: false, name: "Charmeleon" }),
        item({ bandKey: "red", action: "FRONT", isBasic: false, name: "Charizard" }),
      ];
      const groups = groupPlan(rows, BANDS);
      const red = groups.find((g) => g.bandKey === "red")!;
      expect(red.subgroups[0].rows.map((r) => r.name)).toEqual([
        "Charizard",
        "Charizard ex",
        "Charmeleon",
      ]);
    });

    it("breaks a same-name tie on collector number, numerically (9 before 10, not '10' before '9')", () => {
      const rows = [
        item({ bandKey: "yellow", action: "FRONT", isBasic: true, name: "Pikachu", localId: "10" }),
        item({ bandKey: "yellow", action: "FRONT", isBasic: true, name: "Pikachu", localId: "9" }),
        item({
          bandKey: "yellow",
          action: "FRONT",
          isBasic: true,
          name: "Pikachu",
          localId: "025",
        }),
      ];
      const groups = groupPlan(rows, BANDS);
      const yellow = groups.find((g) => g.bandKey === "yellow")!;
      expect(yellow.subgroups[0].rows.map((r) => r.localId)).toEqual(["9", "10", "025"]);
    });
  });

  it("is a stable sort: identical name and number keep input order", () => {
    // Three copies of the same printing — the order she typed or synced them in is the only signal.
    const rows = [
      item({
        bandKey: "green",
        action: "FRONT",
        incomingId: "first",
        isBasic: true,
        name: "Scyther",
        localId: "123",
      }),
      item({
        bandKey: "green",
        action: "FRONT",
        incomingId: "second",
        isBasic: true,
        name: "Scyther",
        localId: "123",
      }),
      item({
        bandKey: "green",
        action: "FRONT",
        incomingId: "third",
        isBasic: true,
        name: "Scyther",
        localId: "123",
      }),
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
