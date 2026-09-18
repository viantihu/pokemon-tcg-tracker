/**
 * `strandedSections` (UIL-050) — "Shelved is greater than capacity. This is physically impossible."
 *
 * Capacity comes from `binderSplit` (pages/pockets/divider); shelved counts come from the `copy`
 * table. Pure comparison, no DB — the DB-touching half (reading what's actually shelved) is
 * `lib/binders/save.ts`'s `readShelvedBySection`, covered separately against real Postgres.
 */
import { describe, expect, it } from "vitest";
import { binderSplit, strandedSections, strandedSectionsMessage } from "@/lib/surfaces";

describe("strandedSections", () => {
  it("flags nothing when the new size still fits everything shelved", () => {
    const split = binderSplit({
      type: "general",
      pages: 40,
      pocketsPerPage: 9,
      backHalfStartPage: 21,
    });
    const blocked = strandedSections(split, { front: 100, back: 50, single: 0 });
    expect(blocked).toEqual([]);
  });

  it("flags the back half when shrinking pages leaves fewer pockets than shelved there", () => {
    // Back = pages 21-40 = 20 pages x 9 = 180 pockets today; shrinking to 25 pages leaves back = 5x9=45.
    const split = binderSplit({
      type: "general",
      pages: 25,
      pocketsPerPage: 9,
      backHalfStartPage: 21,
    });
    const blocked = strandedSections(split, { front: 50, back: 100, single: 0 });
    expect(blocked).toEqual([{ half: "back", shelvedCount: 100, newCapacity: 45 }]);
  });

  it("UIL-001's NO BACK HALF trap: clearing the divider collapses back capacity to 0", () => {
    const split = binderSplit({
      type: "general",
      pages: 40,
      pocketsPerPage: 9,
      backHalfStartPage: null,
    });
    const blocked = strandedSections(split, { front: 0, back: 12, single: 0 });
    expect(blocked).toEqual([{ half: "back", shelvedCount: 12, newCapacity: 0 }]);
  });

  it("moving the divider forward can strand the front half instead", () => {
    // Divider moves from page 21 to page 5: front shrinks from 20x9=180 to 4x9=36.
    const split = binderSplit({
      type: "general",
      pages: 40,
      pocketsPerPage: 9,
      backHalfStartPage: 5,
    });
    const blocked = strandedSections(split, { front: 60, back: 0, single: 0 });
    expect(blocked).toEqual([{ half: "front", shelvedCount: 60, newCapacity: 36 }]);
  });

  it("can flag both halves at once", () => {
    const split = binderSplit({
      type: "general",
      pages: 4,
      pocketsPerPage: 9,
      backHalfStartPage: 3,
    });
    const blocked = strandedSections(split, { front: 50, back: 50, single: 0 });
    expect(blocked.map((b) => b.half).sort()).toEqual(["back", "front"]);
  });

  it("a specialty binder's shrink is checked against its one section", () => {
    const split = binderSplit({
      type: "specialty",
      pages: 10,
      pocketsPerPage: 9,
      backHalfStartPage: null,
    });
    const blocked = strandedSections(split, { front: 0, back: 0, single: 100 });
    expect(blocked).toEqual([{ half: "single", shelvedCount: 100, newCapacity: 90 }]);
  });

  it("boundary: exactly full is not stranded, one more is", () => {
    const split = binderSplit({
      type: "general",
      pages: 10,
      pocketsPerPage: 9,
      backHalfStartPage: 6,
    });
    // front = 5 pages x 9 = 45.
    expect(strandedSections(split, { front: 45, back: 0, single: 0 })).toEqual([]);
    expect(strandedSections(split, { front: 46, back: 0, single: 0 })).toEqual([
      { half: "front", shelvedCount: 46, newCapacity: 45 },
    ]);
  });
});

describe("strandedSectionsMessage", () => {
  it("names the section, the new capacity, and the count already shelved", () => {
    const msg = strandedSectionsMessage([{ half: "back", shelvedCount: 12, newCapacity: 0 }]);
    expect(msg).toContain("The back half would hold 0 pockets");
    expect(msg).toContain("12 cards");
    expect(msg).toContain("are already shelved there");
  });

  it("uses singular phrasing for exactly one card and one pocket", () => {
    const msg = strandedSectionsMessage([{ half: "front", shelvedCount: 1, newCapacity: 1 }]);
    expect(msg).toContain("1 pocket,");
    expect(msg).toContain("1 card is already shelved there");
  });

  it("refers to a specialty binder's single section as 'It', not 'the single half'", () => {
    const msg = strandedSectionsMessage([{ half: "single", shelvedCount: 5, newCapacity: 2 }]);
    expect(
      msg.startsWith(
        "That change would leave fewer pockets than cards already shelved: It would hold",
      ),
    ).toBe(true);
  });
});
