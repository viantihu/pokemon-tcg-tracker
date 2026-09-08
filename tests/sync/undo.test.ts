import { describe, it, expect } from "vitest";
import { invertSnapshot, type AppliedSnapshot, type SnapshotCopy } from "@/lib/sync/undo";

/**
 * Undo inversion (sync-ui-spec §B.5): one action reverts the whole most-recent sync. The snapshot
 * records exactly what the apply touched; `invertSnapshot` must produce the total, correct inverse —
 * created copies removed, retired copies restored with placement, variants reverted, queue rolled back.
 */

const AMPHAROS = "me04-29";

function snapCopy(id: string, o: Partial<SnapshotCopy> = {}): SnapshotCopy {
  return {
    id,
    owner_id: "owner-1",
    catalog_card_id: AMPHAROS,
    variant: "holo",
    dex_variant_raw: "Holo",
    presence_group_id: "g1",
    haul_id: null,
    acquired_at: "2026-09-01T00:00:00.000Z",
    role: "shelved",
    binder_id: "b1",
    binder_half: "front",
    color_band: "yellow",
    line_slot_id: null,
    created_at: "2026-09-01T00:00:00.000Z",
    ...o,
  };
}

function baseSnapshot(over: Partial<AppliedSnapshot> = {}): AppliedSnapshot {
  return {
    version: 1,
    createdAt: "2026-09-08T00:00:00.000Z",
    fastPath: false,
    counts: {
      creates: 0,
      retires: 0,
      variantUpdates: 0,
      parks: 0,
      drops: 0,
      promotions: 0,
      dedupeUpdates: 0,
      unchanged: 0,
    },
    createdCopyIds: [],
    retiredCopies: [],
    slotReverts: [],
    variantReverts: [],
    touchedGroupIds: [],
    queue: { parkedIds: [], droppedEntries: [], updatedPrior: [], archivedPrior: [] },
    ...over,
  };
}

describe("invertSnapshot", () => {
  it("removes created copies and restores retired copies with their exact placement", () => {
    const retired = snapCopy("r1", { binder_id: "b2", binder_half: "back", line_slot_id: "s1" });
    const snap = baseSnapshot({
      createdCopyIds: ["new-1", "new-2"],
      retiredCopies: [retired],
      slotReverts: [{ id: "s1", state: "filled", copy_id: "r1" }],
      touchedGroupIds: ["g1", "g2"],
    });

    const ops = invertSnapshot(snap);
    expect(ops.deleteCopyIds).toEqual(["new-1", "new-2"]);
    expect(ops.reinsertCopies).toHaveLength(1);
    // The retired copy comes back byte-for-byte — same id, same placement.
    expect(ops.reinsertCopies[0]).toEqual(retired);
    // Its freed line slot returns to the filled state.
    expect(ops.restoreSlots).toEqual([{ id: "s1", state: "filled", copy_id: "r1" }]);
    expect(ops.resyncGroupIds).toEqual(["g1", "g2"]);
  });

  it("reverts variant migrations to the prior identity", () => {
    const snap = baseSnapshot({
      variantReverts: [
        {
          copyId: "c1",
          variant: "reverse",
          dexVariantRaw: "Reverse Holo",
          presenceGroupId: "gRev",
        },
      ],
    });
    const ops = invertSnapshot(snap);
    expect(ops.revertVariants).toEqual([
      { copyId: "c1", variant: "reverse", dexVariantRaw: "Reverse Holo", presenceGroupId: "gRev" },
    ]);
  });

  it("rolls back every queue mutation (parks deleted, drops re-inserted, in-place restored)", () => {
    const dropped = {
      id: "e-dropped",
      owner_id: "owner-1",
      dex_id: "me6-14",
      dex_set_name: "New Set",
      dex_series: "Mega Evolution",
      dex_number: "14",
      dex_name: "Mystery",
      dex_variant_raw: "Normal",
      quantity: 1,
      locale: "English",
      reason: "UNKNOWN_SET",
      status: "WAITING",
      first_seen_sync: "2026-08-01T00:00:00.000Z",
      last_retry_sync: null,
      retry_count: 3,
      manual_match_id: null,
    };
    const updatedPrior = {
      id: "e-upd",
      status: "WAITING",
      quantity: 1,
      retry_count: 2,
      last_retry_sync: "x",
      reason: "UNKNOWN_CARD",
      manual_match_id: null,
    };
    const archivedPrior = {
      id: "e-arch",
      status: "WAITING",
      quantity: 1,
      retry_count: 1,
      last_retry_sync: null,
      reason: "UNKNOWN_SET",
      manual_match_id: null,
    };

    const snap = baseSnapshot({
      queue: {
        parkedIds: ["e-new-1"],
        droppedEntries: [dropped],
        updatedPrior: [updatedPrior],
        archivedPrior: [archivedPrior],
      },
    });
    const ops = invertSnapshot(snap);
    expect(ops.deleteEntryIds).toEqual(["e-new-1"]);
    expect(ops.reinsertEntries).toEqual([dropped]);
    // Both dedupe-updated and promoted entries are restored to their prior status/values.
    expect(ops.restoreEntries).toEqual([updatedPrior, archivedPrior]);
  });

  it("an empty snapshot inverts to a no-op", () => {
    const ops = invertSnapshot(baseSnapshot());
    expect(ops.deleteCopyIds).toHaveLength(0);
    expect(ops.reinsertCopies).toHaveLength(0);
    expect(ops.restoreSlots).toHaveLength(0);
    expect(ops.revertVariants).toHaveLength(0);
    expect(ops.deleteEntryIds).toHaveLength(0);
    expect(ops.reinsertEntries).toHaveLength(0);
    expect(ops.restoreEntries).toHaveLength(0);
  });
});
