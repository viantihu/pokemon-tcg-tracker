/**
 * `copyRepo.listShelvedInSection` (UIL-055 follow-up) — QA held #159 because `loadBinderCards` read
 * the WHOLE collection's shelved copies via `listShelved` and filtered to one binder in memory, an
 * unpaged select capped at Supabase's 1000-row default. Past that cap it would silently drop cards
 * from the binder grid with no error — the failure shape this screen exists to prevent. The fix scopes
 * the read to one section of one binder instead, which has no such ceiling regardless of collection
 * size.
 *
 * `half: null` is the new branch this fix adds — a specialty binder's single section stores no half
 * at all (migration 0002: `binder_half` is NULL for those rows), so it needs `.is()`, not `.eq()`.
 * That branch had zero prior test coverage; this is what actually exercises it against real Postgres.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { copyRepo } from "@/lib/repo";
import { asOwner, freshRpcDb, OWNER, seedBinders, seedCatalogCards } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const GENERAL = "b0000000-0000-0000-0000-000000000021";
const SPECIALTY = "b0000000-0000-0000-0000-000000000022";
const OTHER_GENERAL = "b0000000-0000-0000-0000-000000000023";

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedCatalogCards(db, ["cardA", "cardB", "cardC", "cardD"]);
  await seedBinders(db, [
    { id: GENERAL, type: "general", name: "General A" },
    { id: SPECIALTY, type: "specialty", name: "Specialty A" },
    { id: OTHER_GENERAL, type: "general", name: "General B" },
  ]);
  await db.exec(`
    insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
      values
        ('c0000000-0000-0000-0000-000000000f01', '${OWNER}', 'cardA', 'shelved', '${GENERAL}', 'front', 'red'),
        ('c0000000-0000-0000-0000-000000000f02', '${OWNER}', 'cardB', 'shelved', '${GENERAL}', 'back', 'red'),
        ('c0000000-0000-0000-0000-000000000f03', '${OWNER}', 'cardC', 'shelved', '${SPECIALTY}', null, 'red'),
        ('c0000000-0000-0000-0000-000000000f04', '${OWNER}', 'cardD', 'shelved', '${OTHER_GENERAL}', 'front', 'red'),
        ('c0000000-0000-0000-0000-000000000f05', '${OWNER}', 'cardA', 'bulk', null, null, null),
        ('c0000000-0000-0000-0000-000000000f06', '${OWNER}', 'cardA', 'block', '${GENERAL}', 'front', 'red');
  `);
  await asOwner(db); // RLS on from here — matches how the real action reads.
});
afterEach(async () => {
  await db.close();
});

describe("copyRepo.listShelvedInSection", () => {
  it("returns only the front-half copies of the given binder", async () => {
    const rows = await copyRepo.listShelvedInSection(pgliteClient(db), GENERAL, "front");
    expect(rows.map((r) => r.catalog_card_id)).toEqual(["cardA"]);
  });

  it("returns only the back-half copies of the given binder", async () => {
    const rows = await copyRepo.listShelvedInSection(pgliteClient(db), GENERAL, "back");
    expect(rows.map((r) => r.catalog_card_id)).toEqual(["cardB"]);
  });

  it("half: null reads a specialty binder's single section via IS NULL, not = NULL", async () => {
    const rows = await copyRepo.listShelvedInSection(pgliteClient(db), SPECIALTY, null);
    expect(rows.map((r) => r.catalog_card_id)).toEqual(["cardC"]);
  });

  it("never crosses into another binder's cards, even one sharing the same half", async () => {
    const rows = await copyRepo.listShelvedInSection(pgliteClient(db), GENERAL, "front");
    expect(rows.some((r) => r.catalog_card_id === "cardD")).toBe(false);
  });

  it("excludes bulk (unshelved) copies", async () => {
    const rows = await copyRepo.listShelvedInSection(pgliteClient(db), SPECIALTY, null);
    expect(rows.some((r) => r.catalog_card_id === "cardA" && r.role === "bulk")).toBe(false);
  });

  // QA on #159: the bulk-copy fixture above has no binder_id, so the binder filter alone already
  // excludes it — that test passes even with the role filter removed entirely. A block-role copy
  // in the SAME binder and half as a real shelved one is what actually pins the role filter.
  it("excludes a block copy in the same binder and half as a real shelved one", async () => {
    const rows = await copyRepo.listShelvedInSection(pgliteClient(db), GENERAL, "front");
    expect(rows.map((r) => r.role)).toEqual(["shelved"]);
  });
});
