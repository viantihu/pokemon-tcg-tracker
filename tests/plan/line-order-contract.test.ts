/**
 * UIL-084, point 6's other half — `loadPlanContext` hands the engine its lines OLDEST FIRST.
 *
 * `existingLineSlot` breaks a tie between two lines of one family by falling back to list order (see
 * tests/engine/existing-line-tie-break.test.ts), which is only a meaningful rule if the list is
 * actually ordered. `evolutionLineRepo.list` is a plain `select *` with no ORDER BY, so it was not:
 * the engine's answer depended on whatever order Postgres returned, and two lines for one family are
 * ordinary now that uniqueness is per binder.
 *
 * The fixture inserts the rows so that the NEWER line sorts FIRST by primary key — the order an
 * unordered read is most likely to hand back — so the sort has to actually run for this to pass.
 *
 * Real Postgres (PGlite) through the real `loadPlanContext`, not a hand-built context: the ordering is a
 * property of the loader, and a fixture that sorted its own input would prove nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { clearCatalogCache, loadPlanContext } from "@/lib/plan";
import { OWNER, asOwner, asSuperuser, freshRpcDb, seedBinders } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const KB1 = "b0000000-0000-0000-0000-00000000aa01";
const KB2 = "b0000000-0000-0000-0000-00000000aa02";
/** `A…` sorts BEFORE `F…` by id, and is inserted SECOND — id order and age order disagree. */
const NEWER = "10000000-0000-0000-0000-00000000aa01";
const OLDER = "f0000000-0000-0000-0000-00000000aa02";
const ROOT_DEX = 9481;

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  clearCatalogCache();
  await seedBinders(db, [
    { id: KB1, type: "general", name: "KB-001" },
    { id: KB2, type: "general", name: "KB-002" },
  ]);
  await db.query(
    `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from, card_class)
       values ('toedscool', 'Toedscool', $1, '{Fighting}', 'Basic', null, 'standard')`,
    [[ROOT_DEX]],
  );
});
afterEach(async () => {
  await db.close();
});

describe("loadPlanContext orders lines oldest-first (UIL-084)", () => {
  it("puts the older line first even though the newer one sorts ahead of it by id", async () => {
    await db.exec(`
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status, created_at)
        values ('${OLDER}', '${OWNER}', ${ROOT_DEX}, 'orange', '${KB1}', 'back', 'open', '2026-09-01T00:00:00Z');
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status, created_at)
        values ('${NEWER}', '${OWNER}', ${ROOT_DEX}, 'orange', '${KB2}', 'back', 'open', '2026-09-20T00:00:00Z');
    `);
    await asOwner(db);
    const pc = await loadPlanContext(pgliteClient(db));
    await asSuperuser(db);

    expect(pc.ctx.lines.map((l) => l.id)).toEqual([OLDER, NEWER]);
  });

  it("breaks an EXACT timestamp tie by id, so the order is total and not merely usually-stable", async () => {
    await db.exec(`
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status, created_at)
        values ('${NEWER}', '${OWNER}', ${ROOT_DEX}, 'orange', '${KB2}', 'back', 'open', '2026-09-10T00:00:00Z'),
               ('${OLDER}', '${OWNER}', ${ROOT_DEX}, 'orange', '${KB1}', 'back', 'open', '2026-09-10T00:00:00Z');
    `);
    await asOwner(db);
    const pc = await loadPlanContext(pgliteClient(db));
    await asSuperuser(db);

    // Same instant → id decides, ascending. NEWER's id starts with '1', OLDER's with 'f'.
    expect(pc.ctx.lines.map((l) => l.id)).toEqual([NEWER, OLDER]);
  });
});
