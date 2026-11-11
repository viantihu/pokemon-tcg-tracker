/**
 * Where a removed card left from, and refilling its spot from a bulk box (Karvi, 2026-11-11).
 *
 * Karvi's case: a card removed in Dex was traded or given away, and the same card can be in a binder AND a bulk
 * box. So the Sync page asks which one left whenever the copies sit in more than one place (and never when it
 * already knows), and when the card that left held a binder spot she can pull a bulk duplicate into her Haul Plan,
 * which then suggests where it goes like any waiting card.
 *
 * Every scenario runs the REAL pipeline, apply, Undo and Haul Plan queue on a real Postgres (PGlite) with every
 * migration and its in-transaction checks (presence counts, file total, line slots), so a change that breaks a
 * neighbouring rule fails here rather than on her phone.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  executeApply,
  executeUndo,
  REFILL_STALE,
  REMOVAL_UNANSWERED,
  removalQuestions,
  type CurrentGroup,
  type SyncOverrides,
} from "@/lib/sync";
import { runSyncPipeline } from "@/lib/sync/pipeline";
import { presenceKey } from "@/lib/sync/diff";
import {
  overridesToSend,
  pickRefill,
  pickWhere,
  refillOffer,
  rowIndexes,
  unansweredCount,
  whereOptions,
} from "@/lib/sync/removal-answers";
import { loadPendingPlacements, withBulkPullNotes } from "@/lib/plan/pending";
import { placementDecisionRepo } from "@/lib/repo";
import type { PlanItem } from "@/lib/plan";
import { asOwner, asSuperuser, freshRpcDb, OWNER, seedBinders } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const HEADER =
  "Type;Category;Locale;Series;Set;Id;Number;Name;Variant;Rarity;Illustrator;Quantity;Price;Notes";
const row = (id: string, number: string, name: string, qty = 1, variant = "Normal") =>
  `collection;Pokemon;English;SV;Obsidian Flames;${id};${number};${name};${variant};Common;;${qty};;`;
const bytes = (...rows: string[]) =>
  Uint8Array.from([0xff, 0xfe, ...Buffer.from(`${HEADER}\n${rows.join("\n")}\n`, "utf16le")]);

const B1 = "1c000000-0000-0000-0000-0000000000b1";
const BOX2 = "2c000000-0000-0000-0000-0000000000b2";
const PIKACHU = "sv03-062";
const KEY = presenceKey(PIKACHU, "Normal");

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await db.exec(`
    insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id, types, stage, dex_id) values
      ('${PIKACHU}', 'Pikachu', 'sv03', 'Obsidian Flames', '062', '{Lightning}', 'Basic', '{25}');
  `);
  await seedBinders(db, [{ id: B1, type: "general", name: "Binder 1" }]);
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

const client = () => pgliteClient(db);
async function q<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  await asSuperuser(db);
  const r = await db.query<T>(sql, params);
  await asOwner(db);
  return r.rows;
}
async function importFile(...rows: string[]) {
  const run = await runSyncPipeline(client(), bytes(...rows));
  await executeApply(client(), run.bundle, OWNER);
  return run;
}
const copies = () =>
  q<{ id: string; role: string; binder_id: string | null; bulk_unit_id: string | null }>(
    `select id, role, binder_id, bulk_unit_id from copy order by created_at, id`,
  );

/** Place one copy as she would have: shelved in Binder 1's front half, with the decision that placed it. */
async function shelve(id: string) {
  await q(
    `update copy set role = 'shelved', binder_id = $1, binder_half = 'front', color_band = 'yellow' where id = $2`,
    [B1, id],
  );
  await q(
    `insert into placement_decision (owner_id, copy_id, decision, reason, resolved_by)
       values ($1, $2, 'FRONT', 'test', 'auto')`,
    [OWNER, id],
  );
}
/** Put one copy in a bulk box, with the decision that sent it there (a routed duplicate). */
async function toBulk(id: string, box: string | null = null) {
  await q(`update copy set role = 'bulk', bulk_unit_id = $1 where id = $2`, [box, id]);
  await q(
    `insert into placement_decision (owner_id, copy_id, decision, reason, resolved_by)
       values ($1, $2, 'BULK', 'test', 'auto')`,
    [OWNER, id],
  );
}

/** A second box, "KB-2", beside her default one (a box needs a default to sit beside). */
async function addBox2(capacity: number | null = null) {
  await q(
    `insert into bulk_unit (id, owner_id, name, sort_order, is_default)
       values (md5('bulk-box:' || $1::text)::uuid, $1::uuid, 'Bulk box', 0, true) on conflict do nothing`,
    [OWNER],
  );
  await q(
    `insert into bulk_unit (id, owner_id, name, sort_order, capacity) values ($1, $2, 'KB-2', 5, $3)`,
    [BOX2, OWNER, capacity],
  );
}

/** Two Normal Pikachu: one in Binder 1, one in a bulk box. Returns [binderCopy, bulkCopy]. */
async function binderAndBulk(box: string | null = null): Promise<[string, string]> {
  await importFile(row(PIKACHU, "062", "Pikachu", 2));
  const [a, b] = await copies();
  await shelve(a.id);
  await toBulk(b.id, box);
  return [a.id, b.id];
}

describe("where did it leave from", () => {
  it("does not ask when she owns only one copy: the app already knows", async () => {
    await importFile(row(PIKACHU, "062", "Pikachu", 1));
    const [only] = await copies();
    await shelve(only.id);

    const run = await runSyncPipeline(client(), bytes()); // traded away: gone from Dex
    expect(run.preview.removalAsks?.[KEY]?.ambiguous).toBe(false);
    expect(unansweredCount(run.preview, {})).toBe(0);
    await executeApply(client(), run.bundle, OWNER);
    expect(await copies()).toEqual([]);
  });

  it("does not ask when every copy leaves", async () => {
    const [,] = await binderAndBulk();
    const run = await runSyncPipeline(client(), bytes());
    expect(run.preview.removalAsks?.[KEY]?.ambiguous).toBe(false);
    await executeApply(client(), run.bundle, OWNER);
    expect(await copies()).toEqual([]);
  });

  it("does not ask when both copies are in the same place", async () => {
    await importFile(row(PIKACHU, "062", "Pikachu", 2));
    const [a, b] = await copies();
    await toBulk(a.id);
    await toBulk(b.id);
    const run = await runSyncPipeline(client(), bytes(row(PIKACHU, "062", "Pikachu", 1)));
    expect(run.preview.removalAsks?.[KEY]?.ambiguous).toBe(false);
    await executeApply(client(), run.bundle, OWNER);
    expect(await copies()).toHaveLength(1);
  });

  it("asks when the copies are in different places, and Apply refuses until she answers — writing nothing", async () => {
    const [binder, bulk] = await binderAndBulk();
    const run = await runSyncPipeline(client(), bytes(row(PIKACHU, "062", "Pikachu", 1)));

    expect(run.preview.removalAsks?.[KEY]).toMatchObject({ ambiguous: true, leaving: 1 });
    expect(unansweredCount(run.preview, {})).toBe(1);
    const labels = whereOptions(run.preview, {}, KEY, 0).map((o) => o.label);
    expect(labels).toEqual(expect.arrayContaining(["Binder 1 · front · Yellow", "Bulk box"]));

    // PRE-FEATURE: this applied the app's guess (the bulk copy). Now it is refused, and nothing changes.
    await expect(executeApply(client(), run.bundle, OWNER)).rejects.toThrow(REMOVAL_UNANSWERED);
    expect((await copies()).map((c) => c.id).sort()).toEqual([binder, bulk].sort());
  });

  it("removes exactly the copy she says left — the binder one — and leaves the bulk one", async () => {
    const [binder, bulk] = await binderAndBulk();
    const run = await runSyncPipeline(client(), bytes(row(PIKACHU, "062", "Pikachu", 1)));
    const o = pickWhere(run.preview, {}, KEY, 0, binder);
    expect(unansweredCount(run.preview, o)).toBe(0);

    await executeApply(client(), run.bundle, OWNER, overridesToSend(run.preview, o));
    expect((await copies()).map((c) => c.id)).toEqual([bulk]);
  });

  it("handles two copies leaving at once from different places (the old dropdown silently ignored this)", async () => {
    await importFile(row(PIKACHU, "062", "Pikachu", 3));
    const [a, b, c] = await copies();
    await shelve(a.id);
    await shelve(b.id);
    await q(`update copy set binder_half = 'back' where id = $1`, [b.id]);
    await toBulk(c.id);

    const run = await runSyncPipeline(client(), bytes(row(PIKACHU, "062", "Pikachu", 1)));
    const rows = run.preview.sections.removals;
    expect(rows).toHaveLength(2);
    const idx = rowIndexes(rows);
    let o: SyncOverrides = pickWhere(run.preview, {}, KEY, idx[0], a.id);
    // The second row no longer offers the copy the first row took.
    expect(whereOptions(run.preview, o, KEY, idx[1]).map((x) => x.copyId)).not.toContain(a.id);
    o = pickWhere(run.preview, o, KEY, idx[1], b.id);

    await executeApply(client(), run.bundle, OWNER, overridesToSend(run.preview, o));
    expect((await copies()).map((x) => x.id)).toEqual([c.id]);
  });

  it("refuses an answer that names the same copy twice", async () => {
    await importFile(row(PIKACHU, "062", "Pikachu", 3));
    const [a, b, c] = await copies();
    await shelve(a.id);
    await toBulk(b.id);
    await toBulk(c.id);
    const run = await runSyncPipeline(client(), bytes(row(PIKACHU, "062", "Pikachu", 1)));
    await expect(
      executeApply(client(), run.bundle, OWNER, { retireChoice: { [KEY]: [a.id, a.id] } }),
    ).rejects.toThrow(REMOVAL_UNANSWERED);
  });
});

describe("refill from a bulk box", () => {
  it("offers the bulk duplicate when the card left a binder spot, and pulls it into the Haul Plan", async () => {
    const [binder, bulk] = await binderAndBulk();
    const run = await runSyncPipeline(client(), bytes(row(PIKACHU, "062", "Pikachu", 1)));
    let o = pickWhere(run.preview, {}, KEY, 0, binder);
    const row0 = run.preview.sections.removals[0];
    const offer = refillOffer(run.preview, o, row0, 0);
    expect(offer?.options.map((x) => x.copyId)).toEqual([bulk]);
    expect(offer?.options[0].label).toBe("Bulk box · Normal");
    o = pickRefill(o, binder, bulk);

    const res = await executeApply(client(), run.bundle, OWNER, overridesToSend(run.preview, o));
    expect(res.pulledFromBulk).toBe(1);

    // Back in her haul, out of the box, still the same card in the same presence group.
    expect(await copies()).toEqual([
      expect.objectContaining({ id: bulk, role: "haul", binder_id: null, bulk_unit_id: null }),
    ]);
    // In the Haul Plan's queue, though it had a decision sending it to bulk.
    expect((await loadPendingPlacements(client())).map((p) => p.copyId)).toEqual([bulk]);
    // Its plan row's reason says where it came from, ahead of the plan's own reason.
    const latest = await placementDecisionRepo.listLatestByCopy(client(), [bulk]);
    const item = { incomingId: bulk, reason: "Front half, yellow band." } as PlanItem;
    expect(withBulkPullNotes({ items: [item] }, latest).items[0].reason).toBe(
      "Pulled from Bulk box to replace a card you traded. Front half, yellow band.",
    );
  });

  it("names the box the card is in", async () => {
    await addBox2();
    const [binder, bulk] = await binderAndBulk(BOX2);
    const run = await runSyncPipeline(client(), bytes(row(PIKACHU, "062", "Pikachu", 1)));
    const o = pickWhere(run.preview, {}, KEY, 0, binder);
    expect(refillOffer(run.preview, o, run.preview.sections.removals[0], 0)?.options[0].label).toBe(
      "KB-2 · Normal",
    );
    await executeApply(
      client(),
      run.bundle,
      OWNER,
      overridesToSend(run.preview, pickRefill(o, binder, bulk)),
    );
    const latest = await placementDecisionRepo.listLatestByCopy(client(), [bulk]);
    expect(latest.get(bulk)?.reason).toBe("Pulled from KB-2 to replace a card you traded.");
  });

  it("offers nothing when the card that left WAS the bulk one", async () => {
    const [, bulk] = await binderAndBulk();
    const run = await runSyncPipeline(client(), bytes(row(PIKACHU, "062", "Pikachu", 1)));
    const o = pickWhere(run.preview, {}, KEY, 0, bulk);
    expect(refillOffer(run.preview, o, run.preview.sections.removals[0], 0)).toBeNull();
    // A stale client that still sends the pull is refused, not half-applied.
    await expect(
      executeApply(client(), run.bundle, OWNER, { ...o, bulkPulls: { [bulk]: bulk } }),
    ).rejects.toThrow(REFILL_STALE);
  });

  it("drops a refill answer when she changes her mind about which copy left", async () => {
    const [binder, bulk] = await binderAndBulk();
    const run = await runSyncPipeline(client(), bytes(row(PIKACHU, "062", "Pikachu", 1)));
    let o = pickRefill(pickWhere(run.preview, {}, KEY, 0, binder), binder, bulk);
    o = pickWhere(run.preview, o, KEY, 0, bulk); // "actually, it was the bulk one"
    expect(overridesToSend(run.preview, o).bulkPulls).toEqual({});
    await executeApply(client(), run.bundle, OWNER, overridesToSend(run.preview, o));
    expect((await copies()).map((c) => [c.id, c.role])).toEqual([[binder, "shelved"]]);
  });

  it("offers a bulk copy of a different variant: variant is not part of the duplicate rule", async () => {
    await importFile(
      row(PIKACHU, "062", "Pikachu", 1),
      row(PIKACHU, "062", "Pikachu", 1, "Reverse Holo"),
    );
    const [a, b] = await copies();
    const [normal, reverse] = (
      await q<{ id: string; dex_variant_raw: string }>(
        `select id, dex_variant_raw from copy where id in ($1, $2) order by dex_variant_raw`,
        [a.id, b.id],
      )
    ).map((r) => r.id);
    await shelve(normal);
    await toBulk(reverse);

    // The Normal in her binder was traded; the Reverse Holo is still in bulk.
    const run = await runSyncPipeline(
      client(),
      bytes(row(PIKACHU, "062", "Pikachu", 1, "Reverse Holo")),
    );
    expect(run.preview.removalAsks?.[KEY]?.ambiguous).toBe(false);
    const offer = refillOffer(run.preview, {}, run.preview.sections.removals[0], 0);
    expect(offer?.options).toEqual([{ copyId: reverse, label: "Bulk box · Reverse Holo" }]);
    await executeApply(client(), run.bundle, OWNER, pickRefill({}, normal, reverse));
    expect((await loadPendingPlacements(client())).map((p) => p.copyId)).toEqual([reverse]);
  });

  it("is idempotent: importing the same file again changes nothing and keeps the card in the plan once", async () => {
    const [binder, bulk] = await binderAndBulk();
    const first = await runSyncPipeline(client(), bytes(row(PIKACHU, "062", "Pikachu", 1)));
    await executeApply(
      client(),
      first.bundle,
      OWNER,
      pickRefill(pickWhere(first.preview, {}, KEY, 0, binder), binder, bulk),
    );
    const again = await runSyncPipeline(client(), bytes(row(PIKACHU, "062", "Pikachu", 1)));
    expect(again.preview.kind).toBe("noop");
    expect((await loadPendingPlacements(client())).map((p) => p.copyId)).toEqual([bulk]);
  });

  it("a card that was never pulled stays out of the plan (no other bulk card comes back)", async () => {
    await importFile(row(PIKACHU, "062", "Pikachu", 2));
    const [a, b] = await copies();
    await toBulk(a.id);
    await toBulk(b.id);
    expect(await loadPendingPlacements(client())).toEqual([]);
  });
});

describe("Undo puts a pulled card back in its box", () => {
  it("while it is still waiting in the plan", async () => {
    await addBox2();
    const [binder, bulk] = await binderAndBulk(BOX2);
    const run = await runSyncPipeline(client(), bytes(row(PIKACHU, "062", "Pikachu", 1)));
    await executeApply(
      client(),
      run.bundle,
      OWNER,
      pickRefill(pickWhere(run.preview, {}, KEY, 0, binder), binder, bulk),
    );

    await executeUndo(client());
    const after = await copies();
    expect(after.find((c) => c.id === binder)).toMatchObject({ role: "shelved", binder_id: B1 });
    expect(after.find((c) => c.id === bulk)).toMatchObject({ role: "bulk", bulk_unit_id: BOX2 });
    expect(await loadPendingPlacements(client())).toEqual([]);
  });

  it("even into a box that has filled up since (recorded as an override, as her own moves are)", async () => {
    await addBox2(1);
    const [binder, bulk] = await binderAndBulk(BOX2);
    const run = await runSyncPipeline(client(), bytes(row(PIKACHU, "062", "Pikachu", 1)));
    await executeApply(
      client(),
      run.bundle,
      OWNER,
      pickRefill(pickWhere(run.preview, {}, KEY, 0, binder), binder, bulk),
    );
    await executeUndo(client());
    expect((await copies()).find((c) => c.id === bulk)).toMatchObject({ bulk_unit_id: BOX2 });
    const [d] = await q<{ decision: string; overrides: string[] }>(
      `select decision, overrides from placement_decision where copy_id = $1 order by created_at desc limit 1`,
      [bulk],
    );
    expect(d).toEqual({ decision: "returned-to-bulk", overrides: ["bulk_box_full"] });
  });

  it("after she already shelved it in the spot the traded card left", async () => {
    const [binder, bulk] = await binderAndBulk();
    const run = await runSyncPipeline(client(), bytes(row(PIKACHU, "062", "Pikachu", 1)));
    await executeApply(
      client(),
      run.bundle,
      OWNER,
      pickRefill(pickWhere(run.preview, {}, KEY, 0, binder), binder, bulk),
    );
    await shelve(bulk); // she worked the plan and put it in Binder 1

    await executeUndo(client());
    const after = await copies();
    expect(after.find((c) => c.id === binder)).toMatchObject({ role: "shelved", binder_id: B1 });
    expect(after.find((c) => c.id === bulk)).toMatchObject({ role: "bulk", binder_id: null });
  });

  it("when the traded card held a line slot and she filled that slot with the pulled card", async () => {
    await q(
      `insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id, types, stage, evolve_from, dex_id)
         values ('sv03-063', 'Raichu', 'sv03', 'Obsidian Flames', '063', '{Lightning}', 'Stage1', 'Pikachu', '{26}')`,
    );
    await importFile(row(PIKACHU, "062", "Pikachu", 2), row("sv03-063", "063", "Raichu", 1));
    const all = await q<{ id: string; catalog_card_id: string }>(
      `select id, catalog_card_id from copy order by catalog_card_id, created_at, id`,
    );
    const [inLine, bulk] = all.filter((c) => c.catalog_card_id === PIKACHU).map((c) => c.id);
    const raichu = all.find((c) => c.catalog_card_id === "sv03-063")!.id;
    const LINE = "3c000000-0000-0000-0000-0000000000c1";
    const S0 = "3c000000-0000-0000-0000-0000000000d0";
    const S1 = "3c000000-0000-0000-0000-0000000000d1";
    await q(
      // Every slot filled, so the line reads closed, as a real one does (0030).
      `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, status)
         values ($1, $2, 25, 'yellow', $3, 'closed')`,
      [LINE, OWNER, B1],
    );
    for (const [slot, idx, stage, copy] of [
      [S0, 0, "Basic", inLine],
      [S1, 1, "Stage1", raichu],
    ] as const) {
      await q(
        `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
           values ($1, $2, $3, $4, $5, 'filled', $6)`,
        [slot, OWNER, LINE, idx, stage, copy],
      );
      await q(
        `update copy set role = 'shelved', binder_id = $1, binder_half = 'back', color_band = 'yellow',
           line_slot_id = $2 where id = $3`,
        [B1, slot, copy],
      );
    }
    await toBulk(bulk);

    const run = await runSyncPipeline(
      client(),
      bytes(row(PIKACHU, "062", "Pikachu", 1), row("sv03-063", "063", "Raichu", 1)),
    );
    expect(run.preview.removalAsks?.[KEY]?.ambiguous).toBe(true);
    const o = pickWhere(run.preview, {}, KEY, 0, inLine);
    expect(refillOffer(run.preview, o, run.preview.sections.removals[0], 0)?.options).toHaveLength(
      1,
    );
    await executeApply(client(), run.bundle, OWNER, pickRefill(o, inLine, bulk));
    expect((await q(`select state, copy_id from line_slot where id = $1`, [S0]))[0]).toEqual({
      state: "placeholder",
      copy_id: null,
    });

    // She works the plan: the pulled Pikachu goes into the open slot.
    await q(
      `update copy set role = 'shelved', binder_id = $1, binder_half = 'back', color_band = 'yellow',
         line_slot_id = $2 where id = $3`,
      [B1, S0, bulk],
    );
    await q(`update line_slot set state = 'filled', copy_id = $1 where id = $2`, [bulk, S0]);

    await executeUndo(client());
    // The traded card is back in its slot; the pulled one is back in the box; no slot points two ways.
    expect((await q(`select state, copy_id from line_slot where id = $1`, [S0]))[0]).toEqual({
      state: "filled",
      copy_id: inLine,
    });
    const after = await copies();
    expect(after.find((c) => c.id === inLine)).toMatchObject({ role: "shelved" });
    expect(after.find((c) => c.id === bulk)).toMatchObject({ role: "bulk", binder_id: null });
    expect(await q(`select id from copy where line_slot_id = $1`, [S0]).then((r) => r.length)).toBe(
      1,
    );
  });

  it("an Undo with no pull behaves exactly as before", async () => {
    const [binder, bulk] = await binderAndBulk();
    const run = await runSyncPipeline(client(), bytes(row(PIKACHU, "062", "Pikachu", 1)));
    await executeApply(client(), run.bundle, OWNER, pickWhere(run.preview, {}, KEY, 0, binder));
    await executeUndo(client());
    const after = await copies();
    expect(after.find((c) => c.id === bulk)).toMatchObject({ role: "bulk" });
    expect(after.find((c) => c.id === binder)).toMatchObject({ role: "shelved" });
  });
});

describe("removalQuestions (pure)", () => {
  const snap = (copyId: string, o: Partial<CurrentGroup["copies"][number]> = {}) => ({
    copyId,
    role: "shelved" as const,
    binderId: "b1",
    binderHalf: "front" as const,
    colorBand: "yellow",
    lineSlotId: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    ...o,
  });

  it("never offers a copy a variant migration carries across: it changed variant, it did not leave", () => {
    const current: CurrentGroup[] = [
      {
        catalogCardId: "c",
        dexVariantRaw: "Normal",
        copies: [snap("x"), snap("y", { role: "bulk", binderId: null, binderHalf: null })],
      },
    ];
    const [qn] = removalQuestions(
      {
        retires: [
          {
            kind: "retire",
            copyId: "y",
            catalogCardId: "c",
            dexVariantRaw: "Normal",
            consequence: "bulk-removed",
            needsReview: false,
          },
        ],
        variantUpdates: [
          {
            kind: "variant_update",
            copyId: "x",
            catalogCardId: "c",
            fromVariantRaw: "Normal",
            toVariantRaw: "Holo",
            toVariant: "holo",
            placementPreserved: true,
          },
        ],
      },
      current,
    );
    expect(qn.candidates.map((c) => c.copyId)).toEqual(["y"]);
    expect(qn.ambiguous).toBe(false);
  });

  it("treats two different line slots as two places", () => {
    const current: CurrentGroup[] = [
      {
        catalogCardId: "c",
        dexVariantRaw: "Normal",
        copies: [snap("x", { lineSlotId: "s1" }), snap("y", { lineSlotId: "s2" })],
      },
    ];
    const [qn] = removalQuestions(
      {
        retires: [
          {
            kind: "retire",
            copyId: "x",
            catalogCardId: "c",
            dexVariantRaw: "Normal",
            consequence: "line-slot-freed",
            needsReview: false,
          },
        ],
        variantUpdates: [],
      },
      current,
    );
    expect(qn.ambiguous).toBe(true);
  });
});
