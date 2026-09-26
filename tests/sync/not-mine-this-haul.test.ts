/**
 * UIL-111 — "Not mine" is for THIS HAUL ONLY (Karvi's ruling). It clears the card now; the next FULL Dex import
 * brings it back if Dex still lists it; a Dex error is fixed in Dex, or she presses "Not mine" again.
 *
 * This reverses UIL-089's persistent memory, and the Senior BA approved the plan's pieces, each pinned here:
 *   1. a full import ignores and forgets EVERY memory, while within the haul (Retry, a manual match, the Count
 *      check) a memory still counts;
 *   2. E2's withheld / "Add it back" keep working within the haul (tests/sync/manual-match-honours-removal.test.ts);
 *   3. the import's in-transaction count check agrees with the returning import, and the Count check reads zero
 *      removed afterwards;
 *   4. Undo of an import that forgot memories puts them back, including the worked example as its own case;
 *   6. the preview names what comes back, and a returning card makes the import a reviewed one.
 * Real PGlite, real RLS, the real pipeline, apply and Undo.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { executeApply, executeUndo } from "@/lib/sync";
import { runSyncPipeline } from "@/lib/sync/pipeline";
import { applyRemovedMemory, presenceKey, toPresenceMap } from "@/lib/sync/diff";
import { loadCountCheck } from "@/lib/sync/count-check-load";
import { RETURNING_NOTE } from "@/lib/sync/preview";
import { applyCopyRemoval } from "@/lib/copy";
import { asOwner, asSuperuser, freshRpcDb, OWNER, seedBinders } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const HEADER =
  "Type;Category;Locale;Series;Set;Id;Number;Name;Variant;Rarity;Illustrator;Quantity;Price;Notes";
const row = (id: string, number: string, name: string, qty = 1) =>
  `collection;Pokemon;English;SV;Obsidian Flames;${id};${number};${name};Normal;Common;;${qty};;`;
const CHARMANDER = row("sv03-026", "026", "Charmander");
const CHARMELEON = row("sv03-027", "027", "Charmeleon");
/** A row the catalog cannot resolve yet, so it parks and waits (for the Retry case). */
const MYSTERY = row("sv03-099", "099", "Mystery", 2);
const bytes = (...rows: string[]) =>
  Uint8Array.from([0xff, 0xfe, ...Buffer.from(`${HEADER}\n${rows.join("\n")}\n`, "utf16le")]);

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await db.exec(`
    insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id, types, stage, dex_id) values
      ('sv03-026', 'Charmander', 'sv03', 'Obsidian Flames', '026', '{Fire}', 'Basic', '{4}'),
      ('sv03-027', 'Charmeleon', 'sv03', 'Obsidian Flames', '027', '{Fire}', 'Stage1', '{5}');
  `);
  await seedBinders(db, [
    { id: "1c000000-0000-0000-0000-0000000000b1", type: "general", name: "B1" },
  ]);
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

const client = () => pgliteClient(db);
async function q<T>(sql: string): Promise<T[]> {
  await asSuperuser(db);
  const r = await db.query<T>(sql);
  await asOwner(db);
  return r.rows;
}
const copiesOf = async (card: string) =>
  (await q<{ n: number }>(`select count(*)::int n from copy where catalog_card_id = '${card}'`))[0]
    .n;
const memories = () =>
  q<{ catalog_card_id: string; count: number }>(
    "select catalog_card_id, count from removed_presence order by catalog_card_id",
  );
async function importFile(...rows: string[]) {
  const run = await runSyncPipeline(client(), bytes(...rows));
  await executeApply(client(), run.bundle, OWNER);
  return run;
}
/** "Not mine" on one copy of `card`, as the button does it. */
async function notMine(card: string) {
  const [c] = await q<{ id: string }>(
    `select id from copy where catalog_card_id = '${card}' limit 1`,
  );
  const res = await applyCopyRemoval(client(), c.id);
  expect(res.ok).toBe(true);
}

describe("UIL-111 · a full import ends the haul", () => {
  it("brings back a card she marked Not mine that Dex still lists, and forgets the memory", async () => {
    await importFile(CHARMANDER);
    await notMine("sv03-026");
    expect(await copiesOf("sv03-026")).toBe(0);
    expect(await memories()).toEqual([{ catalog_card_id: "sv03-026", count: 1 }]);

    const run = await runSyncPipeline(client(), bytes(CHARMANDER));
    expect(run.bundle.plan.returning).toEqual([
      { catalogCardId: "sv03-026", dexVariantRaw: "Normal", count: 1 },
    ]);
    await executeApply(client(), run.bundle, OWNER);

    // PRE-FIX: 0 copies and the memory kept, the UIL-089 rule this ruling reverses.
    expect(await copiesOf("sv03-026")).toBe(1);
    expect(await memories()).toEqual([]);
  });

  it("forgets EVERY memory, including one whose card Dex no longer lists (which comes back as nothing)", async () => {
    await importFile(CHARMANDER, CHARMELEON);
    await notMine("sv03-026");
    await notMine("sv03-027");

    const run = await runSyncPipeline(client(), bytes(CHARMANDER)); // Charmeleon is gone from the file
    expect(run.bundle.plan.returning.map((r) => r.catalogCardId)).toEqual(["sv03-026"]);
    expect(run.bundle.plan.forgetRemoved.map((r) => r.catalogCardId).sort()).toEqual([
      "sv03-026",
      "sv03-027",
    ]);
    await executeApply(client(), run.bundle, OWNER);
    expect(await memories()).toEqual([]);
    expect(await copiesOf("sv03-027")).toBe(0);
  });

  it("the import's own count check agrees, and the Count check reads nothing removed afterwards", async () => {
    await importFile(CHARMANDER, CHARMELEON);
    await notMine("sv03-026");
    // Within the haul the Count check counts the removal, so nothing reads as missing.
    expect(await loadCountCheck(client())).toMatchObject({ mismatches: [], removed: 1 });

    // The in-transaction check (0024's assert_presence_counts) runs after the forget: this apply succeeding
    // is that check passing on "copies = what Dex lists".
    await importFile(CHARMANDER, CHARMELEON);
    expect(await loadCountCheck(client())).toMatchObject({ mismatches: [], removed: 0 });
  });

  it("the preview names what comes back, in her words, and the import is a reviewed one", async () => {
    await importFile(CHARMANDER);
    await notMine("sv03-026");
    const { preview } = await runSyncPipeline(client(), bytes(CHARMANDER));

    expect(preview.kind).toBe("gated"); // never the silent fast path (the Senior BA's ruling)
    expect(preview.sections.returning).toMatchObject([
      {
        catalogCardId: "sv03-026",
        name: "Charmander",
        setName: "Obsidian Flames",
        dexVariantRaw: "Normal",
        count: 1,
      },
    ]);
    expect(preview.summary.summaryLine).toContain("1 card you marked Not mine comes back");
    expect(RETURNING_NOTE).toMatch(/fix it in Dex, or press Not mine again/);
  });

  it("the apply itself records a reviewed import, never the fast path (QA's follow-up on #372)", async () => {
    // The preview gating (above) keeps the screen from auto-applying; this pins the apply's own verdict,
    // which rides in its result and in the Undo snapshot, and which nothing else would catch if it drifted.
    await importFile(CHARMANDER);
    await notMine("sv03-026");
    const run = await runSyncPipeline(client(), bytes(CHARMANDER));
    expect((await executeApply(client(), run.bundle, OWNER)).fastPath).toBe(false);

    // Control: an import that only adds a card she never cleared is still the fast path.
    const adds = await runSyncPipeline(client(), bytes(CHARMANDER, CHARMELEON));
    expect((await executeApply(client(), adds.bundle, OWNER)).fastPath).toBe(true);
  });

  it("an import with nothing coming back is not gated by this", async () => {
    await importFile(CHARMANDER);
    const { preview } = await runSyncPipeline(client(), bytes(CHARMANDER, CHARMELEON));
    expect(preview.sections.returning).toEqual([]);
    expect(preview.kind).toBe("fastpath");
  });
});

describe("UIL-111 · within the haul, the memory still counts", () => {
  it("a Retry honours it and does not forget it", async () => {
    await importFile(MYSTERY); // parks: the catalog has no sv03-099 yet
    await asSuperuser(db);
    await db.exec(`
      insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id, types, stage, dex_id)
        values ('sv03-099', 'Mystery', 'sv03', 'Obsidian Flames', '099', '{Fire}', 'Basic', '{6}');
      insert into removed_presence (owner_id, catalog_card_id, dex_variant_raw, count)
        values ('${OWNER}', 'sv03-099', 'Normal', 1);
    `);
    await asOwner(db);

    const retry = await runSyncPipeline(client(), null);
    expect(retry.bundle.plan.returning).toEqual([]);
    expect(retry.bundle.plan.forgetRemoved).toEqual([]);
    await executeApply(client(), retry.bundle, OWNER);
    expect(await copiesOf("sv03-099")).toBe(1); // 2 listed, 1 cleared: the haul is not over
    expect(await memories()).toEqual([{ catalog_card_id: "sv03-099", count: 1 }]);
  });

  it("the rule itself: subtracted within the haul, ignored and forgotten on a full import", () => {
    const dex = toPresenceMap([{ catalogCardId: "a", dexVariantRaw: "Normal", count: 3 }]);
    const current = toPresenceMap([{ catalogCardId: "a", dexVariantRaw: "Normal", count: 1 }]);
    const removed = [
      { catalogCardId: "a", dexVariantRaw: "Normal", count: 2 },
      { catalogCardId: "b", dexVariantRaw: "Normal", count: 1 },
    ];
    const inHaul = applyRemovedMemory(dex, removed, false, current);
    expect(inHaul.desired.get(presenceKey("a", "Normal"))?.count).toBe(1);
    expect(inHaul.forget).toEqual([]);
    expect(inHaul.returning).toEqual([]);

    const full = applyRemovedMemory(dex, removed, true, current);
    expect(full.desired.get(presenceKey("a", "Normal"))?.count).toBe(3);
    expect(full.forget).toEqual(removed);
    // min(memory 2, dex 3 − current 1) = 2 come back for a; b is not listed, so nothing comes back for it.
    expect(full.returning).toEqual([{ catalogCardId: "a", dexVariantRaw: "Normal", count: 2 }]);

    // Bounded by BOTH: never more than she cleared, and never more than the key is short.
    const one = [{ catalogCardId: "a", dexVariantRaw: "Normal", count: 1 }];
    expect(applyRemovedMemory(dex, one, true, current).returning[0].count).toBe(1); // memory-bound
    const two = [{ catalogCardId: "a", dexVariantRaw: "Normal", count: 2 }];
    const short1 = toPresenceMap([{ catalogCardId: "a", dexVariantRaw: "Normal", count: 2 }]);
    expect(applyRemovedMemory(dex, two, true, short1).returning[0].count).toBe(1); // 3 − 2: shortfall-bound
  });
});

describe("UIL-111 · Undo of an import that forgot memories puts them back", () => {
  it("the card goes, the memory returns, and the collection adds up as it did before the import", async () => {
    await importFile(CHARMANDER, CHARMELEON);
    await notMine("sv03-026");
    await notMine("sv03-027");
    await importFile(CHARMANDER); // brings Charmander back; forgets both memories

    await executeUndo(client());

    expect(await copiesOf("sv03-026")).toBe(0);
    expect(await memories()).toEqual([
      { catalog_card_id: "sv03-026", count: 1 },
      { catalog_card_id: "sv03-027", count: 1 },
    ]);
    expect(await loadCountCheck(client())).toMatchObject({ mismatches: [] });
  });

  it("each memory comes back with its own count", async () => {
    await importFile(row("sv03-026", "026", "Charmander", 2));
    await notMine("sv03-026");
    await notMine("sv03-026");
    expect(await memories()).toEqual([{ catalog_card_id: "sv03-026", count: 2 }]);
    await importFile(row("sv03-026", "026", "Charmander", 2));
    expect(await copiesOf("sv03-026")).toBe(2);

    await executeUndo(client());
    expect(await memories()).toEqual([{ catalog_card_id: "sv03-026", count: 2 }]);
    expect(await copiesOf("sv03-026")).toBe(0);
  });

  it("the worked example: a memory, the card returns, Not mine again, Undo: exactly the state before the import", async () => {
    await importFile(CHARMANDER);
    await notMine("sv03-026"); // memory 1, no copy
    const before = { copies: await copiesOf("sv03-026"), memories: await memories() };

    await importFile(CHARMANDER); // the card returns, the memory is forgotten
    expect(await copiesOf("sv03-026")).toBe(1);
    await notMine("sv03-026"); // she clears the returned card again: memory 1
    expect(await memories()).toEqual([{ catalog_card_id: "sv03-026", count: 1 }]);

    // Undo shrinks the memory she recorded against the card this import handed back (1 → 0), then puts the
    // forgotten memory back (0 → 1). Its own count check running last is what lets it apply at all.
    await executeUndo(client());

    expect({ copies: await copiesOf("sv03-026"), memories: await memories() }).toEqual(before);
    expect(before).toEqual({ copies: 0, memories: [{ catalog_card_id: "sv03-026", count: 1 }] });
    expect(await loadCountCheck(client())).toMatchObject({ mismatches: [] });
  });
});
