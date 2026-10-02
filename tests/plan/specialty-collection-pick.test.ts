/**
 * UIL-053 — a specialty card the Haul Plan sends to a specialty binder that holds collections must join
 * one of them. Karvi reproduced it: 13 cards took the cascade's CARD-CLASS route after her start-over and
 * landed in her specialty binder on NO collection's list, so no collection showed them, and she re-added
 * each from Lookup.
 *
 * The approved fix, pinned on the REAL cascade and the REAL commit through `apply_write_ops` (PGlite):
 *   - when that binder holds any collection, the plan names them and picks none (her decision);
 *   - the server refuses the card with no pick, in her words, and writes nothing;
 *   - her pick puts the card on that collection's list, in the same transaction as its placement;
 *   - a pick that is not one of the binder's collections is refused;
 *   - a specialty binder with no collections keeps today's placement.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  clearCatalogCache,
  COLLECTION_PICK,
  commitCardPlacement,
  deriveSpotlightPlacement,
  type DraftItem,
} from "@/lib/plan";
import { CHARIZARD_EX_SV035_006 } from "../engine/fixtures";
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
import { shelveCardAction } from "@/app/(ui)/plan/actions";

// The action's owner seam needs a real request; hand it the PGlite client instead (as tests/plan/line-done.test.ts).
vi.mock("@/lib/plan/session", () => ({
  getOwnerContext: async () => ({ db: pgliteClient(db), ownerId: OWNER }),
}));

const B1 = "1c000000-0000-0000-0000-0000000000b1";
const SPEC = "1c000000-0000-0000-0000-00000000c5ec";
const SPEC2 = "1c000000-0000-0000-0000-00000000c5ed";
const CHARIZARDS = "c0111111-0000-0000-0000-0000000000c1";
const FIRE = "c0111111-0000-0000-0000-0000000000c2";
const ELSEWHERE = "c0111111-0000-0000-0000-0000000000c3";

/** The card in this haul: a Charizard ex, specialty class — a copy her import made (UIL-098). */
const INCOMING: DraftItem = haulRow(
  "d0000000-0000-4000-8000-0000000000a1",
  CHARIZARD_EX_SV035_006.tcgdexId,
);

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedCatalogCardsFull(db, [CHARIZARD_EX_SV035_006]);
  await seedBinders(db, [
    { id: B1, type: "general", name: "Binder 1" },
    { id: SPEC, type: "specialty", name: "Specialty A" },
  ]);
  await seedHaulRows(db, [INCOMING]);
  clearCatalogCache();
  await asOwner(db);
});

/** Seed as superuser, then act as her again: every commit and read below runs as the owner. */
async function seeded(seed: () => Promise<void>): Promise<void> {
  await asSuperuser(db);
  await seed();
  await asOwner(db);
}
afterEach(async () => {
  await db.close();
});

async function copyRow() {
  const r = await db.query<{ role: string; binder_id: string | null }>(
    `select role, binder_id from copy where id = $1`,
    [INCOMING.existingCopyId],
  );
  return r.rows[0] ?? null;
}
async function listOf(collectionId: string): Promise<string[]> {
  const r = await db.query<{ ids: string[] }>(
    `select target_catalog_card_ids ids from collection where id = $1`,
    [collectionId],
  );
  return r.rows[0]?.ids ?? [];
}
async function decisions() {
  const r = await db.query<{ decision: string; reason: string; resolved_by: string }>(
    `select decision, reason, resolved_by from placement_decision where copy_id = $1`,
    [INCOMING.existingCopyId],
  );
  return r.rows;
}

describe("UIL-053 · a specialty binder with collections: she picks which one", () => {
  it("the plan names the binder's collections and picks none", async () => {
    await seeded(() =>
      seedCollections(db, [
        { id: CHARIZARDS, name: "Charizards", currentBinderIds: [SPEC], mode: "open" },
        { id: FIRE, name: "Fire art", currentBinderIds: [SPEC], mode: "finite" },
      ]),
    );
    const spot = await deriveSpotlightPlacement(pgliteClient(db), INCOMING);
    expect(spot?.item.action).toBe("SPEC");
    expect(spot?.item.collectionPick).toEqual({
      binderId: SPEC,
      collections: expect.arrayContaining([
        { id: CHARIZARDS, name: "Charizards" },
        { id: FIRE, name: "Fire art" },
      ]),
    });
    expect(spot?.item.collectionPick?.collections).toHaveLength(2);
  });

  it("refuses the card with no pick, and writes nothing", async () => {
    // Her case: an OPEN collection with an empty list, living in the specialty binder.
    await seeded(() =>
      seedCollections(db, [
        { id: CHARIZARDS, name: "Charizards", currentBinderIds: [SPEC], mode: "open" },
      ]),
    );
    // PRE-FIX: this wrote the card into Specialty A on NO collection's list.
    await expect(commitCardPlacement(pgliteClient(db), { card: INCOMING })).rejects.toThrow(
      COLLECTION_PICK.missing,
    );
    expect(await copyRow()).toEqual({ role: "haul", binder_id: null });
    expect(await listOf(CHARIZARDS)).toEqual([]);
    expect(await decisions()).toEqual([]);
  });

  it("her pick puts the card on that collection's list, with its placement, as her decision", async () => {
    await seeded(() =>
      seedCollections(db, [
        { id: CHARIZARDS, name: "Charizards", currentBinderIds: [SPEC], mode: "open" },
        { id: FIRE, name: "Fire art", currentBinderIds: [SPEC] },
      ]),
    );
    // The SECOND collection, so joining "the first one" instead of hers would fail here.
    await commitCardPlacement(pgliteClient(db), { card: INCOMING, collectionChoice: FIRE });
    expect(await copyRow()).toEqual({ role: "shelved", binder_id: SPEC });
    expect(await listOf(FIRE)).toEqual([CHARIZARD_EX_SV035_006.tcgdexId]);
    expect(await listOf(CHARIZARDS)).toEqual([]); // only the one she picked
    expect(await decisions()).toEqual([
      {
        decision: "card-class",
        reason: 'Specialty card filed in the "Fire art" collection (her pick, UIL-053).',
        resolved_by: "user",
      },
    ]);
  });

  it("refuses a pick that is not one of this binder's collections", async () => {
    await seeded(() => seedBinders(db, [{ id: SPEC2, type: "specialty", name: "Specialty B" }]));
    await seeded(() =>
      seedCollections(db, [
        { id: CHARIZARDS, name: "Charizards", currentBinderIds: [SPEC], mode: "open" },
        { id: ELSEWHERE, name: "In the other binder", currentBinderIds: [SPEC2] },
      ]),
    );
    await expect(
      commitCardPlacement(pgliteClient(db), { card: INCOMING, collectionChoice: ELSEWHERE }),
    ).rejects.toThrow(COLLECTION_PICK.notHere);
    expect(await copyRow()).toEqual({ role: "haul", binder_id: null });
    expect(await listOf(ELSEWHERE)).toEqual([]);
  });
});

describe("UIL-053 · her Move still goes anywhere (a card must always be movable)", () => {
  const withCollection = () =>
    seeded(() =>
      seedCollections(db, [
        { id: CHARIZARDS, name: "Charizards", currentBinderIds: [SPEC], mode: "open" },
      ]),
    );

  it("a Move to a front half commits with no collection pick, and joins no list", async () => {
    await withCollection();
    await commitCardPlacement(pgliteClient(db), {
      card: INCOMING,
      override: { kind: "shelf", binderId: B1, half: "front", band: "red" },
    });
    expect(await copyRow()).toEqual({ role: "shelved", binder_id: B1 });
    expect(await listOf(CHARIZARDS)).toEqual([]);
  });

  it("a Move to the bulk box commits with no collection pick, and joins no list", async () => {
    await withCollection();
    await commitCardPlacement(pgliteClient(db), { card: INCOMING, override: { kind: "bulk" } });
    expect(await copyRow()).toEqual({ role: "bulk", binder_id: null });
    expect(await listOf(CHARIZARDS)).toEqual([]);
  });
});

describe("UIL-053 · a specialty binder with no collections is unchanged", () => {
  it("shelves the card there with no pick asked for", async () => {
    const spot = await deriveSpotlightPlacement(pgliteClient(db), INCOMING);
    expect(spot?.item.collectionPick ?? null).toBeNull();
    await commitCardPlacement(pgliteClient(db), { card: INCOMING });
    expect(await copyRow()).toEqual({ role: "shelved", binder_id: SPEC });
    expect((await decisions())[0]?.resolved_by).toBe("auto");
  });

  it("a collection in ANOTHER binder asks nothing of this one", async () => {
    await seeded(() => seedBinders(db, [{ id: SPEC2, type: "specialty", name: "Specialty B" }]));
    await seeded(() =>
      seedCollections(db, [{ id: ELSEWHERE, name: "Elsewhere", currentBinderIds: [SPEC2] }]),
    );
    await commitCardPlacement(pgliteClient(db), { card: INCOMING });
    expect(await copyRow()).toEqual({ role: "shelved", binder_id: SPEC });
  });
});

/**
 * 0037 (Karvi, 2026-10-01: "Users should always be able to override all rules"): she can shelve the card in that
 * binder with no collection, as her explicit choice. It is recorded as an override (collection_pick) on the card's
 * decision, declared on the write. A pick that is no longer one of the binder's collections is still refused.
 */
describe("0037 · she shelves it without a collection, knowingly", () => {
  async function overridesOf() {
    const r = await db.query<{ overrides: string[]; resolved_by: string }>(
      `select overrides, resolved_by from placement_decision where copy_id = $1`,
      [INCOMING.existingCopyId],
    );
    return r.rows;
  }
  const withCollections = () =>
    seeded(() =>
      seedCollections(db, [
        { id: CHARIZARDS, name: "Charizards", currentBinderIds: [SPEC], mode: "open" },
        { id: FIRE, name: "Fire art", currentBinderIds: [SPEC] },
      ]),
    );

  it("with her override: shelved in the binder on no collection's list, and recorded as hers", async () => {
    await withCollections();
    await commitCardPlacement(pgliteClient(db), { card: INCOMING, noCollection: true });
    expect(await copyRow()).toEqual({ role: "shelved", binder_id: SPEC });
    expect(await listOf(CHARIZARDS)).toEqual([]);
    expect(await listOf(FIRE)).toEqual([]);
    expect(await overridesOf()).toEqual([{ overrides: ["collection_pick"], resolved_by: "user" }]);
    // Her words, spoken to her as every other reason is ("your call").
    expect((await decisions())[0]?.reason).toBe(
      "Specialty card shelved in its binder with no collection (your call): it counts toward none.",
    );
  });

  it("through the screen's own action: her override reaches the write", async () => {
    await withCollections();
    const res = await shelveCardAction({
      card: {
        id: INCOMING.id,
        tcgdexId: INCOMING.tcgdexId,
        variant: INCOMING.variant,
        existingCopyId: INCOMING.id,
      },
      noCollection: true,
    });
    expect(res).toMatchObject({ ok: true });
    expect(await overridesOf()).toEqual([{ overrides: ["collection_pick"], resolved_by: "user" }]);
  });

  it("without it: still asked to pick, and nothing is written", async () => {
    await withCollections();
    await expect(
      commitCardPlacement(pgliteClient(db), { card: INCOMING, noCollection: false }),
    ).rejects.toThrow(COLLECTION_PICK.missing);
    expect(await copyRow()).toEqual({ role: "haul", binder_id: null });
    expect(await overridesOf()).toEqual([]);
  });

  it("a stale pick is still refused, even with the override", async () => {
    await seeded(() => seedBinders(db, [{ id: SPEC2, type: "specialty", name: "Specialty B" }]));
    await withCollections();
    await seeded(() =>
      seedCollections(db, [{ id: ELSEWHERE, name: "Elsewhere", currentBinderIds: [SPEC2] }]),
    );
    await expect(
      commitCardPlacement(pgliteClient(db), {
        card: INCOMING,
        collectionChoice: ELSEWHERE,
        noCollection: true,
      }),
    ).rejects.toThrow(COLLECTION_PICK.notHere);
    expect(await copyRow()).toEqual({ role: "haul", binder_id: null });
  });

  it("with a collection picked, the override changes nothing: it joins that one, as before", async () => {
    await withCollections();
    await commitCardPlacement(pgliteClient(db), {
      card: INCOMING,
      collectionChoice: FIRE,
      noCollection: true,
    });
    expect(await listOf(FIRE)).toEqual([CHARIZARD_EX_SV035_006.tcgdexId]);
    expect(await overridesOf()).toEqual([{ overrides: [], resolved_by: "user" }]);
  });
});
