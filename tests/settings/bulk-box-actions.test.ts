/**
 * UIL-130 — Settings' bulk-box server actions, as written (QA's U15 and U17 on #450). The DOM tests stand the actions
 * in, and the database pins what the ops do; this pins what the actions SEND: Make default is exactly one op (so she
 * is never without a default between two writes), a new box is written with no limit (Karvi: "a new box starts
 * untracked"), and a limit below one is refused in her words before anything is sent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const applyWriteOps = vi.fn();
const views = vi.fn();
vi.mock("@/lib/plan", async (orig) => ({
  ...(await orig<typeof import("@/lib/plan")>()),
  getOwnerContext: async () => ({ db: {}, ownerId: "owner" }),
}));
vi.mock("@/lib/repo", async (orig) => {
  const repo = await orig<typeof import("@/lib/repo")>();
  return {
    ...repo,
    applyWriteOps: (...a: unknown[]) => applyWriteOps(...a),
    bulkUnitRepo: { ...repo.bulkUnitRepo, views: (...a: unknown[]) => views(...a) },
  };
});

const actions = () => import("@/app/(ui)/settings/actions");

beforeEach(() => {
  applyWriteOps.mockReset().mockResolvedValue(undefined);
  views.mockReset().mockResolvedValue([
    { id: "bx1", name: "Bulk box", capacity: null, isDefault: true, held: 54 },
    { id: "bx2", name: "Shoebox", capacity: 60, isDefault: false, held: 50 },
  ]);
});

describe("Make default", () => {
  it("is exactly one op, naming that box", async () => {
    const { setDefaultBulkUnit } = await actions();
    expect(await setDefaultBulkUnit("bx2")).toEqual({ ok: true });
    expect(applyWriteOps).toHaveBeenCalledTimes(1);
    expect(applyWriteOps.mock.calls[0][1]).toEqual({
      ops: [{ op: "set_default_bulk_unit", id: "bx2" }],
    });
  });
});

describe("a box saved", () => {
  it("a new box with no limit is written with no limit", async () => {
    const { saveBulkUnit } = await actions();
    expect(await saveBulkUnit({ id: null, name: " Shoebox ", capacity: null })).toEqual({
      ok: true,
    });
    expect(applyWriteOps.mock.calls[0][1]).toEqual({
      ops: [{ op: "insert_bulk_unit", id: expect.any(String), name: "Shoebox", capacity: null }],
    });
  });

  it("an edit sends its name and limit", async () => {
    const { saveBulkUnit } = await actions();
    await saveBulkUnit({ id: "bx1", name: "Bulk box", capacity: 200 });
    expect(applyWriteOps.mock.calls[0][1]).toEqual({
      ops: [{ op: "update_bulk_unit", id: "bx1", patch: { name: "Bulk box", capacity: 200 } }],
    });
  });

  it.each([0, -3, 1.5])(
    "a limit of %s is refused in her words, and nothing is sent",
    async (capacity) => {
      const { saveBulkUnit } = await actions();
      const res = await saveBulkUnit({ id: null, name: "Shoebox", capacity });
      if (capacity === 1.5) {
        // A part card rounds down to a whole one: 1 is a limit.
        expect(res).toEqual({ ok: true });
        expect(applyWriteOps.mock.calls[0][1].ops[0].capacity).toBe(1);
        return;
      }
      expect(res).toEqual({ ok: false, error: "A card limit is a number of cards, 1 or more." });
      expect(applyWriteOps).not.toHaveBeenCalled();
    },
  );

  it("a box with no name is refused in her words", async () => {
    const { saveBulkUnit } = await actions();
    expect(await saveBulkUnit({ id: null, name: "  ", capacity: null })).toEqual({
      ok: false,
      error: "A box needs a name.",
    });
    expect(applyWriteOps).not.toHaveBeenCalled();
  });
});

describe("delete", () => {
  it("is one op, with where its cards go", async () => {
    const { deleteBulkUnit } = await actions();
    await deleteBulkUnit("bx1", "bx2");
    expect(applyWriteOps.mock.calls[0][1]).toEqual({
      ops: [{ op: "delete_bulk_unit", id: "bx1", move_to: "bx2" }],
    });
    // No override, and nothing read for one.
    expect(views).not.toHaveBeenCalled();
  });

  /**
   * 0037 (Karvi, 2026-10-01: "Users should always be able to override all rules"): her "Delete anyway" into a box
   * without room for the cards. One call: the delete, and the decision that records it, with the rule declared.
   */
  it("delete anyway: one call, the delete and its decision, bulk_box_full declared and recorded", async () => {
    const { deleteBulkUnit } = await actions();
    expect(await deleteBulkUnit("bx1", "bx2", true)).toEqual({ ok: true });
    expect(applyWriteOps).toHaveBeenCalledTimes(1);
    expect(applyWriteOps.mock.calls[0][1]).toEqual({
      ops: [
        { op: "delete_bulk_unit", id: "bx1", move_to: "bx2" },
        {
          op: "insert_decision",
          haul_id: null,
          copy_id: null,
          decision: "bulk-box-deleted-over-limit",
          reason:
            "Deleted Bulk box: its 54 cards went to Shoebox, 44 over its card limit (your call).",
          resolved_by: "user",
          overrides: ["bulk_box_full"],
        },
      ],
      overrides: ["bulk_box_full"],
    });
  });

  it("delete anyway into a box that has room by now: the plain delete, no override", async () => {
    views.mockResolvedValue([
      { id: "bx1", name: "Bulk box", capacity: null, isDefault: true, held: 5 },
      { id: "bx2", name: "Shoebox", capacity: 60, isDefault: false, held: 50 },
    ]);
    const { deleteBulkUnit } = await actions();
    await deleteBulkUnit("bx1", "bx2", true);
    expect(applyWriteOps.mock.calls[0][1]).toEqual({
      ops: [{ op: "delete_bulk_unit", id: "bx1", move_to: "bx2" }],
    });
  });
});
