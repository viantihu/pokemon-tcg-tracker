/**
 * UIL-100 — the named cases. Karvi: the total number of cards in the collection must equal the Dex import
 * file, "so that cards are not double counted during the matching process or manual add process".
 *
 * Every case runs the REAL pipeline against real Postgres (PGlite, every migration on disk): a real Dex
 * export in its real physical format (UTF-16LE with a BOM), `runSyncPipeline` + `executeApply`, the real
 * `apply_write_ops` with its in-transaction count check, as the authenticated owner. After each step the
 * Sync page's own check (`loadCountCheck`) must read `ok` — no false refusal, no double.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  executeApply,
  executeUndo,
  manualMatch,
  manualMatchStandIn,
  migrationKey,
  type StandInInput,
} from "@/lib/sync";
import { runSyncPipeline } from "@/lib/sync/pipeline";
import { CountMismatchError } from "@/lib/sync/count-check";
import { loadCountCheck } from "@/lib/sync/count-check-load";
import { applyCopyRemoval } from "@/lib/copy/remove";
import { asOwner, asSuperuser, freshRpcDb, OWNER } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const HEADER =
  "Type;Category;Locale;Series;Set;Id;Number;Name;Variant;Rarity;Illustrator;Quantity;Price;Notes";
const row = (set: string, id: string, num: string, name: string, variant: string, qty: number) =>
  `collection;Pokemon;English;SV;${set};${id};${num};${name};${variant};Common;;${qty};;`;

/** Resolves: Charmander ×2, Charmeleon ×1. */
const A = row("Obsidian Flames", "sv03-026", "026", "Charmander", "Normal", 2);
const B = row("Obsidian Flames", "sv03-027", "027", "Charmeleon", "Normal", 1);
/** The set resolves by name, the card does not exist: each parks UNKNOWN_CARD, for her to match. */
const M = [91, 92, 93, 94].map((n) =>
  row("Ancient Origins", `xy7-${n}`, String(n), `Mystery ${n}`, "Normal", 1),
);
/** The set does not resolve at all: parks UNKNOWN_SET. */
const S1 = row("Mystery Set", "zz1-12", "12", "Unknown Twelve", "Normal", 1);
const S2 = row("Mystery Set", "zz1-13", "13", "Unknown Thirteen", "Normal", 1);

function exportBytes(rows: string[]): Uint8Array {
  const body = Buffer.from(`${HEADER}\n${rows.join("\n")}\n`, "utf16le");
  return Uint8Array.from([0xff, 0xfe, ...body]);
}

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await db.exec(`
    insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id, types, stage, dex_id) values
      ('sv03-026', 'Charmander', 'sv03', 'Obsidian Flames', '026', '{Fire}', 'Basic', '{4}'),
      ('sv03-027', 'Charmeleon', 'sv03', 'Obsidian Flames', '027', '{Fire}', 'Stage1', '{5}'),
      ('xy7-012', 'Card Twelve', 'xy7', 'Ancient Origins', '012', '{Fire}', 'Basic', '{1}'),
      ('xy7-013', 'Card Thirteen', 'xy7', 'Ancient Origins', '013', '{Fire}', 'Basic', '{2}'),
      ('xy7-014', 'Card Fourteen', 'xy7', 'Ancient Origins', '014', '{Fire}', 'Basic', '{3}'),
      ('xy7-015', 'Card Fifteen', 'xy7', 'Ancient Origins', '015', '{Fire}', 'Basic', '{6}');
    insert into binder (id, owner_id, name, type, pages, pockets_per_page, back_half_start_page, is_active)
      values ('b0000000-0000-4000-8000-000000000001', '${OWNER}', 'General 1', 'general', 40, 9, 21, true);
  `);
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

const client = () => pgliteClient(db);

async function importFile(rows: string[], overrides?: Parameters<typeof executeApply>[3]) {
  const { bundle } = await runSyncPipeline(client(), exportBytes(rows));
  await executeApply(client(), bundle, OWNER, overrides);
  return bundle;
}

async function retry() {
  const { bundle } = await runSyncPipeline(client(), null);
  if (bundle.queue.archiveEntryIds.length > 0) await executeApply(client(), bundle, OWNER);
  return bundle;
}

async function sql<T>(q: string): Promise<T[]> {
  await asSuperuser(db);
  const r = await db.query<T>(q);
  await asOwner(db);
  return r.rows;
}

const copyCount = async () => (await sql<{ n: number }>(`select count(*)::int n from copy`))[0].n;
const waitingEntries = () =>
  sql<{ id: string; dex_id: string }>(
    `select id, dex_id from unresolved_entry where status = 'WAITING' order by dex_id`,
  );

/** The Sync page's own verdict must be ok, and the sum must hold. */
async function expectAddsUp() {
  const check = await loadCountCheck(client());
  expect({
    status: check.status,
    mismatches: check.mismatches,
    fileAddsUp: check.fileAddsUp,
  }).toEqual({
    status: "ok",
    mismatches: [],
    fileAddsUp: true,
  });
  expect(check.fileTotal).toBe(
    check.inCollection + check.waiting + check.dismissed + check.removed,
  );
  return check;
}

describe("UIL-100 · her real sequence: import → 4 hand matches → shelve → Undo → re-import", () => {
  it("never refuses falsely, never doubles, and needs no re-matching (Karvi's A')", async () => {
    await importFile([A, B, ...M]);
    expect((await waitingEntries()).length).toBe(4);
    let check = await expectAddsUp();
    expect(check).toMatchObject({ fileTotal: 7, inCollection: 3, waiting: 4 });

    // She matches all four by hand.
    const waiting = await waitingEntries();
    const targets = ["xy7-012", "xy7-013", "xy7-014", "xy7-015"];
    for (const [i, e] of waiting.entries()) await manualMatch(client(), e.id, targets[i]);
    check = await expectAddsUp();
    expect(check).toMatchObject({ fileTotal: 7, inCollection: 7, waiting: 0 });

    // She shelves some of them.
    await sql(`update copy set role = 'shelved', binder_id = 'b0000000-0000-4000-8000-000000000001',
                binder_half = 'front' where catalog_card_id in ('xy7-012', 'xy7-013')`);

    // Undo: the import AND the cards she matched by hand after it go; her matches are remembered.
    await executeUndo(client());
    expect(await copyCount()).toBe(0);
    const remembered = await sql<{ status: string; manual_match_id: string }>(
      `select status, manual_match_id from unresolved_entry order by manual_match_id`,
    );
    expect(remembered).toEqual(targets.map((t) => ({ status: "RESOLVED", manual_match_id: t })));
    expect((await loadCountCheck(client())).status).toBe("none"); // her first import is undone: no record

    // Re-import the same file: the four come straight back, with no re-matching and no double.
    await importFile([A, B, ...M]);
    expect(await waitingEntries()).toEqual([]);
    expect(await copyCount()).toBe(7);
    check = await expectAddsUp();
    expect(check).toMatchObject({ fileTotal: 7, inCollection: 7, waiting: 0 });
  });

  it("an Undo of a LATER import restores the earlier record, and hand matches since go with it", async () => {
    await importFile([A]);
    await importFile([A, B, ...M.slice(0, 1)]);
    const [e] = await waitingEntries();
    await manualMatch(client(), e.id, "xy7-012");
    await expectAddsUp();

    await executeUndo(client());
    expect(await copyCount()).toBe(2); // back to the first import: Charmander ×2
    const check = await expectAddsUp();
    expect(check).toMatchObject({ fileTotal: 2, inCollection: 2 });
  });
});

describe("UIL-100 · the other named cases", () => {
  it("remove a copy (UIL-089), then re-import: not re-created, and it still adds up", async () => {
    await importFile([A, B]);
    const [charmander] = await sql<{ id: string }>(
      `select id from copy where catalog_card_id = 'sv03-026' limit 1`,
    );
    const removed = await applyCopyRemoval(client(), charmander.id);
    expect(removed.ok).toBe(true);
    let check = await expectAddsUp();
    expect(check).toMatchObject({ inCollection: 2, removed: 1, fileTotal: 3 });

    const again = await importFile([A, B]);
    expect(again.plan.creates).toEqual([]);
    check = await expectAddsUp();
    expect(check).toMatchObject({ inCollection: 2, removed: 1 });
  });

  it("a rejected variant migration, then re-import: zero mismatches", async () => {
    await importFile([A]);
    const reverse = row("Obsidian Flames", "sv03-026", "026", "Charmander", "Reverse Holo", 2);
    const { bundle } = await runSyncPipeline(client(), exportBytes([reverse]));
    expect(bundle.plan.variantUpdates.length).toBeGreaterThan(0);
    const rejectedMigrations = bundle.plan.variantUpdates.map((v) =>
      migrationKey(v.catalogCardId, v.fromVariantRaw, v.toVariantRaw),
    );
    await executeApply(client(), bundle, OWNER, { rejectedMigrations });
    await expectAddsUp();

    const again = await importFile([reverse]);
    expect({ creates: again.plan.creates, retires: again.plan.retires }).toEqual({
      creates: [],
      retires: [],
    });
    await expectAddsUp();
  });

  it("stand-in (E4): once TCGdex adds the real card, the row stays on her stand-in — no twin, no refusal", async () => {
    await importFile([M[0]]);
    const [e] = await waitingEntries();
    const input: StandInInput = {
      name: "Mystery 91",
      setName: "Ancient Origins",
      setId: "xy7",
      localId: "91",
      kind: { kind: "pokemon", type: "Fire", stage: "Basic", dexId: 7 },
    };
    const { standInId } = await manualMatchStandIn(client(), e.id, input);
    await expectAddsUp();

    // TCGdex now has the real card the row names.
    await sql(`insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id)
               values ('xy7-091', 'Mystery 91', 'xy7', 'Ancient Origins', '091')`);
    const again = await importFile([M[0]]);
    expect({ creates: again.plan.creates, retires: again.plan.retires }).toEqual({
      creates: [],
      retires: [],
    });
    const onStandIn = await sql<{ n: number }>(
      `select count(*)::int n from copy where catalog_card_id = '${standInId}'`,
    );
    expect(onStandIn[0].n).toBe(1);
    await expectAddsUp();
  });

  it("Retry after an alias is learned: the rest of the set drains and it adds up", async () => {
    await importFile([S1, S2]);
    const waiting = await waitingEntries();
    expect(waiting.map((w) => w.dex_id)).toEqual(["zz1-12", "zz1-13"]);
    // Matching one UNKNOWN_SET row teaches zz1 -> xy7, so the other resolves on Retry.
    await manualMatch(client(), waiting.find((w) => w.dex_id === "zz1-13")!.id, "xy7-013");
    await expectAddsUp();
    const r = await retry();
    expect(r.queue.archiveEntryIds.length).toBe(1);
    expect(await waitingEntries()).toEqual([]);
    const check = await expectAddsUp();
    expect(check).toMatchObject({ fileTotal: 2, inCollection: 2, waiting: 0 });
  });

  it("Retry onto a key another Dex row already fills is ADDITIVE, not a silent retire (audit finding 3)", async () => {
    // Row 1 resolves to xy7-012; row 2 (an unknown set) will resolve to the SAME card once zz1 -> xy7 is known.
    const R1 = row("Ancient Origins", "xy7-12", "12", "Card Twelve", "Normal", 1);
    await importFile([R1, S1, S2]);
    await manualMatch(
      client(),
      (await waitingEntries()).find((w) => w.dex_id === "zz1-13")!.id,
      "xy7-013",
    );
    await retry(); // zz1-12 -> xy7-012, the key R1 already holds one copy of
    const twelve = await sql<{ n: number }>(
      `select count(*)::int n from copy where catalog_card_id = 'xy7-012'`,
    );
    expect(twelve[0].n).toBe(2); // R1's copy kept, zz1-12's added
    await expectAddsUp();
  });
});

describe("UIL-100 · a double is refused, and the refusal says what to do", () => {
  it("a hand match onto a card that already holds one copy too many is refused, nothing written, card named", async () => {
    await importFile([A, M[0]]);
    // An orphan: one more Charmander than Dex lists (how pre-A' Undo left her hand matches).
    const [group] = await sql<{ id: string }>(
      `select id from presence_group where catalog_card_id = 'sv03-026'`,
    );
    await sql(`insert into copy (owner_id, catalog_card_id, variant, dex_variant_raw, presence_group_id, role)
               values ('${OWNER}', 'sv03-026', 'normal', 'Normal', '${group.id}', 'haul')`);
    const before = await copyCount();
    const [e] = await waitingEntries();

    let err: unknown = null;
    try {
      await manualMatch(client(), e.id, "sv03-026");
    } catch (x) {
      err = x;
    }
    expect(err).toBeInstanceOf(CountMismatchError);
    const message = (err as Error).message;
    expect(message).toMatch(/Nothing was changed/);
    expect(message).toMatch(/Charmander/);
    expect(message).toMatch(/extra/);
    // And it does not send her to "remove" — that records the card as traded away, a dead end here.
    expect(message).toMatch(/Report this \(UIL-100\)/);
    expect(message).toMatch(/do not remove a copy/);
    // Nothing written: the entry still waits, no copy was added.
    expect(await copyCount()).toBe(before);
    expect((await waitingEntries()).length).toBe(1);

    // The page names it too.
    const check = await loadCountCheck(client());
    expect(check.status).toBe("mismatch");
    expect(check.mismatches).toEqual([
      expect.objectContaining({ name: "Charmander", dex: 2, have: 3, direction: "extra" }),
    ]);
  });

  it("a removal is never blocked by the check, even on a card that already disagrees", async () => {
    await importFile([A]);
    const [group] = await sql<{ id: string }>(
      `select id from presence_group where catalog_card_id = 'sv03-026'`,
    );
    await sql(`insert into copy (id, owner_id, catalog_card_id, variant, dex_variant_raw, presence_group_id, role)
               values ('c0000000-0000-4000-8000-000000000099', '${OWNER}', 'sv03-026', 'normal', 'Normal',
                       '${group.id}', 'haul')`);
    expect((await loadCountCheck(client())).status).toBe("mismatch");
    // A removal can never make a card disagree (copies and removals move together), so it is never
    // checked — and so never refused, even here.
    const res = await applyCopyRemoval(client(), "c0000000-0000-4000-8000-000000000099");
    expect(res.ok).toBe(true);
    // It is also REMEMBERED (traded away), so Dex 2 − removed 1 = 1 is now expected and she still holds 2:
    // the page keeps naming it rather than pretending it is fixed. This state cannot arise any more (the
    // check refuses the write that would make it, and Undo no longer leaves hand matches behind); the
    // panel's advice therefore says to report it, not to remove it.
    const check = await loadCountCheck(client());
    expect(check.mismatches.map((m) => m.direction)).toEqual(["extra"]);
  });
});
