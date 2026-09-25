/**
 * UIL-099 E2 — a manual match honours her removal, says so, and offers the way back.
 * UIL-099 (found building E2) — a manual match is applied once.
 *
 * `removed_presence` (UIL-089) is the memory that stops an import handing back a card she removed while Dex
 * still lists it. A manual match on the Sync page is an import of ONE row, and it never read that memory:
 * matching a row for a card she had traded away silently re-created it. Now the match withholds up to what
 * she removed, still records the row as matched (so every later import resolves it), and reports what it
 * held back. "Add it back" returns those cards and shrinks the memory in one transaction.
 *
 * And `manualMatch` never checked the row's status, so a second press — a second tab, a double click, a
 * retry after a lost response — inserted the row's whole quantity again: E5's doubling on the Sync page's
 * other write. Its copies are now written at ids derived from the row, so racing presses collide.
 *
 * Real Postgres (PGlite), real RLS, the real pipeline, the real manualMatch — the harness
 * manual-match-survives-reimport.test.ts established.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  executeApply,
  manualMatch,
  manualMatchStandIn,
  MATCH_REFUSED,
  restoreWithheldForEntry,
  RESTORE_REFUSED,
} from "@/lib/sync";
import { runSyncPipeline } from "@/lib/sync/pipeline";
import { applyCopyRemoval } from "@/lib/copy/remove";
import { CountMismatchError } from "@/lib/sync/count-check";
import { asOwner, asSuperuser, freshRpcDb, OWNER } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const HEADER =
  "Type;Category;Locale;Series;Set;Id;Number;Name;Variant;Rarity;Illustrator;Quantity;Price;Notes";
/** A card whose SET the mirror knows (Ancient Origins → xy7) but whose NUMBER it does not carry. */
const row = (qty: number) =>
  `collection;Pokemon;English;XY;Ancient Origins;xy7-99;99;Mystery Card;Normal;Rare;;${qty};;`;
/** UTF-16LE with BOM, the real export's physical format (lib/sync/csv.ts). */
function exportBytes(qty: number): Uint8Array {
  const body = Buffer.from(`${HEADER}\n${row(qty)}\n`, "utf16le");
  return Uint8Array.from([0xff, 0xfe, ...body]);
}

const CARD = "xy7-012";
const OTHER = "xy7-013";

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await db.exec(`
    insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id, types) values
      ('${CARD}', 'Card A', 'xy7', 'Ancient Origins', '012', '{Fire}'),
      ('${OTHER}', 'Card B', 'xy7', 'Ancient Origins', '013', '{Fire}');
  `);
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

/** Import an export whose one row parks, and return the parked entry's id. */
async function parked(qty = 1): Promise<string> {
  const client = pgliteClient(db);
  const first = await runSyncPipeline(client, exportBytes(qty));
  await executeApply(client, first.bundle, OWNER);
  const { rows } = await db.query<{ id: string }>("select id from unresolved_entry");
  expect(rows).toHaveLength(1);
  return rows[0].id;
}

/** She removed `count` copies of CARD while Dex still listed it (what UIL-089's "Not mine" records). */
async function removed(count: number): Promise<void> {
  await asSuperuser(db);
  await db.query(
    `insert into removed_presence (owner_id, catalog_card_id, dex_variant_raw, count)
       values ($1, $2, 'Normal', $3)`,
    [OWNER, CARD, count],
  );
  await asOwner(db);
}

async function copiesOf(card = CARD): Promise<number> {
  const r = await db.query<{ n: number }>(
    "select count(*)::int as n from copy where catalog_card_id = $1",
    [card],
  );
  return r.rows[0].n;
}
async function memory(): Promise<number | null> {
  const r = await db.query<{ count: number }>(
    "select count from removed_presence where catalog_card_id = $1 and dex_variant_raw = 'Normal'",
    [CARD],
  );
  return r.rows[0]?.count ?? null;
}
async function entry(id: string) {
  const r = await db.query<{ status: string; manual_match_id: string | null }>(
    "select status, manual_match_id from unresolved_entry where id = $1",
    [id],
  );
  return r.rows[0];
}
/** Two Dex rows for one card: `xy7-12` resolves to CARD on import, the `xy7-99` row waits for her match. */
const RESOLVED_ROW =
  "collection;Pokemon;English;XY;Ancient Origins;xy7-12;12;Card A;Normal;Rare;;1;;";
async function twoRowsImported(): Promise<{ resolvedCopyId: string; waitingEntryId: string }> {
  const client = pgliteClient(db);
  const body = Buffer.from(`${HEADER}\n${RESOLVED_ROW}\n${row(1)}\n`, "utf16le");
  const first = await runSyncPipeline(client, Uint8Array.from([0xff, 0xfe, ...body]));
  await executeApply(client, first.bundle, OWNER);
  const [a] = (
    await db.query<{ id: string }>("select id from copy where catalog_card_id = $1", [CARD])
  ).rows;
  const [e] = (
    await db.query<{ id: string }>("select id from unresolved_entry where status = 'WAITING'")
  ).rows;
  return { resolvedCopyId: a.id, waitingEntryId: e.id };
}

/**
 * Forget that any import was recorded (UIL-100's `dex_import` header and its rows) — the state of a
 * collection whose last import predates 0022, where there is nothing to be exact against.
 */
async function unrecorded(): Promise<void> {
  await asSuperuser(db);
  await db.exec("delete from dex_presence; delete from dex_import;");
  await asOwner(db);
}

/** What the next import of the same export proposes. */
async function nextImport(qty = 1) {
  const plan = (await runSyncPipeline(pgliteClient(db), exportBytes(qty))).bundle.plan;
  return {
    parks: plan.unresolved.length,
    creates: plan.creates.map((c) => c.catalogCardId),
    retires: plan.retires.length,
  };
}

describe("UIL-099 E2 · a manual match does not hand back a card she removed", () => {
  it("adds none of a card she removed, still records the match, and says what it held back", async () => {
    const id = await parked(1);
    await removed(1);

    const res = await manualMatch(pgliteClient(db), id, CARD);

    // PRE-FIX: 1 copy — the card she removed, back in her haul.
    expect(await copiesOf()).toBe(0);
    expect(res.created).toBe(0);
    expect(res.withheld).toEqual({ count: 1, catalogCardId: CARD, dexVariantRaw: "Normal" });
    // Recorded, so every later import resolves this row to her card instead of parking it again.
    expect(await entry(id)).toEqual({ status: "RESOLVED", manual_match_id: CARD });
    // The memory is untouched: the next import subtracts it from the same key.
    expect(await memory()).toBe(1);
  });

  it("the next import agrees with the match: nothing parks, nothing is created, nothing retires", async () => {
    const id = await parked(1);
    await removed(1);
    await manualMatch(pgliteClient(db), id, CARD);
    expect(await nextImport(1)).toEqual({ parks: 0, creates: [], retires: 0 });
  });

  it("a Dex row of 2 with 1 removed adds 1 and holds back 1", async () => {
    const id = await parked(2);
    await removed(1);
    const res = await manualMatch(pgliteClient(db), id, CARD);
    expect(await copiesOf()).toBe(1);
    expect(res.withheld?.count).toBe(1);
    expect(await nextImport(2)).toEqual({ parks: 0, creates: [], retires: 0 });
  });

  it("with nothing removed it adds the row's quantity and holds nothing back", async () => {
    const id = await parked(2);
    const res = await manualMatch(pgliteClient(db), id, CARD);
    expect(await copiesOf()).toBe(2);
    expect(res.withheld).toBeNull();
  });

  it("counts the row's quantity the way the import does: a stored 0 creates nothing, still matched", async () => {
    // The import never parks a 0 (`parseQuantity` reads a blank or 0 cell as one copy), so the row is set
    // to 0 by hand here. What this pins is ONE normaliser for both paths, not a new behaviour.
    const id = await parked(1);
    await asSuperuser(db);
    await db.query("update unresolved_entry set quantity = 0 where id = $1", [id]);
    await asOwner(db);
    const res = await manualMatch(pgliteClient(db), id, CARD);
    expect(await copiesOf()).toBe(0);
    expect(res.created).toBe(0);
    expect(await entry(id)).toEqual({ status: "RESOLVED", manual_match_id: CARD });
  });
});

describe("UIL-099 E2 · Add it back", () => {
  it("returns the held-back card to her haul and forgets the removal; the next import agrees", async () => {
    const id = await parked(1);
    await removed(1);
    await manualMatch(pgliteClient(db), id, CARD);

    const res = await restoreWithheldForEntry(pgliteClient(db), id);

    expect(res).toEqual({ restored: 1 });
    const back = await db.query<{ role: string; grouped: boolean }>(
      "select role, presence_group_id is not null as grouped from copy where catalog_card_id = $1",
      [CARD],
    );
    // In her haul, and in the row's presence group, so the next import can see it (UIL-098's rule).
    expect(back.rows).toEqual([{ role: "haul", grouped: true }]);
    expect(await memory()).toBeNull();
    expect(await nextImport(1)).toEqual({ parks: 0, creates: [], retires: 0 });
  });

  it("pressed twice, it adds the card once", async () => {
    const id = await parked(1);
    await removed(1);
    await manualMatch(pgliteClient(db), id, CARD);
    await restoreWithheldForEntry(pgliteClient(db), id);

    const again = await restoreWithheldForEntry(pgliteClient(db), id);

    expect(again).toEqual({ restored: 0, alreadyRestored: true });
    expect(await copiesOf()).toBe(1);
  });

  it("two racing presses add the card once", async () => {
    const id = await parked(1);
    await removed(1);
    await manualMatch(pgliteClient(db), id, CARD);

    const both = await Promise.all([
      restoreWithheldForEntry(pgliteClient(db), id),
      restoreWithheldForEntry(pgliteClient(db), id),
    ]);

    expect(both.map((r) => r.restored).sort()).toEqual([0, 1]);
    expect(await copiesOf()).toBe(1);
    expect(await memory()).toBeNull();
  });

  it("when she removed MORE than Dex lists, it adds back the row's worth and the memory goes (E1, recorded)", async () => {
    // A memory can exceed what Dex now lists: the import never shrinks one while Dex still names the key.
    // Afterwards the key holds 1 against a record of 1, so no removal is left to subtract — keeping 2 would
    // have the next import retire the card she just added back (and UIL-100's check refuses exactly that).
    const id = await parked(1);
    await removed(3);
    const matched = await manualMatch(pgliteClient(db), id, CARD);
    expect(matched.withheld?.count).toBe(1);
    expect(matched.created).toBe(0);

    expect(await restoreWithheldForEntry(pgliteClient(db), id)).toEqual({ restored: 1 });
    expect(await memory()).toBeNull();
    expect(await copiesOf()).toBe(1);
    expect(await nextImport(1)).toEqual({ parks: 0, creates: [], retires: 0 });
    // And once only: the second press finds the first press's copy.
    expect(await restoreWithheldForEntry(pgliteClient(db), id)).toEqual({
      restored: 0,
      alreadyRestored: true,
    });
  });

  it("with no import recorded, it adds back the row's worth and keeps the rest of the memory", async () => {
    // The case where a recomputing second press would otherwise keep finding memory left to hand back.
    const id = await parked(1);
    await unrecorded();
    await removed(3);
    const matched = await manualMatch(pgliteClient(db), id, CARD);
    // Held back at most the row's own quantity, never the whole memory.
    expect(matched.withheld?.count).toBe(1);
    expect(matched.created).toBe(0);

    expect(await restoreWithheldForEntry(pgliteClient(db), id)).toEqual({ restored: 1 });
    expect(await memory()).toBe(2);
    expect(await restoreWithheldForEntry(pgliteClient(db), id)).toEqual({
      restored: 0,
      alreadyRestored: true,
    });
    expect(await copiesOf()).toBe(1);
    expect(await memory()).toBe(2);
  });

  it("is refused on a row that is not matched, and writes nothing", async () => {
    const id = await parked(1);
    await removed(1);
    await expect(restoreWithheldForEntry(pgliteClient(db), id)).rejects.toThrow(
      RESTORE_REFUSED.notMatched,
    );
    expect(await copiesOf()).toBe(0);
    expect(await memory()).toBe(1);
  });
});

describe("UIL-099 E1 · once an import is recorded, a match inserts the difference", () => {
  it("another Dex row already on the card, and a removal: the match adds up, with no refusal", async () => {
    // Dex lists two rows for one card: A resolves, the other waits for her match. She removed A's copy
    // ("Not mine"), so the card holds 0 against a record of 1 minus 1 removed. The match must bring the
    // key to (1 + 1) − 1 = 1. Withholding "up to what she removed" would add 0, count her removal a second
    // time, and UIL-100's check would refuse the match with nothing she could do.
    const client = pgliteClient(db);
    const { resolvedCopyId, waitingEntryId } = await twoRowsImported();
    await applyCopyRemoval(client, resolvedCopyId);
    expect(await memory()).toBe(1);

    const res = await manualMatch(client, waitingEntryId, CARD);

    expect(res.created).toBe(1);
    expect(res.withheld).toBeNull(); // the removal was A's, and it is still subtracted from A
    expect(await copiesOf()).toBe(1);
    expect(await memory()).toBe(1);
  });

  it("two racing presses that insert nothing: the loser trips the count check, and still reports success", async () => {
    // With every copy withheld, neither press inserts, so no key collides: the loser's own transaction
    // adds the row to the record a second time and UIL-100's check refuses it. The row DID match — the
    // first press landed — so the re-read must come before reading the refusal, or a double click shows
    // her an error for a match that worked.
    const client = pgliteClient(db);
    const { resolvedCopyId, waitingEntryId } = await twoRowsImported();
    await applyCopyRemoval(client, resolvedCopyId);
    await asSuperuser(db);
    await db.query("update removed_presence set count = 2 where catalog_card_id = $1", [CARD]);
    await asOwner(db);

    const both = await Promise.all([
      manualMatch(pgliteClient(db), waitingEntryId, CARD),
      manualMatch(pgliteClient(db), waitingEntryId, CARD),
    ]);

    expect(both.filter((r) => r.alreadyMatched)).toHaveLength(1);
    expect(await copiesOf()).toBe(0);
  });

  it("Add it back on a card that already disagrees with Dex is refused by the check, and writes nothing", async () => {
    const id = await parked(1);
    await removed(1);
    await manualMatch(pgliteClient(db), id, CARD);
    // An extra copy appears in the group: the card now holds 1 against Dex's 1 minus 1 removed.
    await asSuperuser(db);
    const [g] = (
      await db.query<{ id: string }>("select id from presence_group where catalog_card_id = $1", [
        CARD,
      ])
    ).rows;
    await db.query(
      `insert into copy (owner_id, catalog_card_id, variant, dex_variant_raw, presence_group_id, role)
         values ($1, $2, 'normal', 'Normal', $3, 'haul')`,
      [OWNER, CARD, g.id],
    );
    await asOwner(db);

    const err = await restoreWithheldForEntry(pgliteClient(db), id).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CountMismatchError);
    expect((err as Error).message).toMatch(/Nothing was added back/);
    expect(await copiesOf()).toBe(1);
    expect(await memory()).toBe(1);
  });

  it("with no import recorded, a partial record from earlier matches is not treated as exact", async () => {
    // Before an import is recorded the record holds only rows matched since 0022, so it cannot say what
    // Dex lists. A second row onto a card whose first match she removed keeps the unrecorded rule: its
    // copy is held back; the next import (which records the file) creates any difference.
    const client = pgliteClient(db);
    const { resolvedCopyId, waitingEntryId } = await twoRowsImported();
    await unrecorded();
    await applyCopyRemoval(client, resolvedCopyId);
    await asSuperuser(db);
    await db.query(
      `insert into dex_presence (owner_id, catalog_card_id, dex_variant_raw, quantity)
         values ($1, $2, 'Normal', 1)`,
      [OWNER, CARD],
    );
    await asOwner(db);

    const res = await manualMatch(client, waitingEntryId, CARD);

    expect(res.created).toBe(0);
    expect(res.withheld?.count).toBe(1);
  });

  it("with no import recorded, a removal still holds back the match's own copies", async () => {
    const id = await parked(1);
    await unrecorded();
    await removed(1);
    const res = await manualMatch(pgliteClient(db), id, CARD);
    expect(res.created).toBe(0);
    expect(res.withheld?.count).toBe(1);
    expect(await copiesOf()).toBe(0);
  });
});

describe("UIL-099 · a manual match is applied once", () => {
  it("a second press on the same card adds nothing and reports the match as already made", async () => {
    const id = await parked(2);
    await manualMatch(pgliteClient(db), id, CARD);

    const again = await manualMatch(pgliteClient(db), id, CARD);

    // PRE-FIX: 4 copies for a Dex row of 2.
    expect(await copiesOf()).toBe(2);
    expect(again.alreadyMatched).toBe(true);
    expect(again.created).toBe(0);
  });

  it("two racing presses add the row's cards once", async () => {
    const id = await parked(2);
    const both = await Promise.all([
      manualMatch(pgliteClient(db), id, CARD),
      manualMatch(pgliteClient(db), id, CARD),
    ]);
    expect(await copiesOf()).toBe(2);
    expect(both.filter((r) => r.alreadyMatched)).toHaveLength(1);
  });

  it("two racing presses add the row once even when the card ALREADY has a presence group", async () => {
    // The group exists because another Dex row resolved to the same card, so neither press creates it and
    // presence_group's unique key cannot catch the second one. Only the derived copy ids can.
    const RESOLVED_ROW =
      "collection;Pokemon;English;XY;Ancient Origins;xy7-12;12;Card A;Normal;Rare;;1;;";
    const client = pgliteClient(db);
    const body = Buffer.from(`${HEADER}\n${RESOLVED_ROW}\n${row(2)}\n`, "utf16le");
    const first = await runSyncPipeline(client, Uint8Array.from([0xff, 0xfe, ...body]));
    await executeApply(client, first.bundle, OWNER);
    expect(await copiesOf()).toBe(1);
    const { rows } = await db.query<{ id: string }>("select id from unresolved_entry");

    await Promise.all([
      manualMatch(client, rows[0].id, CARD),
      manualMatch(client, rows[0].id, CARD),
    ]);

    // 1 from the resolved row + 2 from the match. With random ids: 5.
    expect(await copiesOf()).toBe(3);
  });

  it("a press for a DIFFERENT card on a matched row is refused, and writes nothing", async () => {
    const id = await parked(1);
    await manualMatch(pgliteClient(db), id, CARD);
    await expect(manualMatch(pgliteClient(db), id, OTHER)).rejects.toThrow(
      MATCH_REFUSED.matchedElsewhere(CARD),
    );
    expect(await copiesOf(OTHER)).toBe(0);
    expect(await entry(id)).toEqual({ status: "RESOLVED", manual_match_id: CARD });
  });

  it("a row an import already resolved is refused: its cards came from that import", async () => {
    const id = await parked(1);
    await asSuperuser(db);
    await db.query("update unresolved_entry set status = 'RESOLVED' where id = $1", [id]);
    await asOwner(db);
    await expect(manualMatch(pgliteClient(db), id, CARD)).rejects.toThrow(
      MATCH_REFUSED.resolvedByImport,
    );
    expect(await copiesOf()).toBe(0);
  });

  it("a second stand-in press on the same row makes no second stand-in and adds nothing", async () => {
    const id = await parked(1);
    const input = {
      name: "Mystery Card",
      setName: "Ancient Origins",
      setId: "xy7",
      localId: "99",
      kind: { kind: "pokemon" as const, type: "Fire", stage: "Basic" as const },
    };
    const first = await manualMatchStandIn(pgliteClient(db), id, input);
    const again = await manualMatchStandIn(pgliteClient(db), id, input);

    expect(again.alreadyMatched).toBe(true);
    expect(again.standInId).toBe(first.standInId);
    const standIns = await db.query<{ n: number }>(
      "select count(*)::int as n from catalog_card where source = 'user'",
    );
    expect(standIns.rows[0].n).toBe(1);
    expect(await copiesOf(first.standInId)).toBe(1);
  });
});
