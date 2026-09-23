/**
 * UIL-099 E5 — one preview, applied once.
 *
 * The sync bundle round-trips through the browser: preview hands it over, Apply sends it back. Nothing on
 * the server checked that the state it was computed against was still the state it was applied to, so two
 * tabs, a double click, or a retry after a lost response applied the same `creates` twice — every card in
 * the import, doubled. Her first import after the Testing wipe is about 700 cards.
 *
 * The real pipeline against real Postgres (PGlite): a real Dex export in its real physical format
 * (UTF-16LE with a BOM), the real `runSyncPipeline` + `executeApply`, the real `apply_write_ops` RPC, as the
 * authenticated owner.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { executeApply, executeUndo } from "@/lib/sync";
import { runSyncPipeline } from "@/lib/sync/pipeline";
import {
  snapshotIdForBase,
  SyncAlreadyAppliedError,
  SyncStaleError,
  undoableSnapshot,
} from "@/lib/sync/apply-guard";
import { asOwner, asSuperuser, freshRpcDb, OWNER } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const HEADER =
  "Type;Category;Locale;Series;Set;Id;Number;Name;Variant;Rarity;Illustrator;Quantity;Price;Notes";
const ROW_A =
  "collection;Pokemon;English;SV;Obsidian Flames;sv03-026;026;Charmander;Normal;Common;;2;;";
const ROW_B =
  "collection;Pokemon;English;SV;Obsidian Flames;sv03-027;027;Charmeleon;Normal;Common;;1;;";

function exportBytes(rows: string[]): Uint8Array {
  const body = Buffer.from(`${HEADER}\n${rows.join("\n")}\n`, "utf16le");
  return Uint8Array.from([0xff, 0xfe, ...body]);
}

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await db.exec(`
    insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id, types, stage, dex_id)
      values ('sv03-026', 'Charmander', 'sv03', 'Obsidian Flames', '026', '{Fire}', 'Basic', '{4}'),
             ('sv03-027', 'Charmeleon', 'sv03', 'Obsidian Flames', '027', '{Fire}', 'Stage1', '{5}');
  `);
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

async function copyCount(): Promise<number> {
  await asSuperuser(db);
  const r = await db.query<{ n: number }>(`select count(*)::int n from copy`);
  await asOwner(db);
  return r.rows[0].n;
}

describe("UIL-099 E5 · the same preview applied twice adds its cards ONCE", () => {
  it("a retry after a lost response writes nothing and says it was already applied", async () => {
    const client = pgliteClient(db);
    const { bundle } = await runSyncPipeline(client, exportBytes([ROW_A]));
    expect(bundle.plan.creates.length).toBeGreaterThan(0);

    await executeApply(client, bundle, OWNER);
    expect(await copyCount()).toBe(2); // Charmander ×2

    // The same bundle, again — exactly what the browser sends when a response is lost and she presses
    // Apply once more. PRE-FIX this created two MORE copies.
    await expect(executeApply(client, bundle, OWNER)).rejects.toThrow(SyncAlreadyAppliedError);
    await expect(executeApply(client, bundle, OWNER)).rejects.toThrow(/already been applied/);
    expect(await copyCount()).toBe(2);
  });

  it("two tabs: two previews of one state, the second apply writes nothing", async () => {
    const client = pgliteClient(db);
    const tab1 = (await runSyncPipeline(client, exportBytes([ROW_A]))).bundle;
    const tab2 = (await runSyncPipeline(client, exportBytes([ROW_A]))).bundle;
    // Two different bundles objects, one base: the collection's sync state when both were previewed.
    expect(tab1.baseSnapshotId).toBe(tab2.baseSnapshotId);

    await executeApply(client, tab1, OWNER);
    await expect(executeApply(client, tab2, OWNER)).rejects.toThrow(SyncAlreadyAppliedError);
    expect(await copyCount()).toBe(2);
  });

  it("two applies racing on the same base: exactly one lands — the primary key, not the read, decides", async () => {
    // Both start before either writes, so both pass the freshness read. The derived snapshot id is what
    // stops the second: both insert the SAME id, and the second transaction rolls back whole.
    const client = pgliteClient(db);
    const { bundle } = await runSyncPipeline(client, exportBytes([ROW_A]));
    const results = await Promise.allSettled([
      executeApply(client, bundle, OWNER),
      executeApply(client, bundle, OWNER),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(SyncAlreadyAppliedError);
    expect(await copyCount()).toBe(2); // not 4
  });

  it("racing on an import that adds to EXISTING groups: the snapshot's own key is what refuses the second", async () => {
    // The case above creates a new presence group, and the loser trips THAT unique key before reaching the
    // snapshot insert. Here the group already exists (Charmander ×2 → ×3), so no other key collides and the
    // derived snapshot primary key is the only thing standing between her and a doubled import.
    const client = pgliteClient(db);
    await executeApply(client, (await runSyncPipeline(client, exportBytes([ROW_A]))).bundle, OWNER);
    const more = ROW_A.replace(";Common;;2;;", ";Common;;3;;");
    const { bundle } = await runSyncPipeline(client, exportBytes([more]));
    expect(bundle.plan.creates).toHaveLength(1);

    const results = await Promise.allSettled([
      executeApply(client, bundle, OWNER),
      executeApply(client, bundle, OWNER),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(SyncAlreadyAppliedError);
    expect(await copyCount()).toBe(3); // not 4
  });

  it("a bundle from before a LATER import is refused as stale — at any depth", async () => {
    const client = pgliteClient(db);
    const old = (await runSyncPipeline(client, exportBytes([ROW_A]))).bundle;
    await executeApply(client, old, OWNER);
    const next = (await runSyncPipeline(client, exportBytes([ROW_A, ROW_B]))).bundle;
    await executeApply(client, next, OWNER);
    const before = await copyCount();

    // Two applies later, the first bundle's base is long gone. Only checking "has this derived id been
    // used" would miss this, because each apply deletes the snapshot before it — so the base must still be
    // the LATEST, not merely unused.
    await expect(executeApply(client, old, OWNER)).rejects.toThrow(SyncStaleError);
    expect(await copyCount()).toBe(before);
  });
});

describe("UIL-099 E5 · a legitimate apply is never blocked", () => {
  it("a fresh preview after an apply applies normally", async () => {
    const client = pgliteClient(db);
    await executeApply(client, (await runSyncPipeline(client, exportBytes([ROW_A]))).bundle, OWNER);
    const second = (await runSyncPipeline(client, exportBytes([ROW_A, ROW_B]))).bundle;
    await executeApply(client, second, OWNER);
    expect(await copyCount()).toBe(3); // Charmander ×2 + Charmeleon
  });

  it("after an UNDO, a fresh preview of the same file applies again", async () => {
    // Undo deletes the snapshot, so the collection is back at "no sync state" and a new preview has a
    // null base again. Re-importing the same file after undoing it is a real thing she does.
    const client = pgliteClient(db);
    await executeApply(client, (await runSyncPipeline(client, exportBytes([ROW_A]))).bundle, OWNER);
    await executeUndo(client);
    expect(await copyCount()).toBe(0);

    await executeApply(client, (await runSyncPipeline(client, exportBytes([ROW_A]))).bundle, OWNER);
    expect(await copyCount()).toBe(2);
  });
});

describe("UIL-099 E5 · the derived key", () => {
  const BASE = "11111111-1111-4111-8111-111111111111";

  it("is deterministic, uuid-shaped, and differs by base", () => {
    expect(snapshotIdForBase(BASE, "o")).toBe(snapshotIdForBase(BASE, "o"));
    expect(snapshotIdForBase(BASE, "o")).not.toBe(snapshotIdForBase(null, "o"));
    expect(snapshotIdForBase(BASE, "o")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("scopes the no-snapshot-yet case to the owner, so two owners' FIRST imports never collide", () => {
    expect(snapshotIdForBase(null, "owner-a")).not.toBe(snapshotIdForBase(null, "owner-b"));
    // With a real base the owner is irrelevant — the base id is already unique across owners.
    expect(snapshotIdForBase(BASE, "owner-a")).toBe(snapshotIdForBase(BASE, "owner-b"));
  });
});

/**
 * The Tech Lead's review of #325 (probes adopted as regression tests), plus the B2 interleaving.
 */
describe("UIL-099 E5 · review: Undo must not reopen the double apply (B1)", () => {
  it("import A, import B, undo B, then a stale tab's null-base preview of A is REFUSED — not doubled", async () => {
    // With no tombstone, Undo left zero snapshots: freshness key null, the same as "never synced", so the
    // stale tab passed and applied A again on top of itself (2 -> 4 copies).
    const client = pgliteClient(db);
    const staleTab = (await runSyncPipeline(client, exportBytes([ROW_A]))).bundle; // never applied
    await executeApply(client, (await runSyncPipeline(client, exportBytes([ROW_A]))).bundle, OWNER);
    await executeApply(
      client,
      (await runSyncPipeline(client, exportBytes([ROW_A, ROW_B]))).bundle,
      OWNER,
    );
    await executeUndo(client);
    expect(await copyCount()).toBe(2);

    await expect(executeApply(client, staleTab, OWNER)).rejects.toThrow(SyncStaleError);
    expect(await copyCount()).toBe(2);
  });

  it("Undo leaves a tombstone, and a second Undo says there is nothing to undo", async () => {
    const client = pgliteClient(db);
    await executeApply(client, (await runSyncPipeline(client, exportBytes([ROW_A]))).bundle, OWNER);
    await executeUndo(client);
    await asSuperuser(db);
    const rows = await db.query<{ snapshot: { tombstone?: boolean } }>(
      `select snapshot from last_sync_snapshot`,
    );
    await asOwner(db);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].snapshot.tombstone).toBe(true);
    await expect(executeUndo(client)).rejects.toThrow(/Nothing to undo/);
  });

  it("a double-clicked Undo: exactly one lands, the other rolls back whole", async () => {
    const client = pgliteClient(db);
    await executeApply(
      client,
      (await runSyncPipeline(client, exportBytes([ROW_A, ROW_B]))).bundle,
      OWNER,
    );
    const results = await Promise.allSettled([executeUndo(client), executeUndo(client)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await copyCount()).toBe(0);
  });
});

describe("UIL-099 E5 · review: 'already applied' only when it is true (M1)", () => {
  it("a DIFFERENT file previewed from the same base is told to import again, not that it was applied", async () => {
    const client = pgliteClient(db);
    const fileA = (await runSyncPipeline(client, exportBytes([ROW_A]))).bundle;
    const fileAB = (await runSyncPipeline(client, exportBytes([ROW_A, ROW_B]))).bundle;
    await executeApply(client, fileA, OWNER);

    // Its Charmeleon was NOT added, so "already applied" would tell her a newer export is in when it is not.
    await expect(executeApply(client, fileAB, OWNER)).rejects.toThrow(SyncStaleError);
    expect(await copyCount()).toBe(2);
  });

  it("the SAME file previewed twice from one base is still told it was already applied", async () => {
    const client = pgliteClient(db);
    const first = (await runSyncPipeline(client, exportBytes([ROW_A]))).bundle;
    const again = (await runSyncPipeline(client, exportBytes([ROW_A]))).bundle;
    await executeApply(client, first, OWNER);
    await expect(executeApply(client, again, OWNER)).rejects.toThrow(SyncAlreadyAppliedError);
  });

  it("two FIRST imports of one file racing: exactly one lands (the review's Q1)", async () => {
    const client = pgliteClient(db);
    const t1 = (await runSyncPipeline(client, exportBytes([ROW_A]))).bundle;
    const t2 = (await runSyncPipeline(client, exportBytes([ROW_A]))).bundle;
    expect(t1.baseSnapshotId).toBeNull();
    const results = await Promise.allSettled([
      executeApply(client, t1, OWNER),
      executeApply(client, t2, OWNER),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await copyCount()).toBe(2);
  });
});

describe("UIL-099 E5 · review: the preview reads its base BEFORE its plan state (B2)", () => {
  /**
   * Makes an apply land DURING the preview's base read — the interleaving the review names. Under the old
   * order (plan state first, base last) that paired a PRE-apply plan with a POST-apply base: the bundle passed
   * the freshness check and re-applied the other tab's cards. With the base read first, the plan is read
   * after the apply too, so it is consistent with its base.
   */
  function applyDuringBaseRead(
    raw: ReturnType<typeof pgliteClient>,
    landing: () => Promise<unknown>,
  ) {
    let armed = true;
    const hook = <T extends object>(obj: T): T =>
      new Proxy(obj, {
        get(t, prop, r) {
          const v = Reflect.get(t, prop, r) as unknown;
          if (prop === "then" && typeof v === "function") {
            return (res: (x: unknown) => unknown, rej: (e: unknown) => unknown) =>
              landing().then(() => (v as (a: unknown, b: unknown) => unknown).call(t, res, rej));
          }
          if (typeof v === "function") {
            return (...args: unknown[]) => {
              const out = (v as (...a: unknown[]) => unknown).apply(t, args);
              return out && typeof out === "object" ? hook(out as object) : out;
            };
          }
          return v;
        },
      });
    return new Proxy(raw as object, {
      get(target, prop, receiver) {
        if (prop !== "from") return Reflect.get(target, prop, receiver);
        return (table: string) => {
          const b = (raw as unknown as { from: (t: string) => object }).from(table);
          if (table === "last_sync_snapshot" && armed) {
            armed = false;
            return hook(b);
          }
          return b;
        };
      },
    }) as unknown as ReturnType<typeof pgliteClient>;
  }

  it("an apply landing between the base and the plan cannot pair a stale plan with a fresh base", async () => {
    const raw = pgliteClient(db);
    const otherTab = (await runSyncPipeline(raw, exportBytes([ROW_A]))).bundle;
    const client = applyDuringBaseRead(raw, () => executeApply(raw, otherTab, OWNER));

    // This tab previews the same file while the other tab's apply lands mid-preview.
    const { bundle } = await runSyncPipeline(client, exportBytes([ROW_A]));
    await executeApply(raw, bundle, OWNER).catch(() => {}); // refused or a no-op — never a second copy set
    expect(await copyCount()).toBe(2); // pre-fix order: 4
  });
});

describe("UIL-099 E5 · the Sync screen never offers an undo the action would refuse", () => {
  const row = (id: string, at: string, snapshot: unknown) => ({ id, created_at: at, snapshot });

  it("no sync yet: nothing to undo", () => {
    expect(undoableSnapshot([])).toBeNull();
  });
  it("the latest is a real snapshot: that one is undoable", () => {
    const s = row("s1", "2026-09-23T10:00:00Z", { version: 1 });
    expect(undoableSnapshot([s])).toBe(s);
  });
  it("the latest is a TOMBSTONE: nothing to undo, so 'Undo available' stays off", () => {
    expect(
      undoableSnapshot([row("t1", "2026-09-23T10:00:00Z", { version: 1, tombstone: true })]),
    ).toBeNull();
  });
});
