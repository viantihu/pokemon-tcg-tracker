/**
 * 0037 — the one helper every writer uses for her overrides (lib/line/overrides.ts). Karvi, 2026-10-01/02: "Users
 * should always be able to override all rules." A write declares the rules from every place it sends a card, and each
 * writer records them on its own decision. Pure; the real writers against Postgres are tests/db/override-full-box.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { WriteOp } from "@/lib/repo";
import {
  fillerReturnedDecision,
  lineChoiceDestinations,
  overLimitNote,
  overridesFor,
  recordOverrides,
  returnDestination,
} from "@/lib/line/overrides";

const decision: WriteOp = {
  op: "insert_decision",
  haul_id: null,
  copy_id: "c1",
  decision: "placement-move",
  reason: "Moved.",
  resolved_by: "user",
};

describe("overridesFor", () => {
  it("a full box she picked knowingly is bulk_box_full; a box picked plainly, or no box, is none", () => {
    expect(overridesFor([{ kind: "bulk", unitId: "b", overFull: true }])).toEqual([
      "bulk_box_full",
    ]);
    expect(overridesFor([{ kind: "bulk", unitId: "b" }])).toEqual([]);
    expect(overridesFor([{ kind: "bulk" }, null, undefined])).toEqual([]);
    expect(
      overridesFor([
        { kind: "shelf", binderId: "b1", half: "front", band: "red" },
        { kind: "bulk", unitId: "b", overFull: true },
      ]),
    ).toEqual(["bulk_box_full"]);
  });
});

describe("recordOverrides", () => {
  it("stamps a decision, once per rule; any other op, or no rule, comes back as it was", () => {
    expect(recordOverrides(decision, ["bulk_box_full"])).toEqual({
      ...decision,
      overrides: ["bulk_box_full"],
    });
    expect(
      recordOverrides({ ...decision, overrides: ["bulk_box_full"] }, ["bulk_box_full"]),
    ).toEqual({ ...decision, overrides: ["bulk_box_full"] });
    expect(recordOverrides(decision, [])).toBe(decision);
    const slot: WriteOp = { op: "update_slot", id: "s", patch: { copy_id: null } };
    expect(recordOverrides(slot, ["bulk_box_full"])).toBe(slot);
  });
});

describe("the places a line choice sends a card", () => {
  it("a replace: the card coming out, and the spare cards of the line it joins", () => {
    expect(
      lineChoiceDestinations({
        mode: "replace",
        lineId: "L1",
        slotId: "S1",
        keep: false,
        outgoing: { kind: "shelf", binderId: "b1", half: "back", band: "red" },
        outgoingLine: {
          mode: "join",
          lineId: "L2",
          slotId: "S2",
          returnBoxes: { spare: "full" },
          returnOverFull: ["spare"],
        },
      }),
    ).toEqual([
      { kind: "shelf", binderId: "b1", half: "back", band: "red" },
      { kind: "bulk", unitId: "full", overFull: true },
    ]);
  });

  it("a join: only the spare cards she sends into a full box knowingly", () => {
    expect(
      lineChoiceDestinations({
        mode: "join",
        lineId: "L1",
        slotId: "S1",
        returnBoxes: { a: "roomy", b: "full" },
        returnOverFull: ["b"],
      }),
    ).toEqual([{ kind: "bulk", unitId: "full", overFull: true }]);
  });

  it("a keep: the kept card's own place; a start, or none: nothing", () => {
    expect(
      lineChoiceDestinations({
        mode: "replace",
        lineId: "L1",
        slotId: "S1",
        keep: true,
        incoming: { kind: "bulk", unitId: "b", overFull: true },
      }),
    ).toEqual([{ kind: "bulk", unitId: "b", overFull: true }]);
    expect(
      lineChoiceDestinations({
        mode: "start",
        binderId: "b1",
        band: "red",
        pulls: [],
        stages: {},
      }),
    ).toEqual([]);
    expect(lineChoiceDestinations(undefined)).toEqual([]);
  });
});

describe("a spare card going back", () => {
  it("names the box she picked, and overFull only when she said Add anyway", () => {
    expect(returnDestination("a", { returnBoxes: { a: "b" } })).toEqual({
      kind: "bulk",
      unitId: "b",
    });
    expect(returnDestination("a", { returnBoxes: { a: "b" }, returnOverFull: ["a"] })).toEqual({
      kind: "bulk",
      unitId: "b",
      overFull: true,
    });
    expect(returnDestination("a", {})).toEqual({ kind: "bulk" });
  });

  it("its decision names the box and that it is over its limit, as hers", () => {
    expect(
      fillerReturnedDecision("a", "Shoebox", { kind: "bulk", unitId: "b", overFull: true }),
    ).toEqual({
      op: "insert_decision",
      haul_id: null,
      copy_id: "a",
      decision: "filler-returned",
      reason: "Back to bulk from its pocket, into Shoebox, over its card limit (your call).",
      resolved_by: "user",
      overrides: ["bulk_box_full"],
    });
    expect(overLimitNote([{ kind: "bulk", unitId: "b", overFull: true }])).toBe(
      " Over its card limit (your call).",
    );
    expect(overLimitNote([{ kind: "bulk", unitId: "b" }])).toBe("");
  });
});
