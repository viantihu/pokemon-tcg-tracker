/**
 * UIL-050 wiring check (QA on #171): `strandedSections` and `readShelvedBySection` are both tested in
 * isolation (tests/surfaces/stranded-sections.test.ts, tests/settings/binder-resize-guard.test.ts),
 * but nothing proved `saveBinder` itself actually calls them — the same shape as the applyDecision
 * pass-through gap on #146: the comparison is correct and nothing invokes it, so the whole suite stays
 * green even if the guard is deleted from the action. This exercises `saveBinder` directly.
 *
 * `getOwnerContext` needs a real Next.js request (cookies + a Supabase session) that does not exist
 * under vitest, so it is mocked here to hand back a PGlite-backed `DbClient` instead — test-file-local,
 * nothing in lib/plan/* is edited. `@/lib/plan/session` (not the `@/lib/plan` barrel) is the mock
 * target: `saveBinder` imports `getOwnerContext` via the barrel, which re-exports it from `./session`,
 * so mocking the narrower module intercepts it without having to re-provide the barrel's many other
 * exports. `db` is read INSIDE the mocked `getOwnerContext`, never at the factory's own top level, so
 * it is never touched before `vi.mock`'s hoisting has run and `beforeEach` has assigned it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asOwner, freshRpcDb, OWNER } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";
import { saveBinder } from "@/app/(ui)/settings/actions";

let db: PGlite;

vi.mock("@/lib/plan/session", () => ({
  getOwnerContext: async () => ({ db: pgliteClient(db), ownerId: OWNER }),
}));

const BINDER = "b0000000-0000-0000-0000-000000000041";

beforeEach(async () => {
  db = await freshRpcDb();
  await db.query(
    `insert into catalog_card (tcgdex_id, name) values ('cardA','cardA'), ('cardB','cardB')
     on conflict (tcgdex_id) do nothing`,
  );
  await db.query(
    `insert into binder (id, owner_id, name, type, pages, pockets_per_page, back_half_start_page)
     values ($1, $2, 'Binder A', 'general', 40, 9, 21)`,
    [BINDER, OWNER],
  );
  // Two cards shelved in the back half: back = pages 21-40 = 20 pages x 9 = 180 pockets today.
  await db.query(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half)
     select gen_random_uuid(), $1, c, 'shelved', $2, 'back'
     from unnest(array['cardA','cardB']) as c`,
    [OWNER, BINDER],
  );
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

describe("saveBinder actually calls the UIL-050 guard", () => {
  it("refuses a shrink that would strand shelved back-half cards, and writes nothing", async () => {
    const res = await saveBinder({
      id: BINDER,
      name: "Binder A",
      type: "general",
      pages: 20, // divider at 21 is now past the last page -> back capacity 0
      pocketsPerPage: 9,
      backHalfStartPage: 21,
      isActive: false,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("back half");

    const row = await db.query<{ pages: number }>(`select pages from binder where id = $1`, [
      BINDER,
    ]);
    expect(row.rows[0].pages).toBe(40); // unchanged — the block happened before any write
  });

  it("still allows a resize that keeps enough room", async () => {
    const res = await saveBinder({
      id: BINDER,
      name: "Binder A",
      type: "general",
      pages: 22, // back = 1 page x 9 = 9 pockets, still fits 2 cards
      pocketsPerPage: 9,
      backHalfStartPage: 21,
      isActive: false,
    });
    expect(res.ok).toBe(true);

    const row = await db.query<{ pages: number }>(`select pages from binder where id = $1`, [
      BINDER,
    ]);
    expect(row.rows[0].pages).toBe(22);
  });
});
