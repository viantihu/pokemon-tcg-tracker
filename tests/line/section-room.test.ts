/**
 * A binder section at its limit takes no more cards (lib/line/section-room.ts). Pure: the shared definition the Move
 * panel greys its chips by and the writers refuse by. What takes a pocket, what does not, and her words.
 */
import { describe, expect, it } from "vitest";
import type { WriteOp } from "@/lib/repo";
import {
  fullSectionReason,
  isSectionFull,
  sectionDemand,
  sectionName,
  sectionOfDestination,
  sectionRooms,
  sectionShortfalls,
  shortfallMessage,
  type CopyPlace,
  type SectionRoom,
} from "@/lib/line/section-room";

const move = (id: string, patch: Extract<WriteOp, { op: "update_copy" }>["patch"]): WriteOp => ({
  op: "update_copy",
  id,
  patch,
});
const shelf = (binder: string, half: string | null, extra = {}) =>
  ({ role: "shelved", binder_id: binder, binder_half: half, color_band: "red", ...extra }) as const;
const rooms = (...r: [string, SectionRoom["half"], number][]): SectionRoom[] =>
  r.map(([binderId, half, free]) => ({ binderId, half, free }));
const none = new Map<string, CopyPlace>();

describe("which section a destination lands in", () => {
  it("a shelf is its half, a collection its binder's single section, a block the back half, bulk none", () => {
    expect(sectionOfDestination({ kind: "shelf", binderId: "b", half: "front" })).toEqual({
      binderId: "b",
      half: "front",
    });
    expect(sectionOfDestination({ kind: "collection", binderId: "s" })).toEqual({
      binderId: "s",
      half: "single",
    });
    expect(sectionOfDestination({ kind: "block", binderId: "b" })).toEqual({
      binderId: "b",
      half: "back",
    });
    expect(sectionOfDestination({ kind: "bulk" })).toBeNull();
  });
});

describe("full means no free pockets; unknown is not full", () => {
  const r = rooms(["b", "front", 0], ["b", "back", 3]);
  it("reads the room", () => {
    expect(isSectionFull(r, "b", "front")).toBe(true);
    expect(isSectionFull(r, "b", "back")).toBe(false);
    expect(isSectionFull(r, "other", "front")).toBe(false);
    expect(isSectionFull(undefined, "b", "front")).toBe(false);
  });

  it("the view's rows, with nulls coalesced", () => {
    expect(
      sectionRooms([
        { binder_id: "b", half: "front", free_pockets: null },
        { binder_id: null, half: "back", free_pockets: 4 },
      ]),
    ).toEqual([{ binderId: "b", half: "front", free: 0 }]);
  });
});

describe("what takes a pocket", () => {
  it("a card entering a section it is not in", () => {
    const d = sectionDemand([move("c", shelf("b", "front"))], none);
    expect([...d.values()]).toEqual([{ binderId: "b", half: "front", need: 1 }]);
  });

  it("a card already shelved in that section takes none (a re-band)", () => {
    const here = new Map<string, CopyPlace>([
      ["c", { role: "shelved", binder_id: "b", binder_half: "front" }],
    ]);
    expect(sectionDemand([move("c", shelf("b", "front"))], here).size).toBe(0);
  });

  it("a card in the OTHER half, another binder, bulk or the haul is entering", () => {
    for (const now of [
      { role: "shelved", binder_id: "b", binder_half: "back" },
      { role: "shelved", binder_id: "x", binder_half: "front" },
      { role: "bulk", binder_id: null, binder_half: null },
      { role: "haul", binder_id: null, binder_half: null },
    ]) {
      const d = sectionDemand([move("c", shelf("b", "front"))], new Map([["c", now]]));
      expect([...d.values()][0]?.need).toBe(1);
    }
  });

  it("a specialty binder's shelved card (no half) is its single section", () => {
    const d = sectionDemand([move("c", shelf("s", null))], none);
    expect([...d.values()]).toEqual([{ binderId: "s", half: "single", need: 1 }]);
  });

  it("a card filling a slot that already exists takes the pocket the slot reserved", () => {
    expect(
      sectionDemand([move("c", shelf("b", "back", { line_slot_id: "slot-1" }))], none).size,
    ).toBe(0);
  });

  it("a new line: the card, plus a pocket for each placeholder stage and each block", () => {
    const ops: WriteOp[] = [
      {
        op: "insert_line",
        id: "L",
        root_dex_id: 1,
        color_band: "red",
        binder_id: "b",
        half: "back",
      },
      {
        op: "insert_slot",
        id: "s0",
        line_id: "L",
        stage_index: 0,
        stage: "Basic",
        state: "filled",
        copy_id: "c",
        target_catalog_card_id: null,
        note: null,
      },
      {
        op: "insert_slot",
        id: "s1",
        line_id: "L",
        stage_index: 1,
        stage: "Stage1",
        state: "placeholder",
        copy_id: null,
        target_catalog_card_id: null,
        note: null,
      },
      {
        op: "insert_binder_block",
        id: "bl",
        binder_id: "b",
        half: "back",
        pocket_count: 1,
        purpose: "line-terminated",
        material: "basicEnergy",
        copy_id: null,
        line_id: "L",
      },
      move("c", shelf("b", "back", { line_slot_id: "s0" })),
    ];
    expect([...sectionDemand(ops, none).values()]).toEqual([
      { binderId: "b", half: "back", need: 3 },
    ]);
  });

  it("bulk, a collection-less move out of a binder, and a haul copy take none", () => {
    expect(sectionDemand([move("c", { role: "bulk", binder_id: null })], none).size).toBe(0);
  });
});

describe("the shortfall, and her words for it", () => {
  const ops = [move("c", shelf("b", "front"))];
  const name = (id: string) => (id === "b" ? "KB-001" : "Specialty A");

  it("refuses a full section, allows one with room, and skips a section the rooms do not name", () => {
    expect(sectionShortfalls(ops, none, rooms(["b", "front", 0]))).toEqual([
      { binderId: "b", half: "front", need: 1, free: 0 },
    ]);
    expect(sectionShortfalls(ops, none, rooms(["b", "front", 1]))).toEqual([]);
    expect(sectionShortfalls(ops, none, rooms(["other", "front", 0]))).toEqual([]);
  });

  it("names the section and what she can do", () => {
    expect(fullSectionReason("KB-001", "front")).toBe(
      "KB-001's front half is full. Pick another place, or add pages in Settings.",
    );
    expect(fullSectionReason("Specialty A", "single")).toBe(
      "Specialty A is full. Pick another place, or add pages in Settings.",
    );
    expect(sectionName("KB-001", "back")).toBe("KB-001's back half");
  });

  it("a write that needs more than is free says how many", () => {
    expect(shortfallMessage([{ binderId: "b", half: "back", need: 3, free: 1 }], name)).toBe(
      "KB-001's back half has room for 1 more pocket, and this needs 3. Pick another place, or add pages in Settings.",
    );
    expect(shortfallMessage([{ binderId: "b", half: "back", need: 3, free: 0 }], name)).toBe(
      "KB-001's back half is full. Pick another place, or add pages in Settings.",
    );
  });
});
