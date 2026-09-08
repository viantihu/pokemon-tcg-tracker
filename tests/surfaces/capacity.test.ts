/**
 * Capacity review classification (dev-spec §5 M8; system-design §7E — "which binder has room for a
 * new Fire line"). Pure test over the `binder_section` helpers.
 */

import { describe, expect, it } from "vitest";
import {
  backHalvesWithRoom,
  fullness,
  hasRoomForLine,
  usedFraction,
  usedPockets,
  type SectionView,
} from "@/lib/surfaces";

function section(over: Partial<SectionView>): SectionView {
  return {
    binderId: "b1",
    half: "back",
    capacity: 90,
    shelvedCount: 0,
    blockPockets: 0,
    openPlaceholders: 0,
    freePockets: 90,
    ...over,
  };
}

describe("fullness", () => {
  it("classifies empty / ok / near / full", () => {
    expect(fullness(section({ capacity: 0, freePockets: 0 }))).toBe("empty");
    expect(fullness(section({ shelvedCount: 10, freePockets: 80 }))).toBe("ok");
    expect(
      fullness(section({ capacity: 90, shelvedCount: 80, freePockets: 10 })), // 88% used
    ).toBe("near");
    expect(fullness(section({ shelvedCount: 90, freePockets: 0 }))).toBe("full");
  });

  it("counts shelved + blocks + placeholders as consumed", () => {
    const s = section({ shelvedCount: 10, blockPockets: 5, openPlaceholders: 3, freePockets: 72 });
    expect(usedPockets(s)).toBe(18);
    expect(usedFraction(s)).toBeCloseTo(18 / 90);
  });
});

describe("room for a new line", () => {
  it("only back halves with enough free pockets qualify", () => {
    expect(hasRoomForLine(section({ half: "back", freePockets: 9 }))).toBe(true);
    expect(hasRoomForLine(section({ half: "back", freePockets: 2 }))).toBe(false);
    expect(hasRoomForLine(section({ half: "front", freePockets: 40 }))).toBe(false);
  });

  it("ranks qualifying back halves by free space, most first", () => {
    const sections = [
      section({ binderId: "b1", half: "back", freePockets: 12 }),
      section({ binderId: "b2", half: "back", freePockets: 40 }),
      section({ binderId: "b3", half: "back", freePockets: 1 }), // too full
      section({ binderId: "b4", half: "front", freePockets: 99 }), // front never seats a line
    ];
    expect(backHalvesWithRoom(sections).map((s) => s.binderId)).toEqual(["b2", "b1"]);
  });
});
