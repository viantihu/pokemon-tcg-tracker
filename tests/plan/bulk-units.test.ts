/**
 * UIL-130 — where the Haul Plan sends a card to bulk on its own: her default box with room, else her first box with
 * room (in her order), else none, so the database refuses in her words rather than overfill a box. Pure.
 *
 * 0037 — that stays the recommendation (the plan never overfills a box on its own). She can add a card to a full box
 * herself: the words a picker says for it are pinned at the end.
 */
import { describe, expect, it } from "vitest";
import {
  addAnywayLabel,
  addAnywayWarning,
  bulkUnitForRoute,
  bulkUnitViews,
  hasRoom,
  overBy,
  type BulkUnitView,
} from "@/lib/plan/bulk-units";

const box = (over: Partial<BulkUnitView> & { id: string }): BulkUnitView => ({
  name: over.id,
  capacity: null,
  isDefault: false,
  held: 0,
  ...over,
});

describe("bulkUnitForRoute", () => {
  it("her default, when it has room (untracked is never full)", () => {
    expect(bulkUnitForRoute([box({ id: "a" }), box({ id: "b", isDefault: true, held: 500 })])).toBe(
      "b",
    );
  });

  it("her default full: her first box with room, in her order", () => {
    expect(
      bulkUnitForRoute([
        box({ id: "d", isDefault: true, capacity: 2, held: 2 }),
        box({ id: "x", capacity: 1, held: 1 }),
        box({ id: "y", capacity: 5, held: 4 }),
        box({ id: "z" }),
      ]),
    ).toBe("y");
  });

  it("every box full: none", () => {
    expect(bulkUnitForRoute([box({ id: "d", isDefault: true, capacity: 1, held: 1 })])).toBeNull();
    expect(bulkUnitForRoute([])).toBeNull();
  });
});

describe("bulkUnitViews and hasRoom", () => {
  it("counts only bulk copies in each box, in her order", () => {
    const row = (id: string, sort: number, capacity: number | null = null) => ({
      id,
      owner_id: "o",
      name: id,
      sort_order: sort,
      is_default: sort === 0,
      capacity,
      kind: "bulk",
      created_at: `2026-10-01T00:00:0${sort}Z`,
    });
    const views = bulkUnitViews(
      [row("b", 1, 3), row("a", 0)],
      [
        { role: "bulk", bulk_unit_id: "b" },
        { role: "bulk", bulk_unit_id: "b" },
        { role: "block", bulk_unit_id: "b" }, // a spare card in a pocket: home, not held
        { role: "bulk", bulk_unit_id: "a" },
        { role: "shelved", bulk_unit_id: null },
      ],
    );
    expect(views.map((v) => [v.id, v.held, v.isDefault])).toEqual([
      ["a", 1, true],
      ["b", 2, false],
    ]);
    expect(hasRoom(views[1])).toBe(true);
    expect(hasRoom(views[1], 2)).toBe(false);
    expect(hasRoom(views[0], 1000)).toBe(true);
  });
});

describe("0037 · a full box she adds a card to anyway", () => {
  const full = box({ id: "s", name: "Shoebox", capacity: 2, held: 2 });

  it("says how far over its limit the box will be", () => {
    expect(overBy(full)).toBe(1);
    expect(overBy(full, 3)).toBe(3);
    expect(overBy(box({ id: "o", capacity: 2, held: 3 }))).toBe(2);
    expect(overBy(box({ id: "r", capacity: 5, held: 1 }))).toBe(0);
    expect(overBy(box({ id: "u", held: 900 }))).toBe(0);
  });

  it("the warning keeps the full-box reason first; the confirm says Add anyway · N over", () => {
    expect(addAnywayWarning(full)).toBe(
      "Shoebox is full (2 of 2 cards). Pick another box. Or add it anyway: it will be 1 over.",
    );
    expect(addAnywayLabel(full)).toBe("Add anyway · 1 over");
    expect(addAnywayLabel(full, 2)).toBe("Add anyway · 2 over");
  });
});
