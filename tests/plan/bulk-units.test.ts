/**
 * UIL-130 — where the Haul Plan sends a card to bulk on its own: her default box with room, else her first box with
 * room (in her order), else none, so the database refuses in her words rather than overfill a box. Pure.
 *
 * A full box takes no more cards, however she got there: there is no "add anyway" (the words a picker says for a full
 * box are pinned at the end).
 */
import { describe, expect, it } from "vitest";
import {
  bulkUnitForRoute,
  bulkUnitViews,
  hasRoom,
  fullBoxReason,
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

describe("a full box takes no more cards", () => {
  const full = box({ id: "s", name: "Shoebox", capacity: 2, held: 2 });

  it("has no room, and says why in her words", () => {
    expect(hasRoom(full)).toBe(false);
    expect(fullBoxReason(full)).toBe("Shoebox is full (2 of 2 cards). Pick another box.");
  });

  it("an untracked box, or one with room, is never refused", () => {
    expect(hasRoom(box({ id: "u", held: 900 }))).toBe(true);
    expect(hasRoom(box({ id: "r", capacity: 5, held: 4 }))).toBe(true);
  });
});
