/**
 * End-to-end UIL-050 check against real Postgres: `readShelvedBySection` (lib/binders/save.ts) reads
 * what a binder actually holds, and `strandedSections` (lib/surfaces/capacity.ts) compares that
 * against the resize she is about to save. Together these are exactly what `saveBinder`
 * (app/(ui)/settings/actions.ts) calls before writing a shrink/divider-move that would leave fewer
 * pockets than cards already shelved.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { readShelvedBySection } from "@/lib/binders/save";
import { binderSplit, strandedSections } from "@/lib/surfaces";
import { asOwner, freshRpcDb, OWNER, seedCatalogCards } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const BINDER = "b0000000-0000-0000-0000-000000000031";

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedCatalogCards(db, ["cardA", "cardB", "cardC"]);
});
afterEach(async () => {
  await db.close();
});

async function seedBinder(pages: number, pocketsPerPage: number, backHalfStartPage: number | null) {
  await db.query(
    `insert into binder (id, owner_id, name, type, pages, pockets_per_page, back_half_start_page)
     values ($1, $2, 'Binder A', 'general', $3, $4, $5)`,
    [BINDER, OWNER, pages, pocketsPerPage, backHalfStartPage],
  );
}

async function shelve(id: string, cardId: string, half: "front" | "back") {
  await db.query(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half)
     values ($1, $2, $3, 'shelved', $4, $5)`,
    [id, OWNER, cardId, BINDER, half],
  );
}

async function seedSpecialtyBinder(id: string, pages: number, pocketsPerPage: number) {
  await db.query(
    `insert into binder (id, owner_id, name, type, pages, pockets_per_page)
     values ($1, $2, 'Specialty A', 'specialty', $3, $4)`,
    [id, OWNER, pages, pocketsPerPage],
  );
}

async function shelveNoHalf(id: string, cardId: string, binderId: string) {
  await db.query(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half)
     values ($1, $2, $3, 'shelved', $4, null)`,
    [id, OWNER, cardId, binderId],
  );
}

describe("readShelvedBySection + strandedSections against real Postgres", () => {
  it("blocks shrinking pages out from under cards already shelved in the back half", async () => {
    // 40 pages x 9, divider at 21 -> back = 20 pages x 9 = 180 pockets today.
    await seedBinder(40, 9, 21);
    await shelve("c0000000-0000-0000-0000-000000000101", "cardA", "back");
    await shelve("c0000000-0000-0000-0000-000000000102", "cardB", "back");
    await asOwner(db);

    // Proposed edit: shrink to 22 pages -> back = 1 page x 9 = 9 pockets. Still enough for 2 cards.
    const roomySplit = binderSplit({
      type: "general",
      pages: 22,
      pocketsPerPage: 9,
      backHalfStartPage: 21,
    });
    const shelved = await readShelvedBySection(pgliteClient(db), BINDER);
    expect(shelved).toEqual({ front: 0, back: 2, single: 0 });
    expect(strandedSections(roomySplit, shelved)).toEqual([]);

    // Proposed edit: shrink to 20 pages -> divider at 21 is past the last page, back = 0 pockets. Blocks.
    const tooSmallSplit = binderSplit({
      type: "general",
      pages: 20,
      pocketsPerPage: 9,
      backHalfStartPage: 21,
    });
    expect(strandedSections(tooSmallSplit, shelved)).toEqual([
      { half: "back", shelvedCount: 2, newCapacity: 0 },
    ]);
  });

  it("blocks clearing the divider (UIL-001's NO BACK HALF trap) when the back half isn't empty", async () => {
    await seedBinder(40, 9, 21);
    await shelve("c0000000-0000-0000-0000-000000000103", "cardC", "back");
    await asOwner(db);

    const shelved = await readShelvedBySection(pgliteClient(db), BINDER);
    const clearedSplit = binderSplit({
      type: "general",
      pages: 40,
      pocketsPerPage: 9,
      backHalfStartPage: null,
    });
    expect(strandedSections(clearedSplit, shelved)).toEqual([
      { half: "back", shelvedCount: 1, newCapacity: 0 },
    ]);
  });

  it("does not block a resize that only touches the empty half", async () => {
    await seedBinder(40, 9, 21);
    await shelve("c0000000-0000-0000-0000-000000000104", "cardA", "front");
    await asOwner(db);

    const shelved = await readShelvedBySection(pgliteClient(db), BINDER);
    expect(shelved).toEqual({ front: 1, back: 0, single: 0 });
    // Shrink the back half drastically — nothing is shelved there, so nothing to strand.
    const split = binderSplit({
      type: "general",
      pages: 22,
      pocketsPerPage: 9,
      backHalfStartPage: 21,
    });
    expect(strandedSections(split, shelved)).toEqual([]);
  });

  it("reads a specialty binder's single (null-half) section via IS NULL, not = NULL", async () => {
    const SPECIALTY = "b0000000-0000-0000-0000-000000000032";
    await seedSpecialtyBinder(SPECIALTY, 10, 9);
    await shelveNoHalf("c0000000-0000-0000-0000-000000000105", "cardA", SPECIALTY);
    await shelveNoHalf("c0000000-0000-0000-0000-000000000106", "cardB", SPECIALTY);
    await asOwner(db);

    const shelved = await readShelvedBySection(pgliteClient(db), SPECIALTY);
    expect(shelved).toEqual({ front: 0, back: 0, single: 2 });

    // Shrinking to 1 page x 9 = 9 pockets still fits 2 cards; shrinking further blocks.
    const roomy = binderSplit({
      type: "specialty",
      pages: 1,
      pocketsPerPage: 9,
      backHalfStartPage: null,
    });
    expect(strandedSections(roomy, shelved)).toEqual([]);
    const tooSmall = binderSplit({
      type: "specialty",
      pages: 1,
      pocketsPerPage: 1,
      backHalfStartPage: null,
    });
    expect(strandedSections(tooSmall, shelved)).toEqual([
      { half: "single", shelvedCount: 2, newCapacity: 1 },
    ]);
  });
});
