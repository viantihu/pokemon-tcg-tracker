/**
 * M10 — the sync apply / undo / manual-match paths are TRULY ATOMIC (dev-spec §5 M9 + M10;
 * sync-ui-spec §B.4–§B.5, §A.8). Two layers:
 *
 *  1. RPC layer — apply representative sync payloads (creates + retire-frees-slot + snapshot; an undo
 *     restore; a manual-match promote) through `apply_write_ops` on a fresh Postgres (PGlite) as the
 *     authenticated owner, and prove full-write-on-success + ZERO-rows-on-failure (full rollback),
 *     including the post-write `desired_count` resync.
 *  2. Builder layer — run the REAL executeApply / executeUndo / manualMatch against a fake DbClient
 *     that captures the RPC payload, proving they emit the correct ordered op set (shape + resync
 *     groups) without a DB. The pure decision logic they sit on (reconcile / applyOverrides /
 *     invertSnapshot) is covered by its own suites.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { DbClient, Json, WritePayload } from "@/lib/repo";
import { executeApply, executeUndo, manualMatch } from "@/lib/sync";
import type { AppliedSnapshot } from "@/lib/sync";
import type { ReconcilePlan } from "@/lib/sync/reconcile";
import type { SyncPlanBundle } from "@/lib/sync/pipeline";
import { applyOps, asOwner, asSuperuser, freshRpcDb, OWNER } from "../support/pglite-rpc";

const BINDER = "b0000000-0000-0000-0000-0000000000b1";
const GID = "60000000-0000-0000-0000-000000000001";
const LID = "10000000-0000-0000-0000-000000000001";
const SLOT = "50000000-0000-0000-0000-000000000001";
const C_OLD = "c0000000-0000-0000-0000-0000000000d1";
const C_BULK = "c0000000-0000-0000-0000-0000000000d2";

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
});
afterEach(async () => {
  await db.close();
});

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await db.query<T>(sql, params)).rows;
}

describe("sync apply/undo/manual-match atomicity (RPC layer, PGlite)", () => {
  /** Seed a prior state: group GID with a stale desired_count, a line whose slot C_OLD fills, + a bulk copy. */
  async function seedApplyState(): Promise<void> {
    await db.exec(`
      insert into catalog_card (tcgdex_id, name) values ('cardA', 'Card A');
      insert into binder (id, owner_id, name, type) values ('${BINDER}', '${OWNER}', 'B', 'general');
      insert into presence_group (id, owner_id, catalog_card_id, dex_variant_raw, desired_count)
        values ('${GID}', '${OWNER}', 'cardA', '', 99);
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id)
        values ('${LID}', '${OWNER}', 1, 'red', '${BINDER}');
      insert into copy (id, owner_id, catalog_card_id, variant, dex_variant_raw, presence_group_id, role, binder_id, binder_half, color_band)
        values ('${C_OLD}', '${OWNER}', 'cardA', 'normal', '', '${GID}', 'shelved', '${BINDER}', 'back', 'red');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
        values ('${SLOT}', '${OWNER}', '${LID}', 0, 'Basic', 'filled', '${C_OLD}');
      update copy set line_slot_id = '${SLOT}' where id = '${C_OLD}';
      insert into copy (id, owner_id, catalog_card_id, variant, dex_variant_raw, presence_group_id, role)
        values ('${C_BULK}', '${OWNER}', 'cardA', 'normal', '', '${GID}', 'bulk');
    `);
  }

  const snapshotStub: AppliedSnapshot = {
    version: 1,
    createdAt: "2026-09-08T00:00:00.000Z",
    fastPath: false,
    counts: {
      creates: 1,
      retires: 1,
      variantUpdates: 0,
      parks: 0,
      drops: 0,
      promotions: 0,
      dedupeUpdates: 0,
      unchanged: 0,
    },
    createdCopyIds: [],
    retiredCopies: [],
    slotReverts: [],
    variantReverts: [],
    touchedGroupIds: [GID],
    queue: { parkedIds: [], droppedEntries: [], updatedPrior: [], archivedPrior: [] },
  };

  /** An add of cardA + a retire of C_OLD (frees its slot) + the undo snapshot. resync GID. */
  function applyPayload(newCopyId: string, snapId: string): WritePayload {
    return {
      ops: [
        {
          op: "insert_copy",
          id: newCopyId,
          catalog_card_id: "cardA",
          variant: "normal",
          dex_variant_raw: "",
          presence_group_id: GID,
          role: "bulk",
          acquired_at: "2026-09-08T00:00:00.000Z",
        },
        { op: "update_slot", id: SLOT, patch: { state: "placeholder", copy_id: null } },
        { op: "delete_copy", id: C_OLD },
        { op: "insert_snapshot", id: snapId, snapshot: snapshotStub as unknown as Json },
      ],
      resyncGroupIds: [GID],
    };
  }

  it("apply: writes the add, frees the slot, retires the copy, resyncs desired_count, writes snapshot", async () => {
    await seedApplyState();
    await asOwner(db);
    const newCopy = "c0000000-0000-0000-0000-0000000000e1";
    const snapId = "50000000-0000-0000-0000-0000000000f1";
    await applyOps(db, applyPayload(newCopy, snapId));
    await asSuperuser(db);

    // C_OLD retired, C_BULK + newCopy remain → 2 copies.
    expect((await q<{ n: number }>(`select count(*)::int n from copy`))[0].n).toBe(2);
    expect((await q(`select 1 from copy where id = '${C_OLD}'`)).length).toBe(0);
    // The freed slot reverted to placeholder with no copy.
    const slot = await q<{ state: string; copy_id: string | null }>(
      `select state, copy_id from line_slot where id = '${SLOT}'`,
    );
    expect(slot[0]).toEqual({ state: "placeholder", copy_id: null });
    // desired_count resynced from the stale 99 → live copy count in the group (2).
    const grp = await q<{ desired_count: number }>(
      `select desired_count from presence_group where id = '${GID}'`,
    );
    expect(grp[0].desired_count).toBe(2);
    expect((await q(`select 1 from last_sync_snapshot`)).length).toBe(1);
  });

  it("apply: a poison op mid-batch rolls the WHOLE apply back — nothing changed", async () => {
    await seedApplyState();
    await asOwner(db);
    const good = applyPayload(
      "c0000000-0000-0000-0000-0000000000e2",
      "50000000-0000-0000-0000-00000000dead",
    );
    const poisoned: WritePayload = {
      ops: [
        ...good.ops,
        // References a catalog card that does not exist → FK violation after the earlier ops.
        { op: "insert_copy", id: crypto.randomUUID(), catalog_card_id: "nope", role: "bulk" },
      ],
      resyncGroupIds: [GID],
    };
    await expect(applyOps(db, poisoned)).rejects.toThrow();
    await asSuperuser(db);

    // Everything is exactly as seeded: C_OLD alive, slot still filled by it, count stale, no snapshot.
    expect((await q(`select 1 from copy where id = '${C_OLD}'`)).length).toBe(1);
    const slot = await q<{ state: string; copy_id: string | null }>(
      `select state, copy_id from line_slot where id = '${SLOT}'`,
    );
    expect(slot[0]).toEqual({ state: "filled", copy_id: C_OLD });
    expect(
      (await q<{ dc: number }>(`select desired_count dc from presence_group where id='${GID}'`))[0]
        .dc,
    ).toBe(99);
    expect((await q(`select 1 from last_sync_snapshot`)).length).toBe(1 - 1); // 0
    expect((await q<{ n: number }>(`select count(*)::int n from copy`))[0].n).toBe(2); // only the two seeded
  });

  it("undo: reinserts the retired copy, restores its slot, deletes the created copy, drops the snapshot", async () => {
    // Post-apply state: slot freed (placeholder), C_OLD gone, a created copy present, a snapshot present.
    const created = "c0000000-0000-0000-0000-0000000000c1";
    const snapId = "50000000-0000-0000-0000-00000000feed";
    await db.exec(`
      insert into catalog_card (tcgdex_id, name) values ('cardA', 'Card A');
      insert into binder (id, owner_id, name, type) values ('${BINDER}', '${OWNER}', 'B', 'general');
      insert into presence_group (id, owner_id, catalog_card_id, dex_variant_raw, desired_count)
        values ('${GID}', '${OWNER}', 'cardA', '', 1);
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id)
        values ('${LID}', '${OWNER}', 1, 'red', '${BINDER}');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
        values ('${SLOT}', '${OWNER}', '${LID}', 0, 'Basic', 'placeholder', null);
      insert into copy (id, owner_id, catalog_card_id, variant, dex_variant_raw, presence_group_id, role)
        values ('${created}', '${OWNER}', 'cardA', 'normal', '', '${GID}', 'bulk');
      insert into last_sync_snapshot (id, owner_id, snapshot)
        values ('${snapId}', '${OWNER}', '{}'::jsonb);
    `);
    await asOwner(db);

    const undo: WritePayload = {
      ops: [
        {
          op: "insert_copy",
          id: C_OLD,
          catalog_card_id: "cardA",
          variant: "normal",
          dex_variant_raw: "",
          presence_group_id: GID,
          role: "shelved",
          binder_id: BINDER,
          binder_half: "back",
          color_band: "red",
          line_slot_id: SLOT,
          created_at: "2026-09-01T00:00:00.000Z",
        },
        { op: "update_slot", id: SLOT, patch: { state: "filled", copy_id: C_OLD } },
        { op: "delete_copy", id: created },
        { op: "delete_snapshot", id: snapId },
      ],
      resyncGroupIds: [GID],
    };
    await applyOps(db, undo);
    await asSuperuser(db);

    expect((await q(`select 1 from copy where id = '${C_OLD}'`)).length).toBe(1);
    expect((await q(`select 1 from copy where id = '${created}'`)).length).toBe(0);
    const slot = await q<{ state: string; copy_id: string | null }>(
      `select state, copy_id from line_slot where id = '${SLOT}'`,
    );
    expect(slot[0]).toEqual({ state: "filled", copy_id: C_OLD });
    expect((await q(`select 1 from last_sync_snapshot`)).length).toBe(0);
    expect(
      (await q<{ dc: number }>(`select desired_count dc from presence_group where id='${GID}'`))[0]
        .dc,
    ).toBe(1);
  });

  it("manual-match: learns the set alias, creates the copies, resolves the entry — or rolls back whole", async () => {
    const entryId = "e0000000-0000-0000-0000-0000000000a1";
    await db.exec(`
      insert into catalog_card (tcgdex_id, name, set_id) values ('cardM', 'Card M', 'setM');
      insert into unresolved_entry (id, owner_id, dex_id, dex_variant_raw, quantity, locale, reason, status)
        values ('${entryId}', '${OWNER}', 'xy7-12', '', 2, 'English', 'UNKNOWN_SET', 'WAITING');
    `);
    await asOwner(db);

    const gid = "60000000-0000-0000-0000-0000000000a1";
    const goodOps: WritePayload["ops"] = [
      {
        op: "upsert_set_alias",
        locale: "en",
        dex_code: "xy7",
        tcgdex_set_id: "setM",
        source: "manual",
      },
      {
        op: "insert_presence_group",
        id: gid,
        catalog_card_id: "cardM",
        dex_variant_raw: "",
        desired_count: 0,
      },
      {
        op: "insert_copy",
        id: crypto.randomUUID(),
        catalog_card_id: "cardM",
        variant: "normal",
        dex_variant_raw: "",
        presence_group_id: gid,
        role: "bulk",
      },
      {
        op: "insert_copy",
        id: crypto.randomUUID(),
        catalog_card_id: "cardM",
        variant: "normal",
        dex_variant_raw: "",
        presence_group_id: gid,
        role: "bulk",
      },
      {
        op: "update_unresolved_entry",
        id: entryId,
        patch: { status: "RESOLVED", manual_match_id: "cardM", retry_count: 1 },
      },
    ];

    // Rollback first: a poison trailing op must undo the alias + copies + resolve.
    await expect(
      applyOps(db, {
        ops: [
          ...goodOps,
          { op: "delete_copy", id: crypto.randomUUID() },
          { op: "insert_copy", id: crypto.randomUUID(), catalog_card_id: "ghost", role: "bulk" },
        ],
        resyncGroupIds: [gid],
      }),
    ).rejects.toThrow();
    await asSuperuser(db);
    expect((await q(`select 1 from set_alias`)).length).toBe(0);
    expect((await q<{ n: number }>(`select count(*)::int n from copy`))[0].n).toBe(0);
    expect(
      (await q<{ s: string }>(`select status s from unresolved_entry where id='${entryId}'`))[0].s,
    ).toBe("WAITING");

    // Now the clean apply.
    await asOwner(db);
    await applyOps(db, { ops: goodOps, resyncGroupIds: [gid] });
    await asSuperuser(db);
    expect(
      (
        await q<{ tcgdex_set_id: string }>(
          `select tcgdex_set_id from set_alias where locale='en' and dex_code='xy7'`,
        )
      )[0].tcgdex_set_id,
    ).toBe("setM");
    expect(
      (
        await q<{ n: number }>(`select count(*)::int n from copy where presence_group_id='${gid}'`)
      )[0].n,
    ).toBe(2);
    const e = await q<{ status: string; manual_match_id: string }>(
      `select status, manual_match_id from unresolved_entry where id='${entryId}'`,
    );
    expect(e[0]).toEqual({ status: "RESOLVED", manual_match_id: "cardM" });
    expect(
      (await q<{ dc: number }>(`select desired_count dc from presence_group where id='${gid}'`))[0]
        .dc,
    ).toBe(2);
  });
});

/* --------------------------- builder-emission layer --------------------------- */

/** A thenable query builder over an in-memory row set (eq/is filtering; maybeSingle or await-all). */
class FakeQuery {
  private filters: [string, unknown][] = [];
  constructor(private rows: Record<string, unknown>[]) {}
  select() {
    return this;
  }
  order() {
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push([col, val]);
    return this;
  }
  is(col: string, val: unknown) {
    this.filters.push([col, val]);
    return this;
  }
  private filtered() {
    return this.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v));
  }
  async maybeSingle() {
    return { data: this.filtered()[0] ?? null, error: null };
  }
  then<T>(resolve: (v: { data: unknown; error: null }) => T) {
    return Promise.resolve({ data: this.filtered(), error: null }).then(resolve);
  }
}

class FakeDb {
  rpcCalls: { fn: string; args: { payload: { ops: unknown[]; resync_group_ids: string[] } } }[] =
    [];
  constructor(private store: Record<string, Record<string, unknown>[]>) {}
  from(table: string) {
    return new FakeQuery(this.store[table] ?? []);
  }
  async rpc(fn: string, args: unknown) {
    this.rpcCalls.push({ fn, args: args as (typeof this.rpcCalls)[number]["args"] });
    return { data: null, error: null };
  }
}

function fakeClient(store: Record<string, Record<string, unknown>[]>): {
  db: DbClient;
  captured: () => { ops: Array<Record<string, unknown>>; resync_group_ids: string[] };
} {
  const fake = new FakeDb(store);
  return {
    db: fake as unknown as DbClient,
    captured: () => {
      expect(fake.rpcCalls).toHaveLength(1);
      expect(fake.rpcCalls[0].fn).toBe("apply_write_ops");
      return fake.rpcCalls[0].args.payload as {
        ops: Array<Record<string, unknown>>;
        resync_group_ids: string[];
      };
    },
  };
}

function bundleWithCreates(
  creates: { catalogCardId: string; dexVariantRaw: string; variant: string }[],
): SyncPlanBundle {
  const plan: ReconcilePlan = {
    creates: creates.map((c) => ({ kind: "create", ...c })) as ReconcilePlan["creates"],
    retires: [],
    variantUpdates: [],
    unchanged: 0,
    unresolved: [],
    fastPath: true,
    diff: { entries: [], migrations: [] } as unknown as ReconcilePlan["diff"],
  };
  return {
    mode: "full" as SyncPlanBundle["mode"],
    plan,
    current: [],
    queue: { parks: [], archiveEntryIds: [], dropEntryIds: [], stillWaiting: 0 },
    counts: {
      creates: creates.length,
      retires: 0,
      variantUpdates: 0,
      parks: 0,
      drops: 0,
      promotions: 0,
      dedupeUpdates: 0,
      unchanged: 0,
    },
  };
}

describe("sync builders emit the correct ordered op set (fake DbClient)", () => {
  it("executeApply (adds-only fast path): one group + one copy per add + a snapshot, resync the group", async () => {
    const { db: fake, captured } = fakeClient({
      presence_group: [],
      unresolved_entry: [],
      last_sync_snapshot: [],
    });
    const res = await executeApply(
      fake,
      bundleWithCreates([
        { catalogCardId: "cardA", dexVariantRaw: "", variant: "normal" },
        { catalogCardId: "cardA", dexVariantRaw: "", variant: "normal" },
      ]),
    );

    const { ops, resync_group_ids } = captured();
    const groups = ops.filter((o) => o.op === "insert_presence_group");
    const copies = ops.filter((o) => o.op === "insert_copy");
    const snaps = ops.filter((o) => o.op === "insert_snapshot");
    expect(groups).toHaveLength(1); // both adds share one (cardA,'') group
    expect(copies).toHaveLength(2);
    // UIL-088: an import creates copies IN THE HAUL — it has identified the card, not placed it.
    expect(copies.every((c) => c.role === "haul" && c.catalog_card_id === "cardA")).toBe(true);
    expect(snaps).toHaveLength(1);
    // No retires/variants in a fast path.
    expect(ops.some((o) => o.op === "delete_copy" || o.op === "update_copy")).toBe(false);
    // The new group is resynced, and its id matches the copies' group + the snapshot id is returned.
    expect(resync_group_ids).toEqual([groups[0].id]);
    expect(copies.every((c) => c.presence_group_id === groups[0].id)).toBe(true);
    expect(res.fastPath).toBe(true);
    expect(res.added).toBe(2);
    expect(res.snapshotId).toBe((snaps[0] as { id: string }).id);
  });

  it("executeUndo: builds restore ops from the stored snapshot and deletes it, resyncing its groups", async () => {
    const snap: AppliedSnapshot = {
      version: 1,
      createdAt: "x",
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
      createdCopyIds: ["c-created"],
      retiredCopies: [],
      slotReverts: [],
      variantReverts: [],
      touchedGroupIds: ["g-1"],
      queue: { parkedIds: [], droppedEntries: [], updatedPrior: [], archivedPrior: [] },
    };
    const { db: fake, captured } = fakeClient({
      last_sync_snapshot: [{ id: "snap-1", snapshot: snap }],
    });
    const res = await executeUndo(fake);
    const { ops, resync_group_ids } = captured();
    expect(ops.some((o) => o.op === "delete_copy" && o.id === "c-created")).toBe(true);
    expect(ops.some((o) => o.op === "delete_snapshot" && o.id === "snap-1")).toBe(true);
    expect(resync_group_ids).toEqual(["g-1"]);
    expect(res.removedCopies).toBe(1);
  });

  it("manualMatch (UNKNOWN_SET): emits alias + group + N copies + resolve, in that order", async () => {
    const { db: fake, captured } = fakeClient({
      unresolved_entry: [
        {
          id: "entry-1",
          dex_id: "xy7-12",
          dex_variant_raw: "",
          quantity: 3,
          locale: "English",
          reason: "UNKNOWN_SET",
          retry_count: 0,
        },
      ],
      catalog_card: [{ tcgdex_id: "cardM", set_id: "setM" }],
      presence_group: [],
    });
    const res = await manualMatch(fake, "entry-1", "cardM");
    const { ops, resync_group_ids } = captured();

    expect(ops[0]).toMatchObject({
      op: "upsert_set_alias",
      locale: "en",
      dex_code: "xy7",
      tcgdex_set_id: "setM",
    });
    expect(ops[1]).toMatchObject({ op: "insert_presence_group", catalog_card_id: "cardM" });
    expect(ops.filter((o) => o.op === "insert_copy")).toHaveLength(3);
    const last = ops[ops.length - 1];
    expect(last).toMatchObject({ op: "update_unresolved_entry", id: "entry-1" });
    expect((last.patch as { status: string }).status).toBe("RESOLVED");
    expect(resync_group_ids).toHaveLength(1);
    expect(res.created).toBe(3);
    expect(res.learnedAlias).toEqual({ locale: "en", dexCode: "xy7", tcgdexSetId: "setM" });
  });
});
