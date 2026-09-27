/**
 * UIL-127a — end to end on real Postgres (PGlite, every migration): an account with NO binder shelves nothing.
 *
 * Haul Plan's Done for a waiting card, and Backfill's front-half save, are both refused in her words before any
 * write; the card stays waiting. Backfill also refuses a binder id that is not one of hers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { DbClient } from "@/lib/repo";
import { clearCatalogCache, commitCardPlacement } from "@/lib/plan";
import { commitFrontHalf } from "@/lib/backfill";
import { NO_BINDER } from "@/lib/plan/no-binder";
import { NEST_BALL_SV01_181 } from "../engine/fixtures";
import {
  asOwner,
  asSuperuser,
  freshRpcDb,
  haulRow,
  OWNER,
  seedBinders,
  seedCatalogCardsFull,
  seedHaulRows,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

vi.mock("@/lib/plan/session", () => ({
  getOwnerContext: async () => ({ db: pgliteClient(db) as DbClient, ownerId: OWNER }),
  SEEDED_OWNER_ID: "00000000-0000-0000-0000-000000000001",
}));

const DRAFT = haulRow("d0000000-0000-4000-8000-0000000b1d01", NEST_BALL_SV01_181.tcgdexId);
const NOT_HERS = "1c000000-0000-0000-0000-00000000dead";

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  clearCatalogCache();
  await seedCatalogCardsFull(db, [NEST_BALL_SV01_181]);
  await seedHaulRows(db, [DRAFT]);
});
afterEach(async () => {
  await db.close();
});

async function roleOf(id: string): Promise<string> {
  await asSuperuser(db);
  const r = await db.query<{ role: string }>(`select role from copy where id = $1`, [id]);
  return r.rows[0].role;
}

describe("UIL-127a · no binder, nothing shelved", () => {
  it("Haul Plan's Done is refused in her words, and the card stays waiting", async () => {
    await asOwner(db);
    await expect(commitCardPlacement(pgliteClient(db), { card: DRAFT })).rejects.toThrow(
      NO_BINDER.refusal(NEST_BALL_SV01_181.name),
    );
    expect(await roleOf(DRAFT.existingCopyId!)).toBe("haul");
  });

  it("…and once she adds a binder, the same Done shelves it there", async () => {
    await seedBinders(db, [{ id: "1c000000-0000-0000-0000-0000000000b1", type: "general" }]);
    await asOwner(db);
    await commitCardPlacement(pgliteClient(db), { card: DRAFT });
    expect(await roleOf(DRAFT.existingCopyId!)).toBe("shelved");
  });

  it("Backfill's front-half save naming a binder she does not have is refused before any write", async () => {
    await asOwner(db);
    await expect(
      commitFrontHalf(pgliteClient(db), OWNER, {
        binderId: NOT_HERS,
        half: "front",
        cards: [{ tcgdexId: NEST_BALL_SV01_181.tcgdexId, dexVariantRaw: "Normal" }],
      }),
    ).rejects.toThrow(/has no binder to go to/);
    expect(await roleOf(DRAFT.existingCopyId!)).toBe("haul");
  });

  it("the plan she opens says so: runHaulPlan reports an account with no binder, and not once she has one", async () => {
    const { runHaulPlan } = await import("@/app/(ui)/plan/actions");
    await asOwner(db);
    expect((await runHaulPlan([DRAFT])).noBinders).toBe(true);
    await seedBinders(db, [{ id: "1c000000-0000-0000-0000-0000000000b1", type: "general" }]);
    await asOwner(db);
    expect((await runHaulPlan([DRAFT])).noBinders).toBe(false);
  });
});
