/**
 * UIL-084, point 7 — the uniqueness query is binder-scoped, and it SURVIVES duplicates.
 *
 * `findByRootAndBand` answered "does a line for this species and band exist" globally, with
 * `.maybeSingle()`. Two problems, both pinned here:
 *
 *   1. It ignored the binder, so a line in KB-001 owned that species-and-band in every binder — the
 *      whole of her report.
 *   2. `.maybeSingle()` answers TWO rows by THROWING ("JSON object requested, multiple (or no) rows
 *      returned"), and nothing in the schema prevents two: `evolution_line_root_band_idx` is a plain
 *      index, not a unique constraint. So a database that already holds a pair — from data predating
 *      this rule, or a race — turned every subsequent back-half move into a raw error the screen could
 *      not explain, instead of a clean answer. Under the per-binder rule a pair in two binders is
 *      NORMAL, which would have made that the common case rather than a curiosity.
 *
 * Real Postgres (PGlite), real migrations, as the authenticated owner.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { evolutionLineRepo } from "@/lib/repo";
import { OWNER, asOwner, asSuperuser, freshRpcDb, seedBinders } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const KB1 = "b0000000-0000-0000-0000-0000000000f1";
const KB2 = "b0000000-0000-0000-0000-0000000000f2";
const L1 = "10000000-0000-0000-0000-0000000000f1";
const L2 = "10000000-0000-0000-0000-0000000000f2";
const ROOT_DEX = 9481;

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedBinders(db, [
    { id: KB1, type: "general", name: "KB-001" },
    { id: KB2, type: "general", name: "KB-002" },
  ]);
});
afterEach(async () => {
  await db.close();
});

/** The two-lines fixture: one species, one band, two binders — legal, and now ordinary. */
async function seedTwoLines(): Promise<void> {
  await db.exec(`
    insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
      values ('${L1}', '${OWNER}', ${ROOT_DEX}, 'orange', '${KB1}', 'back', 'open'),
             ('${L2}', '${OWNER}', ${ROOT_DEX}, 'orange', '${KB2}', 'back', 'open');
  `);
}

describe("evolutionLineRepo.findByRootBandAndBinder", () => {
  it("answers per BINDER: the line in KB-001 does not occupy KB-002", async () => {
    await db.exec(`
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
        values ('${L1}', '${OWNER}', ${ROOT_DEX}, 'orange', '${KB1}', 'back', 'open');
    `);
    await asOwner(db);
    const client = pgliteClient(db);
    expect(
      (await evolutionLineRepo.findByRootBandAndBinder(client, ROOT_DEX, "orange", KB1))?.id,
    ).toBe(L1);
    // The gap she fell into: this used to return KB-001's line and refuse her KB-002 placement.
    expect(
      await evolutionLineRepo.findByRootBandAndBinder(client, ROOT_DEX, "orange", KB2),
    ).toBeNull();
    await asSuperuser(db);
  });

  it("returns each binder's OWN line when both exist, rather than throwing on the pair", async () => {
    await seedTwoLines();
    await asOwner(db);
    const client = pgliteClient(db);
    // `.maybeSingle()` threw here — verified against this exact fixture before the fix.
    expect(
      (await evolutionLineRepo.findByRootBandAndBinder(client, ROOT_DEX, "orange", KB1))?.id,
    ).toBe(L1);
    expect(
      (await evolutionLineRepo.findByRootBandAndBinder(client, ROOT_DEX, "orange", KB2))?.id,
    ).toBe(L2);
    await asSuperuser(db);
  });

  it("survives a DUPLICATE PAIR inside one binder — the shape the schema permits and maybeSingle threw on", async () => {
    // Two lines, same species, same band, SAME binder: what a race or pre-rule data can leave behind.
    // The app refuses to create this, but reading it must still answer "yes, one lives here".
    await db.exec(`
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
        values ('${L1}', '${OWNER}', ${ROOT_DEX}, 'orange', '${KB1}', 'back', 'open'),
               ('${L2}', '${OWNER}', ${ROOT_DEX}, 'orange', '${KB1}', 'back', 'open');
    `);
    await asOwner(db);
    const found = await evolutionLineRepo.findByRootBandAndBinder(
      pgliteClient(db),
      ROOT_DEX,
      "orange",
      KB1,
    );
    await asSuperuser(db);
    expect(found).not.toBeNull();
    expect([L1, L2]).toContain(found!.id);
  });

  it("matches a line with NO binder with `is null`, not `eq` — which matches nothing in PostgREST", async () => {
    await db.exec(`
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
        values ('${L1}', '${OWNER}', ${ROOT_DEX}, 'orange', null, 'back', 'open');
    `);
    await asOwner(db);
    const client = pgliteClient(db);
    expect(
      (await evolutionLineRepo.findByRootBandAndBinder(client, ROOT_DEX, "orange", null))?.id,
    ).toBe(L1);
    // And it does not leak into a real binder's answer.
    expect(
      await evolutionLineRepo.findByRootBandAndBinder(client, ROOT_DEX, "orange", KB1),
    ).toBeNull();
    await asSuperuser(db);
  });

  it("still distinguishes the band and the species", async () => {
    await seedTwoLines();
    await asOwner(db);
    const client = pgliteClient(db);
    expect(
      await evolutionLineRepo.findByRootBandAndBinder(client, ROOT_DEX, "red", KB1),
    ).toBeNull();
    expect(await evolutionLineRepo.findByRootBandAndBinder(client, 9999, "orange", KB1)).toBeNull();
    await asSuperuser(db);
  });
});
