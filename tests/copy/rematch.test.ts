/**
 * "Wrong card?" — a waiting copy the sync matched to the wrong card is rematched from the Haul Plan (Karvi,
 * 2026-10-26), or given a stand-in.
 *
 * Driven through the REAL pipeline against real Postgres (PGlite, every migration, real RLS): a real Dex export is
 * imported, then one copy is rematched with the real `rematch_copy` function. What matters is not that the copy
 * moves but that everything that counts it moves with it, so the Count check (copies = Dex − removed per card, and the
 * file total) still adds up afterwards.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { executeApply, StandInTwinError } from "@/lib/sync";
import { runSyncPipeline } from "@/lib/sync/pipeline";
import { loadCountCheck } from "@/lib/sync/count-check-load";
import { rematchCopy, rematchCopyToStandIn, type RematchStandInInput } from "@/lib/copy";
import { asOwner, asSuperuser, freshRpcDb, OWNER } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const HEADER =
  "Type;Category;Locale;Series;Set;Id;Number;Name;Variant;Rarity;Illustrator;Quantity;Price;Notes";
const row = (id: string, number: string, name: string, quantity = 1, variant = "Normal") =>
  `collection;Pokemon;English;SV;Obsidian Flames;${id};${number};${name};${variant};Common;;${quantity};;`;

function exportBytes(rows: string[]): Uint8Array {
  const body = Buffer.from(`${HEADER}\n${rows.join("\n")}\n`, "utf16le");
  return Uint8Array.from([0xff, 0xfe, ...body]);
}

/** The card the sync matched (wrongly), and the one it should have been. */
const WRONG = "sv03-026";
const RIGHT = "sv03-027";

let db: PGlite;
const client = () => pgliteClient(db);

beforeEach(async () => {
  db = await freshRpcDb();
  await db.exec(`
    insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id, types, stage, dex_id)
      values ('${WRONG}', 'Charmander', 'sv03', 'Obsidian Flames', '026', '{Fire}', 'Basic', '{4}'),
             ('${RIGHT}', 'Charmeleon', 'sv03', 'Obsidian Flames', '027', '{Fire}', 'Stage1', '{5}');
  `);
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

async function importRows(rows: string[]) {
  const run = await runSyncPipeline(client(), exportBytes(rows));
  await executeApply(client(), run.bundle, OWNER);
}

async function q<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
  await asSuperuser(db);
  const r = await db.query<T>(sql);
  await asOwner(db);
  return r.rows;
}

const copiesOf = (card: string) =>
  q<{ id: string; presence_group_id: string }>(
    `select id, presence_group_id from copy where catalog_card_id = '${card}' order by id`,
  );
const dex = (card: string) =>
  q<{ quantity: number }>(`select quantity from dex_presence where catalog_card_id = '${card}'`);
const group = (card: string) =>
  q<{ desired_count: number }>(
    `select desired_count from presence_group where catalog_card_id = '${card}'`,
  );

describe("rematching one waiting copy", () => {
  it("moves one copy of two, and its count, to the right card; the Count check still adds up", async () => {
    await importRows([row("sv03-026", "026", "Charmander", 2)]);
    expect((await loadCountCheck(client())).status).toBe("ok");
    const [first] = await copiesOf(WRONG);

    await rematchCopy(client(), first.id, RIGHT);

    expect(await copiesOf(WRONG)).toHaveLength(1);
    expect(await copiesOf(RIGHT)).toHaveLength(1);
    // The count moved with the copy: 2 → 1 on the old key, a new record of 1 on the new one.
    expect(await dex(WRONG)).toEqual([{ quantity: 1 }]);
    expect(await dex(RIGHT)).toEqual([{ quantity: 1 }]);
    expect(await group(WRONG)).toEqual([{ desired_count: 1 }]);
    expect(await group(RIGHT)).toEqual([{ desired_count: 1 }]);
    const check = await loadCountCheck(client());
    expect(check.status).toBe("ok");
    expect(check.fileAddsUp).toBe(true);
    expect(check.mismatches).toEqual([]);
  });

  it("takes the old record away when it was the only copy, and joins her existing group for the right card", async () => {
    await importRows([row("sv03-026", "026", "Charmander"), row("sv03-027", "027", "Charmeleon")]);
    const [only] = await copiesOf(WRONG);

    await rematchCopy(client(), only.id, RIGHT);

    expect(await copiesOf(WRONG)).toEqual([]);
    expect(await copiesOf(RIGHT)).toHaveLength(2);
    // One group for the right card, now holding both; the wrong card's record is gone, not left at zero.
    expect(await group(RIGHT)).toEqual([{ desired_count: 2 }]);
    expect(await dex(WRONG)).toEqual([]);
    expect(await dex(RIGHT)).toEqual([{ quantity: 2 }]);
    expect(await group(WRONG)).toEqual([{ desired_count: 0 }]);
    const check = await loadCountCheck(client());
    expect(check.status).toBe("ok");
    expect(check.fileAddsUp).toBe(true);
  });

  it("refuses the card it is already matched to, and a card that is not in the catalog", async () => {
    await importRows([row("sv03-026", "026", "Charmander")]);
    const [c] = await copiesOf(WRONG);

    await expect(rematchCopy(client(), c.id, WRONG)).rejects.toThrow(/already matched/);
    await expect(rematchCopy(client(), c.id, "nope-1")).rejects.toThrow(/not in the catalog/);
    expect(await copiesOf(WRONG)).toHaveLength(1);
  });

  it("refuses a copy that is not hers or no longer exists", async () => {
    await expect(
      rematchCopy(client(), "00000000-0000-0000-0000-00000000dead", RIGHT),
    ).rejects.toThrow(/no longer in your collection/);
  });

  it("refuses a shelved copy, and changes nothing", async () => {
    await importRows([row("sv03-026", "026", "Charmander")]);
    const [c] = await copiesOf(WRONG);
    // Shelving writes the decision row (lib/plan/pending.ts: the row IS "no longer waiting").
    await asSuperuser(db);
    await db.exec(
      `insert into placement_decision (owner_id, copy_id, catalog_card_id, decision, reason, resolved_by)
         values ('${OWNER}', '${c.id}', '${WRONG}', 'shelve', 'test', 'user')`,
    );
    await asOwner(db);

    await expect(rematchCopy(client(), c.id, RIGHT)).rejects.toThrow(/already been shelved/);
    expect(await copiesOf(WRONG)).toHaveLength(1);
    expect(await dex(WRONG)).toEqual([{ quantity: 1 }]);
    expect(await dex(RIGHT)).toEqual([]);
  });
});

const STAND_IN: RematchStandInInput = {
  name: "Charmeleon (error print)",
  setName: "Obsidian Flames",
  localId: "027",
  language: "en",
  kind: { kind: "pokemon", type: "Fire", stage: "Stage1", dexId: 5 },
};

describe("rematching to a stand-in", () => {
  it("makes the stand-in and points the copy at it, counts moved", async () => {
    await importRows([row("sv03-026", "026", "Charmander")]);
    const [c] = await copiesOf(WRONG);

    const standInId = await rematchCopyToStandIn(client(), c.id, STAND_IN);

    expect(standInId).toMatch(/^user:en:/);
    expect(await copiesOf(standInId)).toHaveLength(1);
    expect(await copiesOf(WRONG)).toEqual([]);
    expect(await dex(standInId)).toEqual([{ quantity: 1 }]);
    const check = await loadCountCheck(client());
    expect(check.status).toBe("ok");
    expect(check.fileAddsUp).toBe(true);
  });

  it("refuses a twin, naming the stand-in she already made, and makes nothing", async () => {
    await importRows([row("sv03-026", "026", "Charmander", 2)]);
    const [a, b] = await copiesOf(WRONG);
    const made = await rematchCopyToStandIn(client(), a.id, STAND_IN);

    const err = await rematchCopyToStandIn(client(), b.id, STAND_IN).catch((e) => e);
    expect(err).toBeInstanceOf(StandInTwinError);
    expect((err as StandInTwinError).twin.tcgdex_id).toBe(made);
    expect(await q(`select 1 from catalog_card where source = 'user'`)).toHaveLength(1);
    // …and rematching the second copy to the stand-in she made is the remedy.
    await rematchCopy(client(), b.id, made);
    expect(await dex(made)).toEqual([{ quantity: 2 }]);
  });

  it("takes the new stand-in back when the database refuses the rematch", async () => {
    await importRows([row("sv03-026", "026", "Charmander")]);
    const [c] = await copiesOf(WRONG);
    await asSuperuser(db);
    await db.exec(
      `insert into placement_decision (owner_id, copy_id, catalog_card_id, decision, reason, resolved_by)
         values ('${OWNER}', '${c.id}', '${WRONG}', 'shelve', 'test', 'user')`,
    );
    await asOwner(db);

    await expect(rematchCopyToStandIn(client(), c.id, STAND_IN)).rejects.toThrow(
      /already been shelved/,
    );
    expect(await q(`select 1 from catalog_card where source = 'user'`)).toEqual([]);
  });

  it("needs a name and a language", async () => {
    await expect(
      rematchCopyToStandIn(client(), "00000000-0000-0000-0000-00000000dead", {
        ...STAND_IN,
        name: "  ",
      }),
    ).rejects.toThrow(/needs a name/);
    await expect(
      rematchCopyToStandIn(client(), "00000000-0000-0000-0000-00000000dead", {
        ...STAND_IN,
        language: "xx" as never,
      }),
    ).rejects.toThrow(/language/);
  });
});
