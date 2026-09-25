/**
 * UIL-100 hardening — migration 0024: the record and the queue together must add up to the Dex file.
 *
 * `assert_presence_counts` (0022) checks each card's copies against the record, so a write that adds the SAME
 * amount to both is invisible to it — the second press of Match was exactly that (Dev 2's finding, closed by
 * #330's status check). `assert_file_total` closes the shape at the database: every Dex quantity lives in the
 * record or the queue, so file_total = sum(record) + sum(waiting) + sum(dismissed) after every write that is
 * not an import. Real pipeline, real Postgres (PGlite, every migration on disk), as the authenticated owner.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { dismissEntry, executeApply, executeUndo, manualMatch } from "@/lib/sync";
import { forgottenDismissedLine } from "@/lib/sync/preview";
import { runSyncPipeline } from "@/lib/sync/pipeline";
import { FILE_TOTAL_REMEDY, FileTotalMismatchError } from "@/lib/sync/count-check";
import { loadCountCheck } from "@/lib/sync/count-check-load";
import { CountCheckPanel } from "@/app/(ui)/sync/CountCheckPanel";
import type { WriteOp } from "@/lib/repo/write-ops";
import { applyOps, asOwner, asSuperuser, freshRpcDb, OWNER } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const HEADER =
  "Type;Category;Locale;Series;Set;Id;Number;Name;Variant;Rarity;Illustrator;Quantity;Price;Notes";
const row = (set: string, id: string, n: string, name: string, qty: number) =>
  `collection;Pokemon;English;SV;${set};${id};${n};${name};Normal;Common;;${qty};;`;
const A = (qty: number) => row("Obsidian Flames", "sv03-026", "026", "Charmander", qty);
/** The set resolves by name, the card does not: parks UNKNOWN_CARD, for her to match. */
const X = row("Ancient Origins", "xy7-91", "91", "Mystery X", 1);
const Y = row("Ancient Origins", "xy7-92", "92", "Mystery Y", 1);
const S1 = row("Mystery Set", "zz1-12", "12", "Unknown Twelve", 1);
const S2 = row("Mystery Set", "zz1-13", "13", "Unknown Thirteen", 1);
const R1 = row("Ancient Origins", "xy7-12", "12", "Card Twelve", 1);
const bytes = (rows: string[]) =>
  Uint8Array.from([0xff, 0xfe, ...Buffer.from(`${HEADER}\n${rows.join("\n")}\n`, "utf16le")]);

let db: PGlite;
const client = () => pgliteClient(db);
beforeEach(async () => {
  db = await freshRpcDb();
  await db.exec(`
    insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id) values
      ('sv03-026', 'Charmander', 'sv03', 'Obsidian Flames', '026'),
      ('xy7-012', 'Card Twelve', 'xy7', 'Ancient Origins', '012'),
      ('xy7-013', 'Card Thirteen', 'xy7', 'Ancient Origins', '013');
  `);
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

async function sql<T>(q: string, params: unknown[] = []): Promise<T[]> {
  await asSuperuser(db);
  const r = await db.query<T>(q, params);
  await asOwner(db);
  return r.rows;
}
const n = async (q: string) => Number(Object.values((await sql<Record<string, number>>(q))[0])[0]);
async function importFile(rows: string[]) {
  const run = await runSyncPipeline(client(), bytes(rows));
  await executeApply(client(), run.bundle, OWNER);
  return run;
}
const waiting = (dexId: string) =>
  sql<{ id: string }>(`select id from unresolved_entry where dex_id = $1`, [dexId]).then(
    (r) => r[0].id,
  );
async function refusal(run: () => Promise<unknown>): Promise<FileTotalMismatchError> {
  let err: unknown = null;
  try {
    await run();
  } catch (x) {
    err = x;
  }
  expect(err).toBeInstanceOf(FileTotalMismatchError);
  return err as FileTotalMismatchError;
}

describe("0024 · assert_file_total at the database", () => {
  it("passes while the record and the queue add up to the file; passes with no header", async () => {
    await applyOps(db, { ops: [{ op: "assert_file_total" }] }); // no import recorded yet
    await importFile([A(2), X]);
    await applyOps(db, { ops: [{ op: "assert_file_total" }] }); // file 3 = record 2 + waiting 1
  });

  it("CLOSES THE BLIND SPOT: a row added to the record AND the copies passes the per-card check, not this one", async () => {
    await importFile([A(2)]);
    const [g] = await sql<{ id: string }>(`select id from presence_group`);
    const doubled: WriteOp[] = [
      {
        op: "insert_copy",
        id: crypto.randomUUID(),
        catalog_card_id: "sv03-026",
        dex_variant_raw: "Normal",
        presence_group_id: g.id,
        role: "haul",
      },
      {
        op: "add_dex_presence",
        catalog_card_id: "sv03-026",
        dex_variant_raw: "Normal",
        quantity: 1,
      },
      {
        op: "assert_presence_counts",
        keys: [{ catalog_card_id: "sv03-026", dex_variant_raw: "Normal" }],
      },
    ];
    // The per-card check alone is satisfied: record 3, copies 3.
    await expect(applyOps(db, { ops: doubled })).resolves.toBeUndefined();
    await sql(`delete from copy where id not in (select id from copy order by created_at limit 2)`);
    await sql(`update dex_presence set quantity = 2`);
    // With the file total, the same write is refused whole: record 3 + queue 0 against a file of 2.
    await expect(applyOps(db, { ops: [...doubled, { op: "assert_file_total" }] })).rejects.toThrow(
      /file total check failed/,
    );
    expect(await n(`select count(*) from copy`)).toBe(2);
    expect(await n(`select sum(quantity) from dex_presence`)).toBe(2);
  });
});

describe("0024 · every writer that adds to the record runs it (refusals)", () => {
  it("RETRY: a promotion that adds more to the record than leaves the queue is refused whole", async () => {
    await importFile([R1, S1, S2]);
    await manualMatch(client(), await waiting("zz1-13"), "xy7-013"); // teaches zz1 -> xy7
    const { bundle } = await runSyncPipeline(client(), null);
    expect(bundle.queue.archiveEntryIds).toHaveLength(1); // zz1-12 -> xy7-012 promotes
    // Wrong on BOTH sides, as the second Match press was: +2 to the record and +2 copies, but only 1 left
    // the queue. The per-card check passes; the file total does not.
    bundle.dexAdds = bundle.dexAdds!.map((a) => ({ ...a, quantity: a.quantity * 2 }));
    bundle.plan.creates.push({ ...bundle.plan.creates[0] });
    const before = await n(`select count(*) from copy`);
    const err = await refusal(() => executeApply(client(), bundle, OWNER));
    expect(err.message).toContain(FILE_TOTAL_REMEDY);
    expect(await n(`select count(*) from copy`)).toBe(before);
  });

  it("UNDO: an Undo that would leave the record and queue disagreeing with the restored file is refused", async () => {
    await importFile([A(2)]);
    await importFile([A(3)]);
    // Only a wrong input can make a correct Undo disagree (it restores exactly what was checked before), so
    // corrupt the snapshot's saved file total, as the Import and Retry refusals corrupt their bundles.
    await sql(`update last_sync_snapshot
               set snapshot = jsonb_set(snapshot, '{priorDexRecord,fileTotal}', '9'::jsonb)`);
    const err = await refusal(() => executeUndo(client()));
    expect(err.message).toContain(FILE_TOTAL_REMEDY);
    expect(await n(`select count(*) from copy`)).toBe(3); // nothing undone
  });
});

describe("0024 · the one real risk: the file total already broken at rest", () => {
  it("the page warns in the same words, a match is refused, a re-import repairs it, the match then succeeds", async () => {
    await importFile([A(2), X]);
    // A pre-#330 second Match press, at rest: one more Charmander in both the record and the copies.
    const [g] = await sql<{ id: string }>(`select id from presence_group`);
    await sql(
      `insert into copy (owner_id, catalog_card_id, variant, dex_variant_raw, presence_group_id, role)
       values ($1, 'sv03-026', 'normal', 'Normal', $2, 'haul')`,
      [OWNER, g.id],
    );
    await sql(`update dex_presence set quantity = quantity + 1`);

    // 1. The page says it at rest, in the words the refusal will use.
    const check = await loadCountCheck(client());
    expect(check).toMatchObject({ status: "mismatch", fileAddsUp: false, mismatches: [] });
    const html = renderToStaticMarkup(createElement(CountCheckPanel, { check })).replace(
      /<!-- -->/g,
      "",
    );
    expect(html).toContain(FILE_TOTAL_REMEDY);

    // 2. A match is refused, in the same words, and writes nothing.
    const x = await waiting("xy7-91");
    const err = await refusal(() => manualMatch(client(), x, "xy7-012"));
    expect(err.message).toContain(FILE_TOTAL_REMEDY);
    expect((await sql<{ status: string }>(`select status from unresolved_entry`))[0].status).toBe(
      "WAITING",
    );

    // 3. Re-import the file: the record is rewritten, and the extra Charmander is retired by the diff.
    await importFile([A(2), X]);
    expect((await loadCountCheck(client())).status).toBe("ok");

    // 4. The match now succeeds.
    await manualMatch(client(), x, "xy7-012");
    expect((await loadCountCheck(client())).status).toBe("ok");
  });
});

describe("0024 · the Senior BA's ruling (i): a hand match of a row that was already in the earlier file survives Undo", () => {
  it("import 1 parks X → import 2 still lists X → she matches X → Undo import 2: X's card stays, and it all adds up", async () => {
    await importFile([A(2), X]);
    await importFile([A(3), X]); // X is refreshed (queue.updatedPrior), Charmander +1
    await manualMatch(client(), await waiting("xy7-91"), "xy7-012");
    await executeUndo(client()); // must not be refused by 0024
    expect(await n(`select count(*) from copy where catalog_card_id = 'xy7-012'`)).toBe(1); // X's card
    expect(await n(`select count(*) from copy where catalog_card_id = 'sv03-026'`)).toBe(2); // import 2's +1 gone
    const [e] = await sql<{ status: string; manual_match_id: string }>(
      `select status, manual_match_id from unresolved_entry`,
    );
    expect(e).toEqual({ status: "RESOLVED", manual_match_id: "xy7-012" });
    const check = await loadCountCheck(client());
    expect(check).toMatchObject({ status: "ok", fileAddsUp: true, fileTotal: 3, inCollection: 3 });
  });

  it("a row that import 2 BROUGHT is still taken back (the pinned A' case), even on the same card", async () => {
    await importFile([A(2), X]);
    await importFile([A(2), X, Y]); // X refreshed, Y parked by import 2
    await manualMatch(client(), await waiting("xy7-91"), "xy7-012"); // X: predates
    await manualMatch(client(), await waiting("xy7-92"), "xy7-012"); // Y: brought by import 2, SAME card
    expect(await n(`select count(*) from copy where catalog_card_id = 'xy7-012'`)).toBe(2);
    await executeUndo(client());
    // Only Y's card goes, told apart by #330's derived ids; X's stays.
    expect(await n(`select count(*) from copy where catalog_card_id = 'xy7-012'`)).toBe(1);
    const check = await loadCountCheck(client());
    expect(check).toMatchObject({ status: "ok", fileAddsUp: true, fileTotal: 3 });
  });
});

describe("UIL-104 (a) · a dismissed row that has left the file is forgotten — so the sum can never dead-end", () => {
  it("THE DEAD END: a dismissed row leaves the file → the import runs → the sum adds up → a match still succeeds", async () => {
    await importFile([A(2), X, Y]);
    await dismissEntry(client(), await waiting("xy7-91")); // she dismisses X
    // Her next export no longer lists X. The preview says so, never silently.
    const run = await runSyncPipeline(client(), bytes([A(2), Y]));
    expect(run.preview.sections.unresolved.forgottenDismissed).toBe(1);
    expect(forgottenDismissedLine(1)).toBe(
      "1 dismissed row is no longer in your Dex file and will be forgotten.",
    );
    await executeApply(client(), run.bundle, OWNER);
    expect(await n(`select count(*) from unresolved_entry where dex_id = 'xy7-91'`)).toBe(0);
    const check = await loadCountCheck(client());
    expect(check).toMatchObject({ status: "ok", fileAddsUp: true, fileTotal: 3, dismissed: 0 });
    // Before (a), X stayed dismissed and counted: file 3 against record 2 + queue 2, and 0024 refused this.
    await manualMatch(client(), await waiting("xy7-92"), "xy7-012");
    expect((await loadCountCheck(client())).status).toBe("ok");
  });

  it("an Undo of that import puts the dismissed row back, still dismissed", async () => {
    await importFile([A(2), X]);
    await dismissEntry(client(), await waiting("xy7-91"));
    await importFile([A(2)]);
    await executeUndo(client());
    const rows = await sql<{ status: string }>(
      `select status from unresolved_entry where dex_id = 'xy7-91'`,
    );
    expect(rows).toEqual([{ status: "DISMISSED" }]);
    expect((await loadCountCheck(client())).fileAddsUp).toBe(true);
  });

  it("a dismissed row the catalog can now resolve is archived, so its card is not counted twice", async () => {
    await importFile([A(2), X]);
    await dismissEntry(client(), await waiting("xy7-91"));
    await sql(`insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id)
               values ('xy7-091', 'Mystery X', 'xy7', 'Ancient Origins', '091')`);
    await importFile([A(2), X]);
    const [e] = await sql<{ status: string }>(
      `select status from unresolved_entry where dex_id = 'xy7-91'`,
    );
    expect(e.status).toBe("RESOLVED");
    expect(await n(`select count(*) from copy where catalog_card_id = 'xy7-091'`)).toBe(1);
    const check = await loadCountCheck(client());
    expect(check).toMatchObject({ status: "ok", fileAddsUp: true, dismissed: 0, inCollection: 3 });
  });

  it("the Sync screen shows the sentence when the preview forgets a dismissed row", () => {
    const html = renderToStaticMarkup(createElement("div", null, forgottenDismissedLine(2)));
    expect(html).toContain(
      "2 dismissed rows are no longer in your Dex file and will be forgotten.",
    );
  });
});

/** Just the RPC definition from a migration file, for the composition claim below. */
function migrationFn(file: string): string {
  const sql = readFileSync(path.join(process.cwd(), "supabase", "migrations", file), "utf8");
  const at = sql.indexOf("\ncreate or replace function apply_write_ops(payload jsonb)");
  expect(at).toBeGreaterThan(0);
  return sql.slice(at);
}

describe("0024 · composes on 0022", () => {
  it("is 0022's function VERBATIM plus the one branch marked NEW in 0024 (0023 left the function alone)", () => {
    const base = migrationFn("0022_dex_record.sql");
    const mine = migrationFn("0024_file_total_check.sql");
    const from = mine.indexOf("      -- NEW in 0024");
    const to = mine.indexOf(
      "      else\n        raise exception 'apply_write_ops: unknown op %'",
      from,
    );
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    expect(mine.slice(from, to)).toContain("when 'assert_file_total' then");
    expect(mine.slice(0, from) + mine.slice(to)).toBe(base);
  });
});
