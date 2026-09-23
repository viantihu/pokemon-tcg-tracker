/**
 * UIL-089 — "remove this copy from the app", and the memory that stops an import handing it straight back.
 *
 * Karvi: "no reason is necessary." A card gets traded, lost, or was never really there; the app's job is to
 * stop claiming she has it. The hard half is not the delete, it is that presence is a COUNT: `reconcile`
 * compares what Dex says she owns against the live copies of each `presence_group`, so a copy removed while
 * Dex still lists the card reads as `desired 1 / current 0` on the very next import. Migration 0020's
 * `removed_presence` is the memory that answers it.
 *
 * Driven through the REAL pipeline against real Postgres (PGlite): a real Dex export in its real physical
 * format (UTF-16LE with a BOM), the real `runSyncPipeline` + `executeApply`, the real `apply_write_ops` RPC,
 * as the authenticated owner. A hand-rolled applier would prove only that the ops match my expectation.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { executeApply } from "@/lib/sync";
import { runSyncPipeline } from "@/lib/sync/pipeline";
import { applyCopyMerge, applyCopyRemoval, buildRemoveCopyOps, MERGE_REFUSALS } from "@/lib/copy";
import { asOwner, asSuperuser, freshRpcDb, OWNER, seedBinders } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";
import { readFileSync } from "node:fs";
import path from "node:path";

const HEADER =
  "Type;Category;Locale;Series;Set;Id;Number;Name;Variant;Rarity;Illustrator;Quantity;Price;Notes";
/** One card she owns exactly one of, in the mirror, resolvable by set + number. */
const ROW =
  "collection;Pokemon;English;SV;Obsidian Flames;sv03-026;026;Charmander;Normal;Common;;1;;";
const CARD = "sv03-026";

/** The real export's physical format (lib/sync/csv.ts): UTF-16LE with a BOM. */
function exportBytes(rows: string[] = [ROW]): Uint8Array {
  const body = Buffer.from(`${HEADER}\n${rows.join("\n")}\n`, "utf16le");
  return Uint8Array.from([0xff, 0xfe, ...body]);
}

const B1 = "1c000000-0000-0000-0000-0000000000b1";
const LINE = "10000000-0000-0000-0000-00000000a001";
const SLOT = "50000000-0000-0000-0000-00000000a001";

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await db.exec(`
    insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id, types, stage, dex_id)
      values ('${CARD}', 'Charmander', 'sv03', 'Obsidian Flames', '026', '{Fire}', 'Basic', '{4}');
  `);
  await seedBinders(db, [{ id: B1, type: "general", name: "Binder 1" }]);
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

async function copies() {
  await asSuperuser(db);
  const r = await db.query<{
    id: string;
    role: string;
    presence_group_id: string | null;
    line_slot_id: string | null;
  }>(
    `select id, role, presence_group_id, line_slot_id from copy where catalog_card_id = '${CARD}'`,
  );
  await asOwner(db);
  return r.rows;
}
async function memory() {
  await asSuperuser(db);
  const r = await db.query<{ catalog_card_id: string; dex_variant_raw: string; count: number }>(
    `select catalog_card_id, dex_variant_raw, count from removed_presence`,
  );
  await asOwner(db);
  return r.rows;
}
async function one<T extends Record<string, unknown>>(sql: string): Promise<T | null> {
  await asSuperuser(db);
  const r = await db.query<T>(sql);
  await asOwner(db);
  return r.rows[0] ?? null;
}
/** Import the export as she would, and return the copy it created. */
async function importOnce() {
  const client = pgliteClient(db);
  const run = await runSyncPipeline(client, exportBytes());
  await executeApply(client, run.bundle);
  return run;
}

describe("UIL-089 · a removed Dex copy stays removed", () => {
  it("re-importing the SAME export does not hand the card back", async () => {
    const client = pgliteClient(db);
    await importOnce();
    const created = await copies();
    expect(created).toHaveLength(1);
    expect(created[0].presence_group_id).not.toBeNull(); // Dex-backed: this is the case that needs memory

    const res = await applyCopyRemoval(client, created[0].id);
    expect(res).toMatchObject({ ok: true, remembered: true });
    expect(await copies()).toHaveLength(0);
    expect(await memory()).toEqual([
      { catalog_card_id: CARD, dex_variant_raw: "Normal", count: 1 },
    ]);

    // The export has not changed — Dex still says she owns one. PRE-FIX this created the copy again, which
    // is the whole defect: the app handing back a card she has told it she does not have.
    const second = await runSyncPipeline(client, exportBytes());
    expect(second.bundle.plan.creates).toHaveLength(0);
    await executeApply(client, second.bundle);
    expect(await copies()).toHaveLength(0);
  });

  it("forgets the memory once Dex stops listing the card, so a real re-acquisition still lands", async () => {
    const client = pgliteClient(db);
    await importOnce();
    const created = await copies();
    await applyCopyRemoval(client, created[0].id);
    expect(await memory()).toHaveLength(1);

    // An export with the card GONE: she is no longer claiming it in Dex either, so the disagreement the
    // memory recorded is over and keeping it would suppress a future genuine row forever.
    const empty = await runSyncPipeline(client, exportBytes([]));
    expect(empty.bundle.plan.forgetRemoved).toHaveLength(1);
    await executeApply(client, empty.bundle);
    expect(await memory()).toHaveLength(0);

    // And now buying it again works: the card comes back, because nothing is suppressing it.
    const again = await runSyncPipeline(client, exportBytes());
    expect(again.bundle.plan.creates).toHaveLength(1);
    await executeApply(client, again.bundle);
    expect(await copies()).toHaveLength(1);
  });

  it("a RETRY import does not forget the memory — it has no evidence of absence", async () => {
    // The gate that makes this safe. A retry reconciles only against the handful of keys it just promoted
    // (lib/sync/pipeline.ts), so its `desired` map is nearly empty BY DESIGN — reading "absent from desired"
    // as "Dex stopped listing it" there would forget every memory she holds the first time she pressed
    // Retry on the unresolved queue, and every removed card would come back on the next real import.
    const client = pgliteClient(db);
    await importOnce();
    await applyCopyRemoval(client, (await copies())[0].id);
    expect(await memory()).toHaveLength(1);

    const retry = await runSyncPipeline(client, null); // bytes = null is the retry sweep
    expect(retry.bundle.plan.forgetRemoved).toHaveLength(0);
    await executeApply(client, retry.bundle);
    expect(await memory()).toHaveLength(1); // still remembered
  });

  it("a HAND-TYPED copy needs no memory — no import counts it, so none can re-create it", async () => {
    const client = pgliteClient(db);
    await asSuperuser(db);
    const hand = "c0000000-0000-0000-0000-00000000aa01";
    // `dex_variant_raw` IS set here on purpose. The column is nullable and nothing forbids a value on a
    // hand-typed row, so a guard written as "has a variant string" would read this as Dex's and remember it.
    // The fact that decides it is the PRESENCE GROUP: no group means no import counts this copy, so none
    // can re-create it, and remembering it would suppress a future genuine Dex row for the same printing.
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band,
         dex_variant_raw, presence_group_id)
         values ($1, $2, $3, 'shelved', $4, 'front', 'red', 'Normal', null)`,
      [hand, OWNER, CARD, B1],
    );
    await asOwner(db);

    const res = await applyCopyRemoval(client, hand);
    expect(res).toMatchObject({ ok: true, remembered: false });
    expect(await memory()).toHaveLength(0);
  });
});

describe("UIL-089 · what a removal releases", () => {
  /** A complete line whose Basic stage is filled by a Dex-backed copy. */
  async function seedFilledSlot(): Promise<string> {
    const client = pgliteClient(db);
    await importOnce();
    const copy = (await copies())[0];
    await asSuperuser(db);
    await db.exec(`
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
        values ('${LINE}', '${OWNER}', 4, 'red', '${B1}', 'back', 'complete');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id,
        resolved_decision_kind, resolved_decision_choice)
        values ('${SLOT}', '${OWNER}', '${LINE}', 0, 'Basic', 'filled', '${copy.id}',
          'ex-only-cap', 'accept');
      update copy set role = 'shelved', binder_id = '${B1}', binder_half = 'back',
        color_band = 'red', line_slot_id = '${SLOT}' where id = '${copy.id}';
    `);
    await asOwner(db);
    void client;
    return copy.id;
  }

  it("releases the slot and demotes the line, never leaving a filled slot with no card", async () => {
    // THE SHARP EDGE. `line_slot.copy_id` is `on delete set null`, so a bare `delete_copy` leaves
    // `state = 'filled'` with a null copy — the two-sided contradiction UIL-062 was about, and exactly the
    // shape migration 0018's rule (a) had to be taught to guard against. The release has to be in the same
    // transaction as the delete.
    const copyId = await seedFilledSlot();
    const res = await applyCopyRemoval(pgliteClient(db), copyId);
    expect(res.ok).toBe(true);

    const slot = await one<{
      state: string;
      copy_id: string | null;
      resolved_decision_kind: string | null;
    }>(`select state, copy_id, resolved_decision_kind from line_slot where id = '${SLOT}'`);
    expect(slot).toEqual({ state: "placeholder", copy_id: null, resolved_decision_kind: null });

    // The line is no longer complete: the stage is wanted again.
    const line = await one<{ status: string }>(
      `select status from evolution_line where id = '${LINE}'`,
    );
    expect(line).toEqual({ status: "open" });
  });

  it("keeps the audit row, and the row still says WHICH card — its FK nulls out", async () => {
    // `placement_decision.copy_id` is `on delete set null` (0002), and the insert and the delete are in ONE
    // transaction, so the link is already gone by the time it commits. The row survives (UIL-042) but only
    // the reason text can still identify the card. That gap is UIL-094; until then this is the history.
    const copyId = await seedFilledSlot();
    await applyCopyRemoval(pgliteClient(db), copyId);

    const row = await one<{ decision: string; reason: string; copy_id: string | null }>(
      `select decision, reason, copy_id from placement_decision where decision = 'copy-removed'`,
    );
    expect(row?.decision).toBe("copy-removed");
    expect(row?.copy_id).toBeNull(); // the FK, not a bug in the writer
    expect(row?.reason).toContain(CARD);
    expect(row?.reason).toContain("Normal");
    expect(row?.reason).toContain("Binder 1");
  });

  it("does NOT subtract the collection's chase tag — a chase tag is a want", async () => {
    // The Senior BA's ruling 3, and Karvi's model: she can chase a card she does not own, so trading one
    // away does not mean she stopped wanting it. `applyCollectionRemoval` is the action that means that.
    await asSuperuser(db);
    const coll = "a0000000-0000-0000-0000-00000000a001";
    await db.query(
      `insert into collection (id, owner_id, name, mode, status, target_catalog_card_ids, current_binder_ids)
         values ($1, $2, 'Matsuno', 'finite', 'active', $3, $4)`,
      [coll, OWNER, [CARD], [B1]],
    );
    await asOwner(db);
    const client = pgliteClient(db);
    await importOnce();
    const copy = (await copies())[0];
    await asSuperuser(db);
    await db.exec(`update copy set role = 'shelved', binder_id = '${B1}' where id = '${copy.id}'`);
    await asOwner(db);

    await applyCopyRemoval(client, copy.id);
    const row = await one<{ t: string[] }>(
      `select target_catalog_card_ids t from collection where id = '${coll}'`,
    );
    expect(row?.t).toEqual([CARD]); // still chasing it
  });

  it("is ONE apply_write_ops call — the op set, in order (UIL-014)", async () => {
    // Five facts have to land together or none: slot released, line demoted, audit written, copy gone,
    // memory kept. Asserted on the built op set, because the order is part of the guarantee.
    const copyId = await seedFilledSlot();
    const plan = await (await import("@/lib/copy")).loadRemoveCopyPlan(pgliteClient(db), copyId);
    const ops = buildRemoveCopyOps(plan!);
    expect(ops.map((o) => o.op)).toEqual([
      "update_slot", // release, and clear the UIL-078 markers
      "update_line", // demote a complete line
      "insert_decision",
      "delete_copy",
      "remember_removed_presence",
    ]);
  });
});

describe("UIL-089 · two records, one card", () => {
  /** Her incident: a copy she typed and shelved, plus the Dex twin still waiting in the haul. */
  async function seedDuplicate(): Promise<{ survivor: string; twin: string }> {
    const client = pgliteClient(db);
    await importOnce(); // the Dex twin, role 'haul', in a presence group
    const twin = (await copies())[0];
    await asSuperuser(db);
    const survivor = "c0000000-0000-0000-0000-00000000bb01";
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
         values ($1, $2, $3, 'shelved', $4, 'front', 'red')`,
      [survivor, OWNER, CARD, B1],
    );
    await asOwner(db);
    void client;
    return { survivor, twin: twin.id };
  }

  it("the survivor adopts the twin's identity, and a re-import creates nothing", async () => {
    const client = pgliteClient(db);
    const { survivor, twin } = await seedDuplicate();
    expect(await copies()).toHaveLength(2);

    const res = await applyCopyMerge(client, survivor, twin);
    expect(res).toMatchObject({ ok: true, survivorCopyId: survivor, removedCopyId: twin });

    const left = await copies();
    expect(left).toHaveLength(1);
    expect(left[0].id).toBe(survivor);
    expect(left[0].presence_group_id).not.toBeNull(); // it IS the Dex record now
    expect(left[0].role).toBe("shelved"); // and it kept its own placement

    // NO memory row: nothing was lost, so nothing has to be remembered. This is why the merge is smaller
    // than removing the twin — that route needs the memory forever, for a card she still owns.
    expect(await memory()).toHaveLength(0);

    const again = await runSyncPipeline(client, exportBytes());
    expect(again.bundle.plan.creates).toHaveLength(0);
    expect(again.bundle.plan.retires).toHaveLength(0);
  });

  it("refuses every ambiguous pairing rather than destroying a copy she owns", async () => {
    const client = pgliteClient(db);
    const { survivor, twin } = await seedDuplicate();

    expect(await applyCopyMerge(client, twin, twin)).toEqual({
      ok: false,
      error: MERGE_REFUSALS.same,
    });
    // Two hand-typed records have no identity to adopt: merging them is a removal wearing a merge's name.
    expect(await applyCopyMerge(client, twin, survivor)).toEqual({
      ok: false,
      error: MERGE_REFUSALS.neitherTracked,
    });
    expect(await copies()).toHaveLength(2); // nothing written by either refusal
  });
});

/** Just the RPC definition from a migration file, for the verbatim-diff claim below. */
function migrationFn(file: string): string {
  const sql = readFileSync(path.join(process.cwd(), "supabase", "migrations", file), "utf8");
  const at = sql.indexOf("\ncreate or replace function apply_write_ops(payload jsonb)");
  expect(at).toBeGreaterThan(0);
  return sql.slice(at);
}

describe("UIL-089 · migration 0020", () => {
  it("is 0017's function verbatim plus the two new branches", () => {
    // 0018 and 0019 left `apply_write_ops` alone, so 0017's body is the one that runs before this file.
    // Pinned mechanically because the convention is "verbatim plus one branch": a re-issue that silently
    // dropped an earlier branch would take a feature away with no test failing anywhere near it.
    const base = migrationFn("0017_collection_rebind_op.sql");
    const mine = migrationFn("0020_removed_presence.sql");
    const start = mine.indexOf("      -- NEW in 0020");
    const end = mine.indexOf("      else\n", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(mine.slice(0, start) + mine.slice(end)).toBe(base);
    expect(mine.slice(start, end)).toContain("when 'remember_removed_presence' then");
    expect(mine.slice(start, end)).toContain("when 'forget_removed_presence' then");
    // The inherited branches are still there: the composed function carries every earlier addition.
    expect(mine).toContain("when 'set_collection_binders' then");
    expect(mine).toContain("when 'insert_catalog_stand_in' then");
    expect(mine).toContain("when 'delete_set_alias' then");
    expect(mine).toContain("when 'union_collection_targets' then");
  });

  it("the increment is computed server-side, so two removals cannot lose one", async () => {
    // A TypeScript read-modify-write would drop one of these, which is 0007's own lesson from
    // `union_collection_targets`. `count` ends at 2 because the RPC adds to the column itself.
    const client = pgliteClient(db);
    const run = await runSyncPipeline(
      client,
      exportBytes([ROW.replace(";Common;;1;;", ";Common;;2;;")]),
    );
    await executeApply(client, run.bundle);
    const both = await copies();
    expect(both).toHaveLength(2);

    await applyCopyRemoval(client, both[0].id);
    await applyCopyRemoval(client, both[1].id);
    expect(await memory()).toEqual([
      { catalog_card_id: CARD, dex_variant_raw: "Normal", count: 2 },
    ]);
  });

  it("forgetting a key that was never remembered is a silent no-op", async () => {
    await db.query(`select apply_write_ops($1::jsonb)`, [
      JSON.stringify({
        ops: [{ op: "forget_removed_presence", catalog_card_id: CARD, dex_variant_raw: "Nope" }],
      }),
    ]);
    expect(await memory()).toHaveLength(0);
  });

  it("is RLS-scoped: the memory belongs to its owner", async () => {
    const client = pgliteClient(db);
    await importOnce();
    await applyCopyRemoval(client, (await copies())[0].id);

    // Another owner's session sees none of it. `owner_id` defaults to auth.uid() on insert and is part of
    // the conflict target, so one owner's memory can never collide with or leak into another's. The claim is
    // set the same way `asOwner` does — the shim reads `request.jwt.claim.sub`, not a JSON claims blob.
    await db.exec(
      `select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000ff', false);`,
    );
    await db.exec(`set role authenticated;`);
    const theirs = await db.query<{ n: number }>(`select count(*)::int n from removed_presence`);
    expect(theirs.rows[0].n).toBe(0);
    await asOwner(db);
    expect(await memory()).toHaveLength(1);
  });
});
