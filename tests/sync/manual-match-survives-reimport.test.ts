/**
 * UIL-082 (proof) — a manual match must survive the next import of the same export.
 *
 * She pins an unresolved entry to a catalog card ("Needs your match"); the entry goes RESOLVED with
 * `manual_match_id` and copies are created for the card. The next time she imports the Dex export, the
 * same row is still in it and the catalog still cannot resolve it on its own. What should happen: the
 * row resolves to the card she matched, the group is unchanged, nothing parks, nothing is retired.
 *
 * Prediction (Full Stack Dev - 1, 2026-09-19): the import path resolves rows against the catalog only
 * and loads WAITING entries only, so the row parks again as UNKNOWN_CARD and, because no CSV row now
 * resolves to the matched card, the reconcile proposes RETIRING the copies she just created. Real
 * Postgres, real RLS, the real pipeline, the real manualMatch.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { executeApply, manualMatch } from "@/lib/sync";
import { runSyncPipeline } from "@/lib/sync/pipeline";
import { asOwner, asSuperuser, freshRpcDb, OWNER } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const HEADER =
  "Type;Category;Locale;Series;Set;Id;Number;Name;Variant;Rarity;Illustrator;Quantity;Price;Notes";
/** A card whose SET the mirror knows (Ancient Origins → xy7) but whose NUMBER it does not carry. */
const ROW = "collection;Pokemon;English;XY;Ancient Origins;xy7-99;99;Mystery Card;Normal;Rare;;1;;";
/** UTF-16LE with BOM, the real export's physical format (lib/sync/csv.ts). */
function exportBytes(): Uint8Array {
  const body = Buffer.from(`${HEADER}\n${ROW}\n`, "utf16le");
  return Uint8Array.from([0xff, 0xfe, ...body]);
}

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await db.exec(`
    insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id, types)
    values ('xy7-012', 'Card A', 'xy7', 'Ancient Origins', '012', '{Fire}');
  `);
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

describe("UIL-082 · a manual match survives re-importing the same export", () => {
  it("import → park → manual match → import again: the row resolves to her match, nothing parks or retires", async () => {
    const client = pgliteClient(db);

    // 1. First import: the set resolves by name, the card does not exist → parks as UNKNOWN_CARD.
    const first = await runSyncPipeline(client, exportBytes());
    expect(first.bundle.plan.unresolved.map((u) => u.dexId)).toEqual(["xy7-99"]);
    await executeApply(client, first.bundle, OWNER);
    const parked = await db.query<{ id: string; reason: string; status: string }>(
      "select id, reason, status from unresolved_entry",
    );
    expect(parked.rows).toHaveLength(1);
    expect(parked.rows[0]).toMatchObject({ reason: "UNKNOWN_CARD", status: "WAITING" });

    // 2. She matches it manually to the card she actually holds.
    await manualMatch(client, parked.rows[0].id, "xy7-012");
    const matched = await db.query<{ status: string; manual_match_id: string }>(
      "select status, manual_match_id from unresolved_entry",
    );
    expect(matched.rows[0]).toEqual({ status: "RESOLVED", manual_match_id: "xy7-012" });
    const copies = await db.query<{ n: number }>(
      "select count(*)::int as n from copy where catalog_card_id = 'xy7-012'",
    );
    expect(copies.rows[0].n).toBe(1);

    // 3. The same export again. The catalog still lacks xy7-99; her match must carry the row.
    const second = await runSyncPipeline(client, exportBytes());
    const plan = second.bundle.plan;
    // One assertion over the three facets, so a failure shows the whole shape of what went wrong.
    // Zero proposals of ANY kind for the matched row: no park, no retire, no re-add, no variant
    // change — the fix must not trade one wrong proposal for another.
    expect({
      parks: plan.unresolved.map((u) => `${u.dexId} ${u.reason}`),
      retires: plan.retires.map((r) => JSON.stringify(r)),
      creates: plan.creates.map((c) => c.catalogCardId),
      variantUpdates: plan.variantUpdates.length,
      unchanged: plan.unchanged,
    }).toEqual({ parks: [], retires: [], creates: [], variantUpdates: 0, unchanged: 1 });
  });
});

describe("UIL-082 · the match is her override, and it never invents rows", () => {
  /** Import, park, match — the state every case below starts from. */
  async function matched() {
    const client = pgliteClient(db);
    const first = await runSyncPipeline(client, exportBytes());
    await executeApply(client, first.bundle, OWNER);
    const { rows } = await db.query<{ id: string }>("select id from unresolved_entry");
    await manualMatch(client, rows[0].id, "xy7-012");
    return client;
  }

  it("the match wins even once the catalog CAN resolve the row itself (the real record arrives)", async () => {
    const client = await matched();
    // TCGdex catches up: xy7-099 now exists, and the resolver would pick it by padding. (The mirror
    // writes as the service role; the app user cannot insert catalog rows.)
    await asSuperuser(db);
    await db.exec(`
      insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id, types)
      values ('xy7-099', 'Mystery Card', 'xy7', 'Ancient Origins', '099', '{Fire}');
    `);
    await asOwner(db);
    const plan = (await runSyncPipeline(client, exportBytes())).bundle.plan;
    expect({
      parks: plan.unresolved.length,
      creates: plan.creates.map((c) => c.catalogCardId),
      retires: plan.retires.length,
      unchanged: plan.unchanged,
    }).toEqual({ parks: 0, creates: [], retires: 0, unchanged: 1 });
  });

  it("a row GONE from the export still retires normally — the memory resurrects nothing", async () => {
    const client = await matched();
    const emptyExport = Uint8Array.from([0xff, 0xfe, ...Buffer.from(`${HEADER}\n`, "utf16le")]);
    const plan = (await runSyncPipeline(client, emptyExport)).bundle.plan;
    expect(plan.retires.map((r) => r.catalogCardId)).toEqual(["xy7-012"]);
    expect(plan.unresolved).toEqual([]);
  });
});
