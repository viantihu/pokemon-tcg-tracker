/**
 * UIL-100 — what 0022 does to the collection she ALREADY has. Built from Testing's real figures on
 * 2026-09-25 (the Senior BA's reads, runs 36151667823 and 36151800658), taken after Karvi re-imported at
 * 01:12:13Z and shelved cards: 720 copies in 694 presence groups (668 holding one, 26 holding two), 57 of
 * them shelved, 6 unresolved entries all RESOLVED by her hand matches, one undo snapshot from that import,
 * and NO Dex record — because the import ran before 0022 existed.
 *
 * The rules this pins:
 *   (a) no wall of red: before any import is recorded the page says the check starts at her next import;
 *   (b) no false refusal before then: Retry, a manual match and Undo behave exactly as they do today;
 *   (c) her first full re-import ARMS the check — nothing to change if the copies equal the file, and if a
 *       card is doubled, the preview shows the extra and the apply takes it out (the repair path);
 *   (d) Undo of the pre-0022 import passes, and under A' takes back her 6 hand-matched cards too.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { executeApply, executeUndo, manualMatch, requiresPreview } from "@/lib/sync";
import { runSyncPipeline } from "@/lib/sync/pipeline";
import { loadCountCheck } from "@/lib/sync/count-check-load";
import { asOwner, asSuperuser, freshRpcDb, OWNER } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const HEADER =
  "Type;Category;Locale;Series;Set;Id;Number;Name;Variant;Rarity;Illustrator;Quantity;Price;Notes";
const RESOLVED_ROWS = 688; // 662 at quantity 1 + 26 at quantity 2 = 714 copies
const DOUBLES = 26;
const HAND = [91, 92, 93, 94, 95, 96]; // six rows the catalog cannot resolve; she matches each by hand
const HAND_TARGETS = ["xy7-012", "xy7-013", "xy7-014", "xy7-015", "xy7-016", "xy7-017"];
const SHELVED = 57;
const BINDER = "b0000000-0000-4000-8000-000000000001";

const pad = (n: number) => String(n).padStart(3, "0");
function theFile(): Uint8Array {
  const rows: string[] = [];
  for (let i = 1; i <= RESOLVED_ROWS; i++) {
    const qty = i <= DOUBLES ? 2 : 1;
    rows.push(
      `collection;Pokemon;English;SV;Synthetic Set;sx9-${pad(i)};${pad(i)};Card ${i};Normal;Common;;${qty};;`,
    );
  }
  for (const n of HAND) {
    rows.push(
      `collection;Pokemon;English;XY;Ancient Origins;xy7-${n};${n};Mystery ${n};Normal;Rare;;1;;`,
    );
  }
  const body = Buffer.from(`${HEADER}\n${rows.join("\n")}\n`, "utf16le");
  return Uint8Array.from([0xff, 0xfe, ...body]);
}

let db: PGlite;
const client = () => pgliteClient(db);
async function sql<T>(q: string): Promise<T[]> {
  await asSuperuser(db);
  const r = await db.query<T>(q);
  await asOwner(db);
  return r.rows;
}
const one = async (q: string) =>
  Number(Object.values((await sql<Record<string, number>>(q))[0])[0]);

/** Today's Testing, as 0022 will find it on deploy. */
async function buildTodaysTesting(): Promise<void> {
  const values: string[] = [];
  for (let i = 1; i <= RESOLVED_ROWS; i++) {
    values.push(
      `('sx9-${pad(i)}', 'Card ${i}', 'sx9', 'Synthetic Set', '${pad(i)}', '{Fire}', 'Basic', '{${i}}')`,
    );
  }
  HAND_TARGETS.forEach((t, k) =>
    values.push(
      `('${t}', 'Target ${k}', 'xy7', 'Ancient Origins', '${t.slice(4)}', '{Water}', 'Basic', '{${900 + k}}')`,
    ),
  );
  await db.exec(`
    insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id, types, stage, dex_id) values ${values.join(",")};
    insert into binder (id, owner_id, name, type, pages, pockets_per_page, back_half_start_page, is_active)
      values ('${BINDER}', '${OWNER}', 'General 1', 'general', 40, 9, 21, true);
  `);
  await asOwner(db);

  const { bundle } = await runSyncPipeline(client(), theFile());
  await executeApply(client(), bundle, OWNER);
  const waiting = await sql<{ id: string }>(
    `select id from unresolved_entry where status = 'WAITING' order by dex_id`,
  );
  expect(waiting).toHaveLength(HAND.length);
  for (const [i, e] of waiting.entries()) await manualMatch(client(), e.id, HAND_TARGETS[i]);
  await sql(`update copy set role = 'shelved', binder_id = '${BINDER}', binder_half = 'front'
              where id in (select id from copy order by catalog_card_id limit ${SHELVED})`);

  // THE IMPORT RAN BEFORE 0022: no Dex record, and a snapshot that carries none of 0022's fields.
  await sql(`delete from dex_presence`);
  await sql(`delete from dex_import`);
  await sql(
    `update last_sync_snapshot set snapshot = snapshot - 'priorDexRecord' - 'createdCopyKeys'`,
  );
}

beforeEach(async () => {
  db = await freshRpcDb();
  await buildTodaysTesting();
});
afterEach(async () => {
  await db.close();
});

describe("UIL-100 · 0022 meets today's Testing (720 copies, no Dex record)", () => {
  it("the fixture IS today's Testing, figure for figure", async () => {
    expect({
      copies: await one(`select count(*) from copy`),
      shelved: await one(`select count(*) from copy where role = 'shelved'`),
      ungrouped: await one(`select count(*) from copy where presence_group_id is null`),
      groups: await one(`select count(*) from presence_group`),
      groupsOfOne: await one(
        `select count(*) from (select presence_group_id from copy group by 1 having count(*) = 1) g`,
      ),
      groupsOfTwo: await one(
        `select count(*) from (select presence_group_id from copy group by 1 having count(*) = 2) g`,
      ),
      handMatched: await one(
        `select count(*) from unresolved_entry where status = 'RESOLVED' and manual_match_id is not null`,
      ),
      snapshots: await one(`select count(*) from last_sync_snapshot`),
      record: await one(`select count(*) from dex_presence`),
      header: await one(`select count(*) from dex_import`),
    }).toEqual({
      copies: 720,
      shelved: 57,
      ungrouped: 0,
      groups: 694,
      groupsOfOne: 668,
      groupsOfTwo: 26,
      handMatched: 6,
      snapshots: 1,
      record: 0,
      header: 0,
    });
  });

  it("(a) no wall of red: the page says the check starts at her next import, and lists nothing", async () => {
    const check = await loadCountCheck(client());
    expect(check.status).toBe("none");
    expect(check.mismatches).toEqual([]);
  });

  it("(b) no false refusal before the first recorded import: Retry and a manual match behave as today", async () => {
    await expect(runSyncPipeline(client(), null)).resolves.toBeDefined(); // nothing waiting: a no-op retry
    // A new row waiting for her, matched by hand, with no record yet.
    await sql(`insert into unresolved_entry (owner_id, dex_id, dex_variant_raw, quantity, reason, status)
               values ('${OWNER}', 'xy7-97', 'Normal', 1, 'UNKNOWN_CARD', 'WAITING')`);
    const [e] = await sql<{ id: string }>(
      `select id from unresolved_entry where dex_id = 'xy7-97'`,
    );
    await expect(manualMatch(client(), e.id, "xy7-012")).resolves.toBeDefined();
    expect(await one(`select count(*) from copy`)).toBe(721);
    // No record appears from a match: the record is written whole by her next import, never piecemeal.
    expect(await one(`select count(*) from dex_presence`)).toBe(0);
    expect((await loadCountCheck(client())).status).toBe("none");
  });

  it("(c) her first re-import of the same file ARMS the check with nothing to change", async () => {
    const { bundle } = await runSyncPipeline(client(), theFile());
    expect({ creates: bundle.plan.creates.length, retires: bundle.plan.retires.length }).toEqual({
      creates: 0,
      retires: 0,
    });
    expect(bundle.queue.parks).toEqual([]); // her six hand matches resolve their rows (UIL-082)
    await executeApply(client(), bundle, OWNER);
    const check = await loadCountCheck(client());
    expect(check).toMatchObject({
      status: "ok",
      fileTotal: 720,
      inCollection: 720,
      mismatches: [],
    });
  });

  it("(c) a double that ALREADY exists is shown in the preview and taken out by the apply — the repair path", async () => {
    const [g] = await sql<{ id: string }>(
      `select presence_group_id id from copy where catalog_card_id = 'sx9-100' limit 1`,
    );
    await sql(`insert into copy (owner_id, catalog_card_id, variant, dex_variant_raw, presence_group_id, role)
               values ('${OWNER}', 'sx9-100', 'normal', 'Normal', '${g.id}', 'haul')`);
    const { bundle } = await runSyncPipeline(client(), theFile());
    expect(bundle.plan.retires.map((r) => r.catalogCardId)).toEqual(["sx9-100"]);
    expect(requiresPreview(bundle.plan)).toBe(true); // she reviews it; nothing auto-applies
    await executeApply(client(), bundle, OWNER);
    const check = await loadCountCheck(client());
    expect(check).toMatchObject({ status: "ok", inCollection: 720, mismatches: [] });
  });

  it("(d) Undo of the pre-0022 import passes, and takes back her 6 hand-matched cards (A')", async () => {
    await executeUndo(client());
    expect(await one(`select count(*) from copy`)).toBe(0);
    const remembered = await sql<{ manual_match_id: string }>(
      `select manual_match_id from unresolved_entry where status = 'RESOLVED' order by manual_match_id`,
    );
    expect(remembered.map((r) => r.manual_match_id)).toEqual(HAND_TARGETS);
    expect(await one(`select count(*) from dex_presence`)).toBe(0);
    expect((await loadCountCheck(client())).status).toBe("none");
  });
});
