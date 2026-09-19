/**
 * UIL-046 — a retry sweep is RECORDED on the rows it examined and did not promote, and only on those.
 *
 * Behavioural, on real Postgres. The existing coverage in retry-telemetry-and-alias-guard.test.ts pins
 * the SOURCE of `stampRetrySweep` (regex over actions.ts), which a short-circuited stamp would still
 * pass; QA flagged that gap when merging #183. This drives the real `retryUnresolvedNow` end to end —
 * pipeline, promotion, stamp — against PGlite with the auth seam mocked (the technique of
 * tests/coll/collection-sort-order.test.ts) and reads the rows back.
 *
 * The contract under test, in her terms: after "Retry now", every card that stayed waiting shows it was
 * retried (a retry time, and one more retry counted); a card that resolved is placed, not counted as a
 * failed retry; dismissed and already-resolved rows are not touched; and the sweep records itself even
 * when nothing resolved at all — the case that used to leave no trace.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asOwner, asSuperuser, freshRpcDb, OWNER } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";
import { retryUnresolvedNow } from "@/app/(ui)/sync/actions";

let db: PGlite;

vi.mock("@/lib/plan/session", () => ({
  getOwnerContext: async () => ({ db: pgliteClient(db), ownerId: OWNER }),
  SEEDED_OWNER_ID: "00000000-0000-0000-0000-000000000001",
}));

const IDS = {
  resolves: "e0000000-0000-0000-0000-0000000000a1", // xy7-12 — the mirror carries it once seeded
  unknownCard: "e0000000-0000-0000-0000-0000000000a2", // xy7-99 — set known, no such number
  unknownSet: "e0000000-0000-0000-0000-0000000000a3", // zz9-1 — no such set, no name match
  dismissed: "e0000000-0000-0000-0000-0000000000a4",
  resolved: "e0000000-0000-0000-0000-0000000000a5",
};

type Snap = { status: string; retry_count: number; last_retry_sync: string | null };

async function rows(): Promise<Record<string, Snap>> {
  const r = await db.query<{ id: string } & Snap>(
    `select id, status, retry_count, last_retry_sync::text from unresolved_entry`,
  );
  return Object.fromEntries(
    r.rows.map((x) => [
      x.id,
      { status: x.status, retry_count: x.retry_count, last_retry_sync: x.last_retry_sync },
    ]),
  );
}

/**
 * The queue before a sweep. `dex_set_name` deliberately matches no catalog `set_name`, so a miss stays a
 * miss rather than learning a name-resolved alias (which is not this test's subject). `unknownCard`
 * starts at retry_count 3 so an increment can be told from an overwrite.
 */
async function seedQueue(withResolvableCard: boolean): Promise<void> {
  if (withResolvableCard) {
    await db.exec(`
      insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id, types)
      values ('xy7-012', 'Card A', 'xy7', 'Ancient Origins', '012', '{Fire}');
    `);
  }
  const insert = (
    id: string,
    dexId: string,
    reason: string,
    status: string,
    retryCount: number,
    quantity = 1,
  ) =>
    db.query(
      `insert into unresolved_entry
         (id, owner_id, dex_id, dex_set_name, dex_variant_raw, quantity, locale, reason, status, retry_count)
       values ($1, $2, $3, 'Nowhere Set', '', $4, 'English', $5, $6, $7)`,
      [id, OWNER, dexId, quantity, reason, status, retryCount],
    );
  await insert(IDS.resolves, "xy7-12", "UNKNOWN_SET", "WAITING", 0, 2);
  await insert(IDS.unknownCard, "xy7-99", "UNKNOWN_CARD", "WAITING", 3);
  await insert(IDS.unknownSet, "zz9-1", "UNKNOWN_SET", "WAITING", 0);
  await insert(IDS.dismissed, "zz9-2", "UNKNOWN_SET", "DISMISSED", 0);
  await insert(IDS.resolved, "zz9-3", "UNKNOWN_SET", "RESOLVED", 1);
}

beforeEach(async () => {
  db = await freshRpcDb();
});
afterEach(async () => {
  await db.close();
});

describe("UIL-046 · a retry sweep stamps what stayed waiting, and only that", () => {
  it("one promotes, two stay: the two are stamped, the promoted one is placed instead", async () => {
    await seedQueue(true);
    await asOwner(db);
    const res = await retryUnresolvedNow();
    await asSuperuser(db);

    expect(res).toEqual({ ok: true, promoted: 1, applied: true, stamped: 2 });

    const r = await rows();
    // Stayed waiting → retried: a time recorded, one more retry counted (3 → 4, 0 → 1: an increment).
    expect(r[IDS.unknownCard].status).toBe("WAITING");
    expect(r[IDS.unknownCard].retry_count).toBe(4);
    expect(r[IDS.unknownCard].last_retry_sync).not.toBeNull();
    expect(r[IDS.unknownSet].status).toBe("WAITING");
    expect(r[IDS.unknownSet].retry_count).toBe(1);
    expect(r[IDS.unknownSet].last_retry_sync).not.toBeNull();
    // One sweep, one timestamp.
    expect(r[IDS.unknownSet].last_retry_sync).toBe(r[IDS.unknownCard].last_retry_sync);

    // Promoted → RESOLVED by the apply, NOT stamped as a failed retry: retry_count untouched.
    expect(r[IDS.resolves].status).toBe("RESOLVED");
    expect(r[IDS.resolves].retry_count).toBe(0);
    // …and really placed: quantity 2 → two unplaced copies of the matched card.
    const copies = await db.query<{ n: number }>(
      `select count(*)::int n from copy where catalog_card_id = 'xy7-012'`,
    );
    expect(copies.rows[0].n).toBe(2);

    // Out of the sweep's sight, untouched.
    expect(r[IDS.dismissed]).toEqual({
      status: "DISMISSED",
      retry_count: 0,
      last_retry_sync: null,
    });
    expect(r[IDS.resolved]).toEqual({ status: "RESOLVED", retry_count: 1, last_retry_sync: null });
  });

  it("nothing resolves: no apply, no copies — and every waiting row is still stamped", async () => {
    await seedQueue(false);
    await asOwner(db);
    const res = await retryUnresolvedNow();
    await asSuperuser(db);

    expect(res).toEqual({ ok: true, promoted: 0, applied: false, stamped: 3 });

    const r = await rows();
    for (const id of [IDS.resolves, IDS.unknownCard, IDS.unknownSet]) {
      expect(r[id].status).toBe("WAITING");
      expect(r[id].last_retry_sync).not.toBeNull();
    }
    expect(r[IDS.resolves].retry_count).toBe(1);
    expect(r[IDS.unknownCard].retry_count).toBe(4);
    expect(r[IDS.unknownSet].retry_count).toBe(1);
    expect(r[IDS.dismissed].last_retry_sync).toBeNull();
    expect(r[IDS.resolved].last_retry_sync).toBeNull();

    expect((await db.query<{ n: number }>(`select count(*)::int n from copy`)).rows[0].n).toBe(0);
    // No apply ran, so no undo point was written either.
    expect(
      (await db.query<{ n: number }>(`select count(*)::int n from last_sync_snapshot`)).rows[0].n,
    ).toBe(0);
  });

  it("a second sweep counts a second retry rather than overwriting the first", async () => {
    await seedQueue(false);
    await asOwner(db);
    await retryUnresolvedNow();
    await asSuperuser(db);
    const first = (await rows())[IDS.unknownSet];

    await asOwner(db);
    const res = await retryUnresolvedNow();
    await asSuperuser(db);
    expect(res).toEqual({ ok: true, promoted: 0, applied: false, stamped: 3 });

    const second = (await rows())[IDS.unknownSet];
    expect(first.retry_count).toBe(1);
    expect(second.retry_count).toBe(2);
    expect(second.last_retry_sync! >= first.last_retry_sync!).toBe(true);
  });

  it("an empty queue is a no-op sweep, reported as such", async () => {
    await asOwner(db);
    expect(await retryUnresolvedNow()).toEqual({
      ok: true,
      promoted: 0,
      applied: false,
      stamped: 0,
    });
  });
});
