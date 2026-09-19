/**
 * UIL-032 — re-pointing a collection at another binder must invalidate a cached plan.
 *
 * The stamp used to carry collections as `[id, targetCount]`; same id, same count, different
 * `current_binder_ids` left it unchanged, so a plan cached before a re-point stayed "valid" against
 * state that had moved (the in-place-edit gap #44/#48 closed for copies, one field over). This drives
 * the REAL `loadPlanFingerprint` against PGlite: seed, stamp, re-point, stamp again — different.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { loadPlanFingerprint } from "@/lib/plan";
import {
  asOwner,
  asSuperuser,
  freshRpcDb,
  seedBinders,
  seedCollections,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const B1 = "1c000000-0000-0000-0000-0000000000a1";
const B2 = "1c000000-0000-0000-0000-0000000000a2";
const COL = "c0110000-0000-0000-0000-0000000000a1";

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedBinders(db, [
    { id: B1, type: "specialty", name: "Specialty A" },
    { id: B2, type: "specialty", name: "Specialty B" },
  ]);
  await db.exec(`insert into catalog_card (tcgdex_id, name) values ('cardA', 'Card A');`);
  await seedCollections(db, [
    { id: COL, name: "Matsuno", targetCatalogCardIds: ["cardA"], currentBinderIds: [B1] },
  ]);
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

describe("UIL-032 · the plan fingerprint moves when a collection is re-pointed at another binder", () => {
  it("same collection, same target count, different binder → a different stamp", async () => {
    const client = pgliteClient(db);
    const before = await loadPlanFingerprint(client, []);

    await asSuperuser(db);
    await db.query(`update collection set current_binder_ids = array[$1::uuid] where id = $2`, [
      B2,
      COL,
    ]);
    await asOwner(db);

    const after = await loadPlanFingerprint(client, []);
    expect(after).not.toBe(before);
    // And it is the COLLECTION entry that moved it (the binders section lists both binders throughout):
    // [id, targetCount, currentBinderIds] reads B1 before and B2 after, with id and count unchanged.
    const entry = (stamp: string) => JSON.parse(stamp).collections[0] as [string, number, string[]];
    expect(entry(before)).toEqual([COL, 1, [B1]]);
    expect(entry(after)).toEqual([COL, 1, [B2]]);
  });

  it("is stable when nothing moved — the stamp is not just 'different every time'", async () => {
    const client = pgliteClient(db);
    expect(await loadPlanFingerprint(client, [])).toBe(await loadPlanFingerprint(client, []));
  });
});
