/**
 * A binder section at its limit takes no more cards, however the card got there (lib/line/section-room.ts). A section is
 * one half of a general binder, or a whole specialty binder; its room is the `binder_section` view's free pockets
 * (capacity less what is shelved, blocked and reserved by open placeholders).
 *
 * Followed through every writer that puts a card in one, against real Postgres (PGlite, every migration, RLS as the
 * owner), as the authenticated owner:
 *   1. A Move (applyMove): a front half, a collection's binder, a new line in a back half.
 *   2. What is NOT adding: a card already in that section (a re-band), and a card that joins a line whose slot is
 *      already reserved there.
 *   3. The Haul Plan: her Move on a card waiting in her haul.
 *   4. Collections: a card removed from a collection onto a full shelf, and a collection moved into a full binder.
 *
 * A refusal says so in her words and writes nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyMove, type MoveNameLookups } from "@/lib/line";
import { applyCollectionRemoval, applyCollectionRebindMove } from "@/lib/coll";
import { clearCatalogCache, commitCardPlacement } from "@/lib/plan";
import {
  asOwner,
  asSuperuser,
  freshRpcDb,
  haulRow,
  OWNER,
  seedBinders,
  seedCatalogCardsFull,
  seedCollections,
  seedHaulRows,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";
import { CHARMANDER_SV03_026 } from "../engine/fixtures";

const GEN = "b0000000-0000-4000-8000-000000000201";
const GEN2 = "b0000000-0000-4000-8000-000000000202";
const SPEC = "b0000000-0000-4000-8000-000000000203";
const COL = "a0000000-0000-4000-8000-000000000201";
const LINE = "10000000-0000-4000-8000-000000000201";
const S = (n: number) => `20000000-0000-4000-8000-00000000020${n}`;
const C = (n: number) => `c0000000-0000-4000-8000-0000000002${String(n).padStart(2, "0")}`;

const FRONT_FULL = "KB-001's front half is full. Pick another place, or add pages in Settings.";
const BACK_FULL = "KB-001's back half is full. Pick another place, or add pages in Settings.";
const names: MoveNameLookups = {
  binderName: (id) => (id === GEN ? "KB-001" : id === GEN2 ? "KB-002" : "Specialty A"),
  collectionName: () => "Starters",
  bandDisplay: (k) => k,
};
const front = (binderId = GEN, band = "red") =>
  ({ kind: "shelf", binderId, half: "front", band }) as const;
const back = { kind: "shelf", binderId: GEN, half: "back", band: "red" } as const;

let db: PGlite;
afterEach(async () => {
  if (db && !db.closed) await db.close();
});
async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  await asSuperuser(db);
  return (await db.query<T>(sql, params)).rows;
}
const placeOf = async (id: string) =>
  (
    await q<{ role: string; binder: string | null; half: string | null; band: string | null }>(
      `select role, binder_id as binder, binder_half as half, color_band as band from copy where id = $1`,
      [id],
    )
  )[0];
const freeIn = async (binder: string, half: string) =>
  Number(
    (
      await q<{ n: number }>(
        `select free_pockets::int as n from binder_section where binder_id = $1 and half = $2`,
        [binder, half],
      )
    )[0].n,
  );

beforeEach(async () => {
  db = await freshRpcDb();
  await seedCatalogCardsFull(db, [CHARMANDER_SV03_026]);
  // Each general binder: a front page and a back page of 2 pockets. The specialty binder: one page of 2.
  await seedBinders(db, [
    { id: GEN, type: "general", name: "KB-001", pages: 2, backHalfStartPage: 2 },
    { id: GEN2, type: "general", name: "KB-002", pages: 2, backHalfStartPage: 2 },
    { id: SPEC, type: "specialty", name: "Specialty A", pages: 1 },
  ]);
  await q(`update binder set pockets_per_page = 2`);
  await q(
    `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from, card_class) values
       ('emberling', 'Emberling', '{9301}', '{Fire}', 'Basic', null, 'standard'),
       ('emberdrake', 'Emberdrake', '{9302}', '{Fire}', 'Stage1', 'Emberling', 'standard'),
       ('emberlord', 'Emberlord', '{9303}', '{Fire}', 'Stage2', 'Emberdrake', 'standard')`,
  );
  clearCatalogCache();
});

/** A shelved card of her own, in a binder's half (a specialty binder has none). */
async function shelved(id: number, binder: string, half: "front" | "back" | null, band = "red") {
  await q(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
       values ($1, $2, 'emberling', 'shelved', $3, $4, $5)`,
    [C(id), OWNER, binder, half, half ? band : null],
  );
}
/** Fill a section to its limit with plain shelved cards (2 pockets). */
async function fill(binder: string, half: "front" | "back" | null, first = 50) {
  await shelved(first, binder, half);
  await shelved(first + 1, binder, half);
}

describe("a Move into a section at its limit", () => {
  it("a front half: refused in her words, and nothing moves", async () => {
    await fill(GEN, "front");
    await shelved(1, GEN2, "front");
    expect(await freeIn(GEN, "front")).toBe(0);
    await asOwner(db);
    await expect(
      applyMove(pgliteClient(db), { copyId: C(1), destination: front() }, names),
    ).rejects.toThrow(FRONT_FULL);
    expect(await placeOf(C(1))).toMatchObject({ binder: GEN2, half: "front" });
    expect(await q(`select id from placement_decision where copy_id = $1`, [C(1)])).toEqual([]);
  });

  it("the same move with one pocket free lands", async () => {
    await shelved(50, GEN, "front");
    await shelved(1, GEN2, "front");
    expect(await freeIn(GEN, "front")).toBe(1);
    await asOwner(db);
    await applyMove(pgliteClient(db), { copyId: C(1), destination: front() }, names);
    expect(await placeOf(C(1))).toMatchObject({ binder: GEN, half: "front" });
    expect(await freeIn(GEN, "front")).toBe(0);
  });

  it("a specialty binder (one section): refused in her words, and the card is not on its collection's list", async () => {
    await seedCollections(db, [
      { id: COL, name: "Starters", targetCatalogCardIds: ["emberling"], currentBinderIds: [SPEC] },
    ]);
    await fill(SPEC, null);
    await shelved(1, GEN, "front");
    expect(await freeIn(SPEC, "single")).toBe(0);
    await asOwner(db);
    await expect(
      applyMove(
        pgliteClient(db),
        { copyId: C(1), destination: { kind: "collection", binderId: SPEC, collectionId: COL } },
        names,
      ),
    ).rejects.toThrow("Specialty A is full. Pick another place, or add pages in Settings.");
    expect(await placeOf(C(1))).toMatchObject({ binder: GEN, half: "front" });
  });

  it("a NEW line in a full back half: refused, with nothing written for it", async () => {
    await fill(GEN, "back");
    await shelved(1, GEN2, "front");
    await asOwner(db);
    await expect(
      applyMove(
        pgliteClient(db),
        { copyId: C(1), destination: { ...back, lineJoin: { mode: "new" } } },
        names,
      ),
    ).rejects.toThrow(BACK_FULL);
    expect(await placeOf(C(1))).toMatchObject({ binder: GEN2, half: "front" });
    expect(await q(`select id from evolution_line`)).toEqual([]);
  });

  it("a new line that needs more pockets than are free: refused, naming how many", async () => {
    await shelved(50, GEN, "back"); // 1 of 2 back pockets free
    await shelved(1, GEN2, "front");
    await asOwner(db);
    // Emberling's line is three stages: the card plus two placeholders = 3 pockets, 1 free.
    await expect(
      applyMove(
        pgliteClient(db),
        { copyId: C(1), destination: { ...back, lineJoin: { mode: "new" } } },
        names,
      ),
    ).rejects.toThrow(
      "KB-001's back half has room for 1 more pocket, and this needs 3. Pick another place, or add pages in Settings.",
    );
    expect(await q(`select id from evolution_line`)).toEqual([]);
  });
});

describe("what is not adding a card", () => {
  it("a card already in a full section: re-banding it there is allowed", async () => {
    await fill(GEN, "front");
    expect(await freeIn(GEN, "front")).toBe(0);
    await asOwner(db);
    await applyMove(pgliteClient(db), { copyId: C(50), destination: front(GEN, "orange") }, names);
    expect(await placeOf(C(50))).toMatchObject({ binder: GEN, half: "front", band: "orange" });
  });

  it("joining a line whose slot is already reserved in a full back half is allowed", async () => {
    // Back half: Emberling shelved in its slot + a reserved placeholder for the Stage 1 = the 2 pockets, full.
    await q(
      `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
         values ($1, $2, 9301, 'red', $3, 'back', 'open')`,
      [LINE, OWNER, GEN],
    );
    await shelved(10, GEN, "back");
    await q(
      `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id) values
         ($1, $3, $4, 0, 'Basic', 'filled', $5), ($2, $3, $4, 1, 'Stage1', 'placeholder', null)`,
      [S(0), S(1), OWNER, LINE, C(10)],
    );
    await q(`update copy set line_slot_id = $1 where id = $2`, [S(0), C(10)]);
    expect(await freeIn(GEN, "back")).toBe(0);
    await q(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
         values ($1, $2, 'emberdrake', 'shelved', $3, 'front', 'red')`,
      [C(11), OWNER, GEN2],
    );
    await asOwner(db);
    await applyMove(
      pgliteClient(db),
      {
        copyId: C(11),
        destination: { ...back, lineJoin: { mode: "existing", lineId: LINE, slotId: S(1) } },
      },
      names,
    );
    expect(await placeOf(C(11))).toMatchObject({ binder: GEN, half: "back" });
  });
});

describe("the Haul Plan: her Move on a card waiting in her haul", () => {
  const waiting = () => haulRow(C(2), CHARMANDER_SV03_026.tcgdexId);
  beforeEach(async () => {
    await seedHaulRows(db, [waiting()]);
  });

  it("into a full front half: refused in her words, and the card is still in her haul", async () => {
    await fill(GEN, "front");
    await asOwner(db);
    await expect(
      commitCardPlacement(pgliteClient(db), { card: waiting(), override: front() }),
    ).rejects.toThrow(FRONT_FULL);
    expect(await placeOf(C(2))).toMatchObject({ role: "haul", binder: null });
  });

  it("into a front half with room: lands", async () => {
    await shelved(50, GEN, "front");
    await asOwner(db);
    await commitCardPlacement(pgliteClient(db), { card: waiting(), override: front() });
    expect(await placeOf(C(2))).toMatchObject({ role: "shelved", binder: GEN, half: "front" });
  });
});

describe("Collections", () => {
  it("a card removed from a collection onto a full shelf: refused, and it stays in the collection", async () => {
    await seedCollections(db, [
      { id: COL, name: "Starters", targetCatalogCardIds: ["emberling"], currentBinderIds: [SPEC] },
    ]);
    await shelved(30, SPEC, null);
    await fill(GEN, "front");
    await asOwner(db);
    await expect(
      applyCollectionRemoval(
        pgliteClient(db),
        { collectionId: COL, tcgdexId: "emberling", destination: front() },
        names,
      ),
    ).rejects.toThrow(FRONT_FULL);
    expect(await placeOf(C(30))).toMatchObject({ binder: SPEC });
  });

  it("a collection moved into a binder too full for its cards: refused, and nothing moves", async () => {
    const SPEC2 = "b0000000-0000-4000-8000-000000000204";
    await seedBinders(db, [{ id: SPEC2, type: "specialty", name: "Specialty B", pages: 1 }]);
    await q(`update binder set pockets_per_page = 2 where id = $1`, [SPEC2]);
    await seedCollections(db, [
      { id: COL, name: "Starters", targetCatalogCardIds: ["emberling"], currentBinderIds: [SPEC] },
    ]);
    await shelved(30, SPEC, null);
    await fill(SPEC2, null, 60);
    await asOwner(db);
    await expect(
      applyCollectionRebindMove(pgliteClient(db), { collectionId: COL, toBinderId: SPEC2 }),
    ).rejects.toThrow("Specialty B is full. Pick another place, or add pages in Settings.");
    expect(await placeOf(C(30))).toMatchObject({ binder: SPEC });
  });
});
