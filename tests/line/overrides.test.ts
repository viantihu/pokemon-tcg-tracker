/**
 * 0037 — the one helper every writer uses for her line-rule overrides (lib/line/overrides.ts): a write declares the
 * rules her line choice put a card past, and each writer records them on its own decision. A full bulk box or binder
 * section is NOT an override: nothing here declares it. Pure; the refusals against Postgres are
 * tests/db/override-full-box.test.ts and tests/db/section-full.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { WriteOp } from "@/lib/repo";
import { lineRuleNote, recordOverrides } from "@/lib/line/overrides";

const decision: WriteOp = {
  op: "insert_decision",
  haul_id: null,
  copy_id: "c1",
  decision: "placement-move",
  reason: "Moved.",
  resolved_by: "user",
};

describe("recordOverrides", () => {
  it("stamps a decision, once per rule; any other op, or no rule, comes back as it was", () => {
    expect(recordOverrides(decision, ["line_fit"])).toEqual({
      ...decision,
      overrides: ["line_fit"],
    });
    expect(recordOverrides({ ...decision, overrides: ["line_fit"] }, ["line_fit"])).toEqual({
      ...decision,
      overrides: ["line_fit"],
    });
    expect(recordOverrides(decision, [])).toBe(decision);
    const slot: WriteOp = { op: "update_slot", id: "s", patch: { copy_id: null } };
    expect(recordOverrides(slot, ["line_fit"])).toBe(slot);
  });
});

describe("lineRuleNote", () => {
  it("names the line rule she put the card past, and nothing for none", () => {
    expect(lineRuleNote(["line_min_stages"])).toBe(" A line of one card (your call).");
    expect(lineRuleNote(["line_fit"])).toBe(" Put in this line anyway (your call).");
    expect(lineRuleNote([])).toBe("");
  });

  it("a full bulk box is not a rule she can put a card past", () => {
    expect(lineRuleNote(["bulk_box_full"])).toBe("");
  });
});
