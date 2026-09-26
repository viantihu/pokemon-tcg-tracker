/**
 * UIL-117 PR 1 — the line-writing gaps the plan's code map found, each pinned by a test that fails before its fix.
 * The Senior BA logs each under UIL-117. The database check (0028, tests/db/assert-line-slots.test.ts) now
 * refuses a half-written slot outright; these are the writers' own mistakes, fixed at the source so the refusal
 * never has to fire.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyCollectionRemoval, buildCollectionRemovalOps } from "@/lib/coll/remove";
import { buildCollectionRebindOps } from "@/lib/coll/rebind";
import type { WriteOp } from "@/lib/repo/write-ops";
import {
  asOwner,
  asSuperuser,
  freshRpcDb,
  OWNER,
  seedBinders,
  seedCollections,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const SLOT = "20000000-0000-4000-8000-000000000001";
const LINE = "10000000-0000-4000-8000-000000000001";
const released = (ops: WriteOp[]) => ops.find((o) => o.op === "update_slot" && o.id === SLOT);

describe("UIL-117 gap 1 · Collections remove and rebind release a slot the same way every other path does", () => {
  /**
   * `releaseSlotOps` clears the decision she resolved on a slot before it was filled (UIL-078's "stays resolved"
   * marker), so a released-and-refilled slot asks again. Collections' remove and rebind released the slot inline
   * and kept the marker, so a slot they vacated would never ask again.
   */
  const cleared = {
    state: "placeholder",
    copy_id: null,
    resolved_decision_kind: null,
    resolved_decision_choice: null,
    resolved_decision_collection_id: null,
  };

  it("removing a card from a collection clears the slot's resolved decision", () => {
    const ops = buildCollectionRemovalOps({
      collectionId: "col",
      collectionName: "Starters",
      tcgdexId: "sv03-004",
      copies: [{ id: "copy-1", reopenSlotId: SLOT, demoteLineId: LINE } as never],
      destination: { kind: "bulk" },
      destinationLabel: "Bulk box",
      destinationCollectionId: null,
    });
    expect(released(ops)).toMatchObject({ patch: cleared });
  });

  it("rebinding a collection clears it too", () => {
    const ops = buildCollectionRebindOps({
      collectionId: "col",
      collectionName: "Starters",
      fromBinderNames: ["Specialty A"],
      toBinderId: "b2",
      toBinderName: "Specialty B",
      copies: [{ id: "copy-1", reopenSlotId: SLOT, demoteLineId: LINE }],
      stayingNames: [],
    });
    expect(released(ops)).toMatchObject({ patch: cleared });
  });
});

describe("UIL-117 gap 3 · removing a card from a collection never sends it into a back half with no line", () => {
  /**
   * The Collections removal moves every copy of the card in the collection's binder, and its builder writes no line
   * ops: a back-half destination was written as a shelf in the back half with `line_slot_id: null`, the card on no
   * line (STRANDED on the Lines page). The screen greys the back half out, so only a stale or bypassing caller sends
   * one; it is refused before anything is written. UIL-117 PR 2 routes a back-half move from Collections through
   * the line popup instead.
   */
  const SPEC = "b0000000-0000-4000-8000-0000000000c1";
  const GEN = "b0000000-0000-4000-8000-0000000000c2";
  const COL = "a0000000-0000-4000-8000-0000000000c1";
  const COPY = "c0000000-0000-4000-8000-0000000000c1";
  let db: PGlite;
  beforeEach(async () => {
    db = await freshRpcDb();
    await db.exec(`insert into catalog_card (tcgdex_id, name) values ('sv03-004', 'Charmander')`);
    await seedBinders(db, [
      { id: SPEC, type: "specialty", name: "Specialty A" },
      { id: GEN, type: "general", name: "KB-001" },
    ]);
    await seedCollections(db, [
      { id: COL, name: "Starters", targetCatalogCardIds: ["sv03-004"], currentBinderIds: [SPEC] },
    ]);
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
         values ($1, $2, 'sv03-004', 'shelved', $3, 'front', 'red')`,
      [COPY, OWNER, SPEC],
    );
    await asOwner(db);
  });
  afterEach(async () => {
    await db.close();
  });
  const names = {
    binderName: () => "KB-001",
    collectionName: () => null,
    bandDisplay: (k: string) => k,
  };

  it.each([
    ["with no line chosen", {}],
    [
      "even with a line chosen (this path cannot write one)",
      { lineJoin: { mode: "new" as const } },
    ],
  ])("a back-half destination is refused %s, and the card stays where it is", async (_, extra) => {
    await expect(
      applyCollectionRemoval(
        pgliteClient(db),
        {
          collectionId: COL,
          tcgdexId: "sv03-004",
          destination: { kind: "shelf", binderId: GEN, half: "back", band: "red", ...extra },
        },
        names,
      ),
    ).rejects.toThrow(/back half needs a line/);
    await asSuperuser(db);
    const row = (
      await db.query<{ binder_id: string; binder_half: string }>(
        `select binder_id, binder_half from copy where id = $1`,
        [COPY],
      )
    ).rows[0];
    expect(row).toEqual({ binder_id: SPEC, binder_half: "front" });
  });
});
