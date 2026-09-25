/**
 * UIL-102 — a card's variant FLAG is the one its Dex variant derives, on every path, and the import repairs
 * the ones stored wrong.
 *
 * The holo-swap rule (engine `resolveDuplicate`) reads `copy.variant`, not the Dex string. The Sync page's
 * manual match and UIL-099's "Add it back" wrote "normal" for every row, so a hand-matched Holo was placed
 * as a normal card. Both now use `deriveVariantFlag`, the import's own function. And because Testing already
 * holds copies stored wrong (3 at the Senior BA's read), every import now AUDITS the flag: a copy whose flag
 * disagrees with its Dex variant is corrected in the same transaction, NAMED in the preview — with a note
 * when it was already placed — and never re-placed; Undo puts the old flag back.
 *
 * The Senior BA's conditions, pinned here: the preview names each card (name, set, number, Dex variant,
 * "recorded as Normal, now Holo") and marks the placed ones; the fixes are in the undo snapshot; UIL-100's
 * count check is untouched (the flag is not part of the key); a flag fix alone makes an import a reviewed
 * one. Real Postgres (PGlite), real RLS, the real pipeline.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  executeApply,
  executeUndo,
  manualMatch,
  reconcile,
  restoreWithheldForEntry,
} from "@/lib/sync";
import { runSyncPipeline } from "@/lib/sync/pipeline";
import { createHash } from "node:crypto";
import { planDigest } from "@/lib/sync/apply-guard";
import { presenceKey } from "@/lib/sync/diff";
import { loadCountCheck } from "@/lib/sync/count-check-load";
import { asOwner, asSuperuser, freshRpcDb, OWNER, seedBinders } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const HEADER =
  "Type;Category;Locale;Series;Set;Id;Number;Name;Variant;Rarity;Illustrator;Quantity;Price;Notes";
const bytes = (...rows: string[]) =>
  Uint8Array.from([0xff, 0xfe, ...Buffer.from(`${HEADER}\n${rows.join("\n")}\n`, "utf16le")]);
/** A row that resolves on import (Ancient Origins → xy7, number 12 → xy7-012). */
const resolved = (variant: string, qty = 1) =>
  `collection;Pokemon;English;XY;Ancient Origins;xy7-12;12;Card A;${variant};Rare;;${qty};;`;
/** A row the catalog cannot resolve, so it waits for her manual match. */
const waiting = (variant: string, qty = 1) =>
  `collection;Pokemon;English;XY;Ancient Origins;xy7-99;99;Mystery Card;${variant};Rare;;${qty};;`;

const CARD = "xy7-012";
const B1 = "1c000000-0000-0000-0000-0000000000b1";

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await db.exec(`
    insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id, types, set_card_count_official)
    values ('${CARD}', 'Card A', 'xy7', 'Ancient Origins', '012', '{Fire}', 98);
  `);
  await seedBinders(db, [{ id: B1, type: "general", name: "Binder 1" }]);
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

const client = () => pgliteClient(db);
async function importAndApply(file: Uint8Array) {
  const run = await runSyncPipeline(client(), file);
  await executeApply(client(), run.bundle, OWNER);
  return run;
}
async function flags(): Promise<
  { id: string; variant: string; role: string; binder_id: string | null }[]
> {
  await asSuperuser(db);
  const r = await db.query<{ id: string; variant: string; role: string; binder_id: string | null }>(
    "select id, variant, role, binder_id from copy order by id",
  );
  await asOwner(db);
  return r.rows;
}
/** Each copy's KEY: its Dex variant and its presence group. */
async function keys(): Promise<
  { id: string; dex_variant_raw: string; presence_group_id: string }[]
> {
  await asSuperuser(db);
  const r = await db.query<{ id: string; dex_variant_raw: string; presence_group_id: string }>(
    "select id, dex_variant_raw, presence_group_id from copy order by id",
  );
  await asOwner(db);
  return r.rows;
}
/** What a pre-UIL-102 manual match left behind: the Dex variant is Holo, the stored flag "normal". */
async function misflag(opts: { placed: boolean }) {
  await asSuperuser(db);
  await db.query(
    opts.placed
      ? `update copy set variant = 'normal', role = 'shelved', binder_id = $1, binder_half = 'front'`
      : `update copy set variant = 'normal'`,
    opts.placed ? [B1] : [],
  );
  await asOwner(db);
}

describe("UIL-102 · a hand match carries the flag its Dex variant derives", () => {
  it("a manually matched Holo row is stored as holo, a Reverse Holo as reverse", async () => {
    for (const [variant, flag] of [
      ["Holo", "holo"],
      ["Reverse Holo", "reverse"],
    ] as const) {
      await asSuperuser(db);
      await db.exec("delete from copy; delete from unresolved_entry;");
      await asOwner(db);
      await importAndApply(bytes(waiting(variant)));
      const { rows } = await db.query<{ id: string }>("select id from unresolved_entry");
      await manualMatch(client(), rows[0].id, CARD);
      // PRE-FIX: "normal" for both.
      expect((await flags()).map((c) => c.variant)).toEqual([flag]);
    }
  });

  it("Add it back stores the derived flag too", async () => {
    await importAndApply(bytes(waiting("Holo")));
    const { rows } = await db.query<{ id: string }>("select id from unresolved_entry");
    await asSuperuser(db);
    await db.query(
      `insert into removed_presence (owner_id, catalog_card_id, dex_variant_raw, count) values ($1, $2, 'Holo', 1)`,
      [OWNER, CARD],
    );
    await asOwner(db);
    await manualMatch(client(), rows[0].id, CARD); // held back
    await restoreWithheldForEntry(client(), rows[0].id);
    expect((await flags()).map((c) => c.variant)).toEqual(["holo"]);
  });
});

describe("UIL-102 · the import audits the flag and corrects it, naming each card", () => {
  it("a placed card stored wrong is named, with the note to check its pocket — and the import is gated", async () => {
    await importAndApply(bytes(resolved("Holo")));
    await misflag({ placed: true });

    const run = await runSyncPipeline(client(), bytes(resolved("Holo")));

    expect(run.bundle.plan.flagFixes).toHaveLength(1);
    const [row] = run.preview.sections.flagFixes;
    expect(row).toMatchObject({
      name: "Card A",
      setName: "Ancient Origins",
      localId: "012",
      setCardCountOfficial: 98,
      dexVariantRaw: "Holo",
      change: "recorded as Normal, now Holo",
    });
    expect(row.placedNote).toMatch(/^was placed while recorded as Normal; check its pocket/);
    expect(row.placedNote).toContain("Binder 1");
    expect(run.preview.summary.summaryLine).toContain("1 variant flag corrected");
    // A flag fix alone is a REVIEWED import, not the silent fast path (the Senior BA's ruling).
    expect(run.preview.kind).toBe("gated");
  });

  it("a card still in her haul is corrected with no pocket to check", async () => {
    await importAndApply(bytes(resolved("Holo")));
    await misflag({ placed: false });
    const run = await runSyncPipeline(client(), bytes(resolved("Holo")));
    expect(run.preview.sections.flagFixes[0].placedNote).toBeNull();
  });

  it("applying it corrects the flag and moves NOTHING; the count check stays at zero mismatches", async () => {
    await importAndApply(bytes(resolved("Holo")));
    await misflag({ placed: true });
    const before = await flags();
    const keysBefore = await keys();

    const run = await runSyncPipeline(client(), bytes(resolved("Holo")));
    const res = await executeApply(client(), run.bundle, OWNER);

    expect(res.flagFixes).toBe(1);
    expect(res.fastPath).toBe(false);
    const after = await flags();
    expect(after).toEqual(before.map((c) => ({ ...c, variant: "holo" })));
    // ONLY the flag moves: never the Dex variant or the presence group, which are the copy's KEY (the Tech
    // Lead's pin — a drifted key is invisible to the count check, which keys on the group).
    expect(await keys()).toEqual(keysBefore);
    const fixOps = run.bundle.plan.flagFixes;
    expect(fixOps).toHaveLength(1);
    // The flag is not part of the key (UIL-100): nothing disagrees with Dex after it.
    const check = await loadCountCheck(client());
    expect(check.mismatches).toEqual([]);
    // And the next import has nothing left to fix.
    expect(
      (await runSyncPipeline(client(), bytes(resolved("Holo")))).bundle.plan.flagFixes,
    ).toEqual([]);
  });

  it("a fixed copy she chooses to retire instead is retired, not counted as fixed", async () => {
    // Two Holos; the OLDER one is stored wrong. Dex drops to one, so the newer would retire and the older
    // be fixed — but she picks the older to go ("which copy left"). It leaves; there is nothing to fix.
    await importAndApply(bytes(resolved("Holo", 2)));
    const [older] = (
      await db.query<{ id: string }>("select id from copy order by created_at, id limit 1")
    ).rows;
    await asSuperuser(db);
    // One transaction made both, so their created_at ties; make the older one genuinely older.
    await db.query(
      "update copy set variant = 'normal', created_at = created_at - interval '1 day' where id = $1",
      [older.id],
    );
    await asOwner(db);

    const run = await runSyncPipeline(client(), bytes(resolved("Holo", 1)));
    expect(run.bundle.plan.flagFixes.map((f) => f.copyId)).toEqual([older.id]);
    const res = await executeApply(client(), run.bundle, OWNER, {
      retireChoice: { [presenceKey(CARD, "Holo")]: [older.id] },
    });

    expect(res.flagFixes).toBe(0);
    expect((await flags()).map((c) => [c.id === older.id, c.variant])).toEqual([[false, "holo"]]);
  });

  it("Undo puts the old flag back", async () => {
    await importAndApply(bytes(resolved("Holo")));
    await misflag({ placed: true });
    await importAndApply(bytes(resolved("Holo")));
    expect((await flags()).map((c) => c.variant)).toEqual(["holo"]);

    await executeUndo(client());

    expect((await flags()).map((c) => c.variant)).toEqual(["normal"]);
  });

  it("a correct collection has no fixes, and its import is still the fast path", async () => {
    await importAndApply(bytes(resolved("Holo")));
    const run = await runSyncPipeline(client(), bytes(resolved("Holo"), waiting("Normal")));
    expect(run.bundle.plan.flagFixes).toEqual([]);
    expect(run.preview.kind).not.toBe("gated");
  });
});

describe("UIL-102 · what the audit leaves alone", () => {
  const snap = (copyId: string, variant: string) => ({
    copyId,
    role: "shelved" as const,
    binderId: B1,
    binderHalf: "front" as const,
    colorBand: "red",
    lineSlotId: null,
    createdAt: "2026-09-01T00:00:00Z",
    variant,
  });
  const row = (variant: string, quantity = 1) => ({
    type: "collection",
    catalogCardId: CARD,
    dexVariantRaw: variant,
    quantity,
    raw: { dexId: "xy7-12", setName: "", series: "", number: "12", name: "Card A", locale: "en" },
  });

  it("a copy that is RETIRING is not fixed — it is leaving", () => {
    const plan = reconcile({
      rows: [],
      current: [{ catalogCardId: CARD, dexVariantRaw: "Holo", copies: [snap("c1", "normal")] }],
      fullExport: true,
    });
    expect(plan.retires.map((r) => r.copyId)).toEqual(["c1"]);
    expect(plan.flagFixes).toEqual([]);
  });

  it("a copy that is MIGRATING is re-flagged by its migration, not twice", () => {
    const plan = reconcile({
      rows: [row("Reverse Holo")],
      current: [{ catalogCardId: CARD, dexVariantRaw: "Holo", copies: [snap("c1", "normal")] }],
      fullExport: true,
    });
    expect(plan.variantUpdates.map((v) => [v.copyId, v.toVariant])).toEqual([["c1", "reverse"]]);
    expect(plan.flagFixes).toEqual([]);
  });

  it("a hand-built snapshot with no stored flag is not audited", () => {
    const { variant: _drop, ...noFlag } = snap("c1", "normal");
    void _drop;
    const plan = reconcile({
      rows: [row("Holo")],
      current: [{ catalogCardId: CARD, dexVariantRaw: "Holo", copies: [noFlag] }],
      fullExport: true,
    });
    expect(plan.flagFixes).toEqual([]);
  });

  it("a plan with no fixes digests exactly as it did before UIL-102 (the apply-once guard)", () => {
    const base = {
      plan: { creates: [], retires: [], variantUpdates: [] },
      queue: { parks: [], archiveEntryIds: [], dropEntryIds: [] },
    };
    // The digest as the code before UIL-102 computed it: a snapshot written then must still match.
    const before = createHash("sha256")
      .update(JSON.stringify([[], [], [], [], [], []]))
      .digest("hex");
    expect(planDigest({ ...base, plan: { ...base.plan, flagFixes: [] } })).toBe(before);
    expect(planDigest(base)).toBe(before);
    expect(planDigest({ ...base, plan: { ...base.plan, flagFixes: [{}] } })).not.toBe(
      planDigest(base),
    );
  });
});
