/**
 * UIL-035 (third site), at the ACTION level. #201 made `lookupAnswer` return a result instead of
 * throwing, and pinned the screen's three states — but QA found that mutating the action's `catch` back
 * to "not found" still passed every test, because none of them called the action. These do.
 *
 * `getOwnerContext` is mocked to a switchable implementation: one that rejects (the database is down,
 * the session is gone) and one that hands back a PGlite-backed client (real reads, real RLS), the
 * technique of tests/coll/collection-sort-order.test.ts. What is pinned is the contract every caller
 * relies on: a failure is `{ ok: false, error }` carrying the reason, an unknown card is
 * `{ ok: true, answer: null }`, and nothing else may ever say "not found".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { DbClient } from "@/lib/repo";
import { lookupAnswer, lookupMoveOptions, moveFromLookup } from "@/app/(ui)/look/actions";
import { asOwner, freshRpcDb, OWNER, seedBinders } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

type Ctx = { db: DbClient; ownerId: string };
let ownerContext: () => Promise<Ctx> = async () => {
  throw new Error("test did not set an owner context");
};

vi.mock("@/lib/plan/session", () => ({
  getOwnerContext: () => ownerContext(),
  SEEDED_OWNER_ID: "00000000-0000-0000-0000-000000000001",
}));

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedBinders(db, [
    { id: "1c000000-0000-0000-0000-0000000000b1", type: "general", name: "Main" },
  ]);
  await db.exec(`
    insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id, set_card_count_official, dex_id, types, stage)
      values ('sv03-027', 'Charmeleon', 'sv03', 'Obsidian Flames', '027', 197, '{5}', '{Fire}', 'Stage1');
  `);
  await asOwner(db);
  ownerContext = async () => ({ db: pgliteClient(db), ownerId: OWNER });
});
afterEach(async () => {
  await db.close();
});

describe("UIL-035 · lookupAnswer never reports a failure as 'not found'", () => {
  it("the database not answering → { ok: false } with the reason, NOT answer: null", async () => {
    ownerContext = async () => {
      throw new Error("Could not reach the database");
    };
    const res = await lookupAnswer("sv03-027");
    expect(res).toEqual({ ok: false, error: "Could not reach the database" });
  });

  it("a card the mirror does not have → { ok: true, answer: null } — the ONLY 'not found'", async () => {
    const res = await lookupAnswer("nope-000");
    expect(res).toEqual({ ok: true, answer: null, copies: [] });
  });

  it("a card the mirror has → { ok: true, answer } with the full collector number", async () => {
    const res = await lookupAnswer("sv03-027");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.answer?.card.name).toBe("Charmeleon");
    expect(res.answer?.card.localId).toBe("027");
    expect(res.answer?.owned).toBe(false);
    expect(res.copies).toEqual([]);
  });
});

describe("UIL-051 · the move actions fail the same honest way", () => {
  it("lookupMoveOptions: the database not answering → { ok: false } with the reason", async () => {
    ownerContext = async () => {
      throw new Error("session expired");
    };
    expect(await lookupMoveOptions()).toEqual({ ok: false, error: "session expired" });
  });

  it("moveFromLookup: a copy that is gone → { ok: false } naming it, and no lookup is attempted", async () => {
    const res = await moveFromLookup(
      "c0000000-0000-0000-0000-0000000000ff",
      { kind: "bulk" },
      "sv03-027",
    );
    expect(res).toEqual({ ok: false, error: "That card is no longer in the collection." });
  });
});
