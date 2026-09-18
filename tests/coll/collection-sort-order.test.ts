/**
 * UIL-052 — `loadCollHub` presents collections most-recently-modified first. `updated_at` bumping
 * itself is covered end-to-end against real write paths in `collection-updated-at.test.ts`; this
 * proves the READ side actually orders by it, which nothing else exercises.
 *
 * `getOwnerContext` needs a real Next.js request that does not exist under vitest, so it is mocked
 * to hand back a PGlite-backed `DbClient` instead — the same technique as
 * `tests/settings/save-binder-guard.test.ts`. Test-file-local; nothing in lib/plan/* is edited.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asOwner, freshRpcDb, OWNER, seedBinders, seedCollections } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";
import { loadCollHub } from "@/app/(ui)/coll/actions";

let db: PGlite;

vi.mock("@/lib/plan/session", () => ({
  getOwnerContext: async () => ({ db: pgliteClient(db), ownerId: OWNER }),
}));

const SPEC = "b0000000-0000-0000-0000-0000000000f5";
const OLDEST = "a0000000-0000-0000-0000-0000000000f1";
const MIDDLE = "a0000000-0000-0000-0000-0000000000f2";
const NEWEST = "a0000000-0000-0000-0000-0000000000f3";

beforeEach(async () => {
  db = await freshRpcDb();
  await seedBinders(db, [{ id: SPEC, type: "specialty", name: "Specialty A" }]);
  // Created in an order that does NOT match the modification order below, so a passing test can't be
  // accidentally riding on insertion/created_at order instead of updated_at.
  await seedCollections(db, [
    { id: OLDEST, name: "Oldest", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
    { id: NEWEST, name: "Newest", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
    { id: MIDDLE, name: "Middle", targetCatalogCardIds: [], currentBinderIds: [SPEC] },
  ]);
  // Stagger updated_at explicitly — oldest touched longest ago, newest touched most recently.
  await db.query(`update collection set updated_at = now() - interval '3 hours' where id = $1`, [
    OLDEST,
  ]);
  await db.query(`update collection set updated_at = now() - interval '2 hours' where id = $1`, [
    MIDDLE,
  ]);
  await db.query(`update collection set updated_at = now() - interval '1 hour' where id = $1`, [
    NEWEST,
  ]);
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

describe("loadCollHub orders collections by updated_at, most recent first", () => {
  it("returns Newest, Middle, Oldest regardless of creation order", async () => {
    const data = await loadCollHub();
    expect(data.collections.map((c) => c.name)).toEqual(["Newest", "Middle", "Oldest"]);
  });
});
