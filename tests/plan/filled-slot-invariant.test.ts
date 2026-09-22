/**
 * UIL-087 — a `line_slot` reading `filled` must point at a copy that is really shelved into it.
 *
 * Karvi: "It's showing that the slot is already filled even though the record actually never got
 * shelved… There should've never been a line getting filled in that line if the card never got shelved
 * there." Three such rows existed on Testing, one of them her Toedscruel.
 *
 * THE INVARIANT, as she stated it and as `violations()` below encodes it: for every slot in state
 * `filled`, its `copy_id` names a copy that exists, whose `role` is `shelved`, whose `line_slot_id`
 * points back at that slot, and whose binder and half match the line's. Anything else is UIL-062's class
 * of half-written state arriving by a new route.
 *
 * TWO ROUTES, both closed here, one live and one latent:
 *
 *   V1 (the three live rows). `ownedAt` matches an owned copy on species + band with no role filter, so
 *   a BULK copy — exactly what a sync import leaves, a real row placed nowhere — was planned as filling
 *   that stage with the note "already placed". Confirming the pull then wrote binder, half, band and the
 *   slot pointer but NOT `role`, so the card was wired into the line while still sitting in the pile. It
 *   survived because the pull the engine was designed around is a FRONT-HALF copy, which is already
 *   shelved: omitting the role changed nothing for it, which is why every prior test passed.
 *
 *   V2 (latent, zero rows on Testing). `line_slot.copy_id` is `on delete set null`, so deleting a copy
 *   that fills a slot frees the pointer and leaves `state = 'filled'` — a slot holding nothing. Migration
 *   0010's one-time repair explicitly required `copy_id is not null`, so this shape was never in its
 *   predicate and nothing detects it. The sync's RETIRE path already released the slot properly (UIL-062's
 *   shared emitter); the sync's UNDO path deleted bare, and a sync-created copy can be shelved into a
 *   line from the Haul Plan (UIL-003's flow) before that sync is undone.
 *
 * Real Postgres (PGlite), real migrations, real `apply_write_ops`, as the authenticated owner — the
 * invariant is a property of ROWS, so a fake would only be able to confirm the author's own belief.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  clearCatalogCache,
  commitCardPlacement,
  deriveSpotlightPlacement,
  type DraftItem,
} from "@/lib/plan";
import { applyMove } from "@/lib/line";
import { executeUndo } from "@/lib/sync";
import type { MoveDestination } from "@/lib/line/types";
import {
  applyOps,
  asOwner,
  asSuperuser,
  freshRpcDb,
  OWNER,
  seedBinders,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const KB1 = "b0000000-0000-0000-0000-00000000e801";
const ROOT_DEX = 9481; // Toedscool, the Basic
const S1_DEX = 9482; // Toedscruel, the Stage1 — a Basic never starts a line (UIL-056)
const BULK_COOL = "c0000000-0000-0000-0000-00000000e801";
const FRONT_COOL = "c0000000-0000-0000-0000-00000000e802";
const BLOCK_COOL = "c0000000-0000-0000-0000-00000000e803";

/** The card she is placing: a Stage1, which is what makes the cascade create a line. */
const TOEDSCRUEL: DraftItem = { id: "d-cruel", tcgdexId: "toedscruel", variant: "normal" };

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  clearCatalogCache();
  await seedBinders(db, [{ id: KB1, type: "general", name: "KB-001" }]);
  for (const [id, name, dex, stage, from] of [
    ["toedscool", "Toedscool", ROOT_DEX, "Basic", null],
    ["toedscruel", "Toedscruel", S1_DEX, "Stage1", "Toedscool"],
  ] as const) {
    await db.query(
      `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from, card_class)
         values ($1, $2, $3, '{Fighting}', $4, $5, 'standard')`,
      [id, name, [dex], stage, from],
    );
  }
});
afterEach(async () => {
  await db.close();
});

/**
 * EVERY violating slot in the whole database, with the reason — run after each write path rather than
 * asserting on the rows a test happens to know about, so a path that breaks a DIFFERENT slot is caught
 * too. Returns `[]` when the invariant holds.
 */
async function violations() {
  const r = await db.query<{ slot_id: string; why: string }>(`
    select s.id as slot_id,
           case
             when s.copy_id is null then 'filled with NO copy'
             when c.id is null then 'copy row is gone'
             when c.role <> 'shelved' then 'copy role is ' || c.role || ', not shelved'
             when c.line_slot_id is distinct from s.id then 'copy does not point back'
             when c.binder_id is distinct from l.binder_id then 'copy is in another binder'
             when c.binder_half <> 'back' then 'copy is not in the back half'
             else 'ok'
           end as why
    from line_slot s
    join evolution_line l on l.id = s.line_id
    left join copy c on c.id = s.copy_id
    where s.state = 'filled'
  `);
  return r.rows.filter((row) => row.why !== "ok");
}

async function copyRow(id: string) {
  return (
    await db.query<{
      role: string;
      binder_id: string | null;
      binder_half: string | null;
      line_slot_id: string | null;
    }>(`select role, binder_id, binder_half, line_slot_id from copy where id = $1`, [id])
  ).rows[0];
}
async function slots() {
  return (
    await db.query<{
      id: string;
      stage_index: number;
      state: string;
      copy_id: string | null;
      note: string | null;
    }>(`select id, stage_index, state, copy_id, note from line_slot order by stage_index`)
  ).rows;
}
/** As a sync import leaves it: a real copy row, role 'bulk', placed nowhere. */
const seedBulkCool = () =>
  db.query(
    `insert into copy (id, owner_id, catalog_card_id, role) values ($1, $2, 'toedscool', 'bulk')`,
    [BULK_COOL, OWNER],
  );
/** Shelved in a front half — the pull the engine was designed around. */
const seedFrontCool = () =>
  db.query(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
       values ($1, $2, 'toedscool', 'shelved', $3, 'front', 'orange')`,
    [FRONT_COOL, OWNER, KB1],
  );
/** A card sacrificed as a physical block, with the `binder_block` row that references it. */
const seedBlockCool = async () => {
  await db.query(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half)
       values ($1, $2, 'toedscool', 'block', $3, 'back')`,
    [BLOCK_COOL, OWNER, KB1],
  );
  await db.query(
    `insert into binder_block (owner_id, binder_id, half, pocket_count, purpose, material, copy_id)
       values ($1, $2, 'back', 1, 'line-terminated', 'repurposedDuplicate', $3)`,
    [OWNER, KB1, BLOCK_COOL],
  );
};

describe("UIL-087 · V1: pulling a card that is not shelved", () => {
  it("shelves it, so the slot's claim is true — pre-fix the copy stayed in the bulk pile", async () => {
    await seedBulkCool();
    await asOwner(db);
    await commitCardPlacement(pgliteClient(db), {
      source: "bulk-bin",
      card: TOEDSCRUEL,
      confirmedPulls: [BULK_COOL], // she ticked it
    });
    await asSuperuser(db);

    const pulled = await copyRow(BULK_COOL);
    expect(pulled.role).toBe("shelved"); // pre-fix: "bulk"
    expect(pulled.binder_id).toBe(KB1);
    expect(pulled.binder_half).toBe("back");
    expect(pulled.line_slot_id).not.toBeNull();
    // The invariant over the WHOLE state, which is the real assertion.
    expect(await violations()).toEqual([]);
  });

  it("says the card is not placed yet, never 'already placed' (her wording, UIL-088's premise)", async () => {
    await seedBulkCool();
    await asOwner(db);
    await commitCardPlacement(pgliteClient(db), {
      source: "bulk-bin",
      card: TOEDSCRUEL,
      confirmedPulls: [BULK_COOL],
    });
    await asSuperuser(db);
    const rootSlot = (await slots()).find((s) => s.stage_index === 0)!;
    expect(rootSlot.note).toBe("not yet placed (still in the haul)");
    expect(rootSlot.note).not.toBe("already placed");
    // Never asserts a placement she did not make: "bulk box" is a real place in her model, and an
    // imported-but-unplaced card is not in it (Karvi 2026-09-22; the conflation is UIL-088).
    expect(rootSlot.note).not.toMatch(/bulk/i);
  });

  it("a DECLINED pull still leaves a placeholder and touches nothing (UIL-061, unchanged)", async () => {
    await seedBulkCool();
    await asOwner(db);
    await commitCardPlacement(pgliteClient(db), { source: "bulk-bin", card: TOEDSCRUEL });
    await asSuperuser(db);
    const rootSlot = (await slots()).find((s) => s.stage_index === 0)!;
    expect(rootSlot.state).toBe("placeholder");
    expect(rootSlot.copy_id).toBeNull();
    expect(await copyRow(BULK_COOL)).toMatchObject({ role: "bulk", line_slot_id: null });
    expect(await violations()).toEqual([]);
  });

  it("CONTROL — a front-half pull is unchanged and was always correct", async () => {
    await seedFrontCool();
    await asOwner(db);
    await commitCardPlacement(pgliteClient(db), {
      source: "bulk-bin",
      card: TOEDSCRUEL,
      confirmedPulls: [FRONT_COOL],
    });
    await asSuperuser(db);
    expect(await copyRow(FRONT_COOL)).toMatchObject({ role: "shelved", binder_half: "back" });
    expect((await slots()).find((s) => s.stage_index === 0)!.note).toBe("pull from front half");
    expect(await violations()).toEqual([]);
  });

  it("a BLOCK copy is never proposed at all: shelving it would orphan its binder_block row", async () => {
    await seedBlockCool();
    await asOwner(db);
    await commitCardPlacement(pgliteClient(db), {
      source: "bulk-bin",
      card: TOEDSCRUEL,
      // Even if a stale client ticks it, the engine never named this stage as filled by it.
      confirmedPulls: [BLOCK_COOL],
    });
    await asSuperuser(db);
    const rootSlot = (await slots()).find((s) => s.stage_index === 0)!;
    expect(rootSlot.state).toBe("placeholder");
    expect(await copyRow(BLOCK_COOL)).toMatchObject({ role: "block" });
    // And its block row still names it — nothing was orphaned.
    const blocks = await db.query<{ copy_id: string | null }>(
      `select copy_id from binder_block where copy_id = $1`,
      [BLOCK_COOL],
    );
    expect(blocks.rows).toHaveLength(1);
    expect(await violations()).toEqual([]);
  });
});

describe("UIL-087 · V2: deleting a copy that fills a slot", () => {
  /** Shelve the bulk copy into a line the way the Haul Plan does, then hand back its slot id. */
  async function fillSlotWithPulledCopy(): Promise<string> {
    await seedBulkCool();
    await asOwner(db);
    await commitCardPlacement(pgliteClient(db), {
      source: "bulk-bin",
      card: TOEDSCRUEL,
      confirmedPulls: [BULK_COOL],
    });
    await asSuperuser(db);
    return (await copyRow(BULK_COOL)).line_slot_id as string;
  }

  it("a BARE delete_copy leaves the slot filled with no copy — the shape 0010 never repaired", async () => {
    const slotId = await fillSlotWithPulledCopy();
    await asOwner(db);
    // Deliberately the raw op, not a production path: this pins what the FK does, which is WHY every
    // emitter has to release the slot itself rather than trusting `on delete set null`.
    await applyOps(db, { ops: [{ op: "delete_copy", id: BULK_COOL }] });
    await asSuperuser(db);
    const slot = (await slots()).find((s) => s.id === slotId)!;
    expect(slot).toMatchObject({ state: "filled", copy_id: null });
    expect(await violations()).toEqual([{ slot_id: slotId, why: "filled with NO copy" }]);
  });

  it("releasing the slot in the SAME transaction as the delete keeps the invariant", async () => {
    const slotId = await fillSlotWithPulledCopy();
    await asOwner(db);
    await applyOps(db, {
      ops: [
        { op: "update_slot", id: slotId, patch: { state: "placeholder", copy_id: null } },
        { op: "delete_copy", id: BULK_COOL },
      ],
    });
    await asSuperuser(db);
    expect((await slots()).find((s) => s.id === slotId)).toMatchObject({
      state: "placeholder",
      copy_id: null,
    });
    expect(await violations()).toEqual([]);
  });
});

describe("UIL-087 · what she is told BEFORE she confirms", () => {
  /**
   * The consent step and the anti-drift digest, derived from real state rather than a hand-built
   * `ProposedPull` — a fixture can only confirm the author's own belief about which pulls are flagged.
   */
  it("flags a pull of a not-yet-placed copy, so the consent step can tell her to find the card", async () => {
    await seedBulkCool();
    await asOwner(db);
    const placement = await deriveSpotlightPlacement(pgliteClient(db), TOEDSCRUEL);
    await asSuperuser(db);
    expect(placement!.proposedPulls).toHaveLength(1);
    expect(placement!.proposedPulls[0]).toMatchObject({
      copyId: BULK_COOL,
      name: "Toedscool",
      notYetPlaced: true,
    });
  });

  it("does NOT flag a front-half pull: that card is on a page she can see", async () => {
    await seedFrontCool();
    await asOwner(db);
    const placement = await deriveSpotlightPlacement(pgliteClient(db), TOEDSCRUEL);
    await asSuperuser(db);
    expect(placement!.proposedPulls[0]).toMatchObject({
      copyId: FRONT_COOL,
      notYetPlaced: false,
    });
  });

  it("the digest names an unplaced pull, so a set of them that changed under her is refused", async () => {
    await seedBulkCool();
    await asOwner(db);
    const placement = await deriveSpotlightPlacement(pgliteClient(db), TOEDSCRUEL);
    await asSuperuser(db);
    // Listed distinctly (the Senior BA's ruling): it changes what she must physically do before Done.
    expect(placement!.digest).toContain(`unplaced:${BULK_COOL}`);
  });

  it("a front-half pull is NOT in the digest: it changes no pocket and no errand", async () => {
    await seedFrontCool();
    await asOwner(db);
    const placement = await deriveSpotlightPlacement(pgliteClient(db), TOEDSCRUEL);
    await asSuperuser(db);
    expect(placement!.digest).not.toContain("unplaced:");
    expect(placement!.digest).toContain("newline"); // the rest of the digest is unchanged
  });
});

describe("UIL-087 · V2 through its real path: undoing a sync that created a now-shelved copy", () => {
  /**
   * The reachable route. A sync-created copy starts unplaced; she shelves it into a line from the Haul
   * Plan (UIL-003's flow); then she undoes that sync. `executeUndo` deleted those copies bare, and the
   * FK's `on delete set null` left the slot reading `filled` with nothing in it.
   *
   * The sync's RETIRE path already released the slot through UIL-062's shared emitter — only undo was
   * bare, which is the correction to my own first reading of this.
   */
  it("releases the slot in the same transaction as the delete, and demotes a completed line", async () => {
    await seedBulkCool();
    await asOwner(db);
    await commitCardPlacement(pgliteClient(db), {
      source: "bulk-bin",
      card: TOEDSCRUEL,
      confirmedPulls: [BULK_COOL],
    });
    await asSuperuser(db);
    const slotId = (await copyRow(BULK_COOL)).line_slot_id as string;
    const lineId = (
      await db.query<{ line_id: string }>(`select line_id from line_slot where id = $1`, [slotId])
    ).rows[0].line_id;
    // Pretend the line had been completed, so the demotion is observable.
    await db.query(`update evolution_line set status = 'complete' where id = $1`, [lineId]);

    // The snapshot that undo inverts: this sync created the copy she has since shelved.
    await db.query(`insert into last_sync_snapshot (owner_id, snapshot) values ($1, $2::jsonb)`, [
      OWNER,
      JSON.stringify({
        version: 1,
        createdAt: "2026-09-22T00:00:00.000Z",
        fastPath: true,
        counts: {
          creates: 1,
          retires: 0,
          variantUpdates: 0,
          parks: 0,
          drops: 0,
          promotions: 0,
          dedupeUpdates: 0,
          unchanged: 0,
        },
        createdCopyIds: [BULK_COOL],
        retiredCopies: [],
        slotReverts: [],
        variantReverts: [],
        touchedGroupIds: [],
        queue: { parkedIds: [], droppedEntries: [], updatedPrior: [], archivedPrior: [] },
      }),
    ]);

    await asOwner(db);
    await executeUndo(pgliteClient(db));
    await asSuperuser(db);

    // The copy is gone, as undo intends — and the slot it filled is open again, not "filled" with null.
    expect(await copyRow(BULK_COOL)).toBeUndefined();
    expect((await slots()).find((s) => s.id === slotId)).toMatchObject({
      state: "placeholder",
      copy_id: null,
    });
    const line = await db.query<{ status: string }>(
      `select status from evolution_line where id = $1`,
      [lineId],
    );
    expect(line.rows[0].status).toBe("open"); // a stage emptied: no longer complete
    expect(await violations()).toEqual([]);
  });
});

describe("UIL-087 · her remedy: moving the card puts the record right", () => {
  it("a Move off a wrongly-filled slot releases it, so she can fix the existing rows herself", async () => {
    // The pre-fix state, built by hand: the slot says filled, the copy was never shelved. This is what
    // her three Testing rows look like, and what the Lines page now offers Move on.
    await seedBulkCool();
    await asOwner(db);
    await commitCardPlacement(pgliteClient(db), {
      source: "bulk-bin",
      card: TOEDSCRUEL,
      confirmedPulls: [BULK_COOL],
    });
    await asSuperuser(db);
    const slotId = (await copyRow(BULK_COOL)).line_slot_id as string;
    // Put the copy back into the broken shape the old write produced.
    await db.query(`update copy set role = 'bulk' where id = $1`, [BULK_COOL]);
    expect(await violations()).toEqual([
      { slot_id: slotId, why: "copy role is bulk, not shelved" },
    ]);

    const dest: MoveDestination = { kind: "bulk" };
    await asOwner(db);
    await applyMove(
      pgliteClient(db),
      { copyId: BULK_COOL, destination: dest },
      {
        binderName: () => "KB-001",
        collectionName: () => null,
        bandDisplay: (k) => k,
      },
    );
    await asSuperuser(db);

    // The slot is released and the invariant holds again — no migration needed to repair her rows.
    expect((await slots()).find((s) => s.id === slotId)).toMatchObject({
      state: "placeholder",
      copy_id: null,
    });
    expect(await violations()).toEqual([]);
  });
});

/**
 * UIL-087 follow-up — the disclosure's "where is it now" label must not assert a placement she never
 * made. `role: 'bulk'` means both "filed in a bulk box" and "an import created this and it is not placed
 * anywhere yet"; for a proposed pull it is usually the second, and saying "Bulk box" would be the same
 * false claim as the "already placed" slot note. Separating the two states is UIL-088.
 */
describe("UIL-087 · the pull's from-label does not guess which kind of 'bulk' it is", () => {
  it("reads as the honest either/or for an unplaced import copy", async () => {
    await seedBulkCool();
    await asOwner(db);
    const placement = await deriveSpotlightPlacement(pgliteClient(db), TOEDSCRUEL);
    await asSuperuser(db);
    expect(placement!.proposedPulls[0].fromLabel).toBe("Bulk box or still in the haul");
    expect(placement!.proposedPulls[0].fromLabel).not.toBe("Bulk box");
  });

  it("a shelved copy's label is unchanged and still names the exact pocket", async () => {
    await seedFrontCool();
    await asOwner(db);
    const placement = await deriveSpotlightPlacement(pgliteClient(db), TOEDSCRUEL);
    await asSuperuser(db);
    expect(placement!.proposedPulls[0].fromLabel).toBe("KB-001 · Front · Orange");
    expect(placement!.proposedPulls[0].notYetPlaced).toBe(false);
  });
});
