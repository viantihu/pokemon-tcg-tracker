/**
 * A row she DISMISSED no longer blocks her next import (found building UIL-100's 0024).
 *
 * Import a file with a row the catalog cannot resolve, dismiss that row on the Sync page, then import a file
 * that still lists it. The import's park step de-duplicated only against WAITING entries, so it inserted a
 * SECOND entry for the dismissed row — and `unresolved_entry` is unique on (owner, dex_id, dex_variant_raw),
 * so the whole import failed with a raw database error. Now the dismissed entry is refreshed in place and
 * stays dismissed, and the Sync page's sum still adds up.
 *
 * The real pipeline against real Postgres (PGlite, every migration on disk), as the authenticated owner.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { dismissEntry, executeApply, executeUndo } from "@/lib/sync";
import { runSyncPipeline } from "@/lib/sync/pipeline";
import { loadCountCheck } from "@/lib/sync/count-check-load";
import { applyOps, asOwner, asSuperuser, freshRpcDb, OWNER } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const HEADER =
  "Type;Category;Locale;Series;Set;Id;Number;Name;Variant;Rarity;Illustrator;Quantity;Price;Notes";
const A =
  "collection;Pokemon;English;SV;Obsidian Flames;sv03-026;026;Charmander;Normal;Common;;2;;";
/** The set resolves by name, the card does not exist: parks UNKNOWN_CARD. */
const mystery = (qty: number) =>
  `collection;Pokemon;English;XY;Ancient Origins;xy7-91;91;Mystery;Normal;Rare;;${qty};;`;
const bytes = (rows: string[]) =>
  Uint8Array.from([0xff, 0xfe, ...Buffer.from(`${HEADER}\n${rows.join("\n")}\n`, "utf16le")]);

let db: PGlite;
const client = () => pgliteClient(db);
beforeEach(async () => {
  db = await freshRpcDb();
  await db.exec(`
    insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id) values
      ('sv03-026', 'Charmander', 'sv03', 'Obsidian Flames', '026'),
      ('xy7-012', 'Card Twelve', 'xy7', 'Ancient Origins', '012');
  `);
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

async function entries() {
  await asSuperuser(db);
  const r = await db.query<{ id: string; status: string; quantity: number }>(
    `select id, status, quantity from unresolved_entry order by dex_id`,
  );
  await asOwner(db);
  return r.rows;
}

async function importFile(rows: string[]) {
  const run = await runSyncPipeline(client(), bytes(rows));
  await executeApply(client(), run.bundle, OWNER);
  return run;
}

describe("a dismissed row no longer blocks the next import", () => {
  it("dismiss, then re-import the same file: the import succeeds, the row stays DISMISSED, quantity refreshed", async () => {
    await importFile([A, mystery(1)]);
    const [e] = (await entries()).filter((x) => x.status === "WAITING");
    await dismissEntry(client(), e.id);

    // The same export, with the row's quantity changed in Dex, so the refresh is visible.
    const again = await importFile([A, mystery(2)]);
    expect(await entries()).toEqual([{ id: e.id, status: "DISMISSED", quantity: 2 }]);
    // A dismissed row is neither a new waiting card nor one still waiting.
    expect(again.bundle.counts.parks).toBe(0);
    expect(again.bundle.queue.stillWaiting).toBe(0);

    // The Sync page's sum: file 4 = 2 Charmander + 0 waiting + 2 dismissed.
    const check = await loadCountCheck(client());
    expect(check).toMatchObject({
      status: "ok",
      fileTotal: 4,
      inCollection: 2,
      waiting: 0,
      dismissed: 2,
      fileAddsUp: true,
    });
  });

  it("an Undo of that import puts the dismissed row back exactly as it was", async () => {
    await importFile([A, mystery(1)]);
    const [e] = (await entries()).filter((x) => x.status === "WAITING");
    await dismissEntry(client(), e.id);
    await importFile([A, mystery(2)]);
    await executeUndo(client());
    expect(await entries()).toEqual([{ id: e.id, status: "DISMISSED", quantity: 1 }]);
  });

  it("CONTROL — the pre-fix step, a second insert for the dismissed row, is what failed the whole import", async () => {
    await importFile([A, mystery(1)]);
    const [e] = (await entries()).filter((x) => x.status === "WAITING");
    await dismissEntry(client(), e.id);
    await expect(
      applyOps(db, {
        ops: [
          {
            op: "insert_unresolved_entry",
            id: crypto.randomUUID(),
            dex_id: "xy7-91",
            dex_set_name: "Ancient Origins",
            dex_series: "XY",
            dex_number: "91",
            dex_name: "Mystery",
            dex_variant_raw: "Normal",
            quantity: 2,
            locale: "English",
            reason: "UNKNOWN_CARD",
            status: "WAITING",
          },
        ],
      }),
    ).rejects.toThrow(/unresolved_entry_owner_id_dex_id_dex_variant_raw_key/);
  });
});
