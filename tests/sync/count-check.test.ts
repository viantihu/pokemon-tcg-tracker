/**
 * UIL-100 — the pure count check, the refusal parser, and the one claim everything rests on: the TypeScript
 * rule the Sync page shows and the SQL rule `apply_write_ops` enforces are the SAME rule, case by case.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  computeCountCheck,
  dexRecordFromRows,
  expectedByKey,
  parseCountRefusal,
  type CountCheckInput,
} from "@/lib/sync/count-check";
import { presenceKey } from "@/lib/sync/diff";
import type { ResolvedRow } from "@/lib/sync/reconcile";
import type { WriteOp } from "@/lib/repo/write-ops";
import { applyOps, asOwner, freshRpcDb } from "../support/pglite-rpc";

const raw = { dexId: "", setName: "", series: "", number: "", name: "", locale: "" };
const resolved = (
  card: string | null,
  variant: string,
  quantity: number,
  type = "collection",
): ResolvedRow => ({
  type,
  catalogCardId: card,
  dexVariantRaw: variant,
  quantity,
  raw,
});

describe("UIL-100 · the record an import writes", () => {
  it("sums a key's rows, counts unresolved rows in the file total, and ignores wishlist rows", () => {
    const rec = dexRecordFromRows([
      resolved("a", "Normal", 2),
      resolved("a", "Normal", 1), // same key twice: summed, like buildDesiredPresence
      resolved("b", "Holo", 1),
      resolved(null, "Normal", 3), // unresolved: not in the record, but in the file
      resolved("c", "Normal", 5, "wishlist"), // never owned
    ]);
    expect(rec.rows).toEqual([
      { catalog_card_id: "a", dex_variant_raw: "Normal", quantity: 3 },
      { catalog_card_id: "b", dex_variant_raw: "Holo", quantity: 1 },
    ]);
    expect(rec.fileTotal).toBe(7);
    expect(rec.rowCount).toBe(4);
  });
});

const base = (over: Partial<CountCheckInput>): CountCheckInput => ({
  header: { fileTotal: 3, rowCount: 2, importedAt: "2026-09-25T00:00:00Z" },
  record: [
    { catalog_card_id: "a", dex_variant_raw: "Normal", quantity: 2 },
    { catalog_card_id: "b", dex_variant_raw: "Normal", quantity: 1 },
  ],
  removed: [],
  groups: [
    { catalogCardId: "a", dexVariantRaw: "Normal", copies: 2 },
    { catalogCardId: "b", dexVariantRaw: "Normal", copies: 1 },
  ],
  ungroupedCopies: 0,
  waitingQuantity: 0,
  dismissedQuantity: 0,
  ...over,
});

describe("UIL-100 · computeCountCheck", () => {
  it("is `none` before her first recorded import", () => {
    expect(computeCountCheck(base({ header: null })).status).toBe("none");
  });

  it("is `ok` when every key adds up, and the sum holds", () => {
    const c = computeCountCheck(base({}));
    expect(c).toMatchObject({
      status: "ok",
      fileTotal: 3,
      inCollection: 3,
      removed: 0,
      fileAddsUp: true,
    });
  });

  it("names an extra and a missing card, with the direction", () => {
    const c = computeCountCheck(
      base({
        groups: [
          { catalogCardId: "a", dexVariantRaw: "Normal", copies: 3 },
          { catalogCardId: "b", dexVariantRaw: "Normal", copies: 0 },
        ],
      }),
    );
    expect(c.status).toBe("mismatch");
    expect(c.mismatches).toEqual([
      {
        catalogCardId: "a",
        dexVariantRaw: "Normal",
        dex: 2,
        removed: 0,
        have: 3,
        expected: 2,
        direction: "extra",
      },
      {
        catalogCardId: "b",
        dexVariantRaw: "Normal",
        dex: 1,
        removed: 0,
        have: 0,
        expected: 1,
        direction: "missing",
      },
    ]);
  });

  it("a removal never reads as missing, and counts in the sum", () => {
    const c = computeCountCheck(
      base({
        removed: [{ catalogCardId: "a", dexVariantRaw: "Normal", count: 1 }],
        groups: [
          { catalogCardId: "a", dexVariantRaw: "Normal", copies: 1 },
          { catalogCardId: "b", dexVariantRaw: "Normal", copies: 1 },
        ],
      }),
    );
    expect(c).toMatchObject({ status: "ok", inCollection: 2, removed: 1 });
    expect(c.fileTotal).toBe(c.inCollection + c.waiting + c.dismissed + c.removed);
  });

  it("waiting and dismissed rows are part of the file, not a mismatch", () => {
    const c = computeCountCheck(
      base({
        header: { fileTotal: 6, rowCount: 4, importedAt: "x" },
        waitingQuantity: 2,
        dismissedQuantity: 1,
      }),
    );
    expect(c).toMatchObject({ status: "ok", waiting: 2, dismissed: 1, fileAddsUp: true });
  });

  it("copies with no presence group make it not add up, even when every key does", () => {
    expect(computeCountCheck(base({ ungroupedCopies: 1 })).status).toBe("mismatch");
  });

  it("a record that no longer sums to its file is flagged", () => {
    const c = computeCountCheck(base({ header: { fileTotal: 9, rowCount: 2, importedAt: "x" } }));
    expect(c).toMatchObject({ status: "mismatch", fileAddsUp: false, mismatches: [] });
  });
});

describe("UIL-100 · parseCountRefusal", () => {
  it("reads the keys from a supabase-js error's `details`", () => {
    const err = {
      code: "P0001",
      message: "apply_write_ops: presence count check failed on 2 key(s) (UIL-100)",
      details: JSON.stringify([
        { catalog_card_id: "a", dex_variant_raw: "Normal", dex: 1, removed: 0, have: 2 },
      ]),
    };
    expect(parseCountRefusal(err)).toEqual({
      total: 2,
      keys: [{ catalog_card_id: "a", dex_variant_raw: "Normal", dex: 1, removed: 0, have: 2 }],
    });
  });

  it("is null for any other error, so the caller rethrows it untouched", () => {
    expect(
      parseCountRefusal({ message: "duplicate key value violates unique constraint" }),
    ).toBeNull();
    expect(parseCountRefusal(new Error("boom"))).toBeNull();
    expect(parseCountRefusal(null)).toBeNull();
  });
});

/* -------------------- the TypeScript rule and the SQL rule are the same rule -------------------- */

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await db.exec(`insert into catalog_card (tcgdex_id, name) values ('k', 'K')`);
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

let seq = 0;
const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

describe("UIL-100 · TypeScript and SQL agree on every (dex, removed, have)", () => {
  const cases: [number, number, number][] = [];
  for (const dex of [0, 1, 2, 3])
    for (const removed of [0, 1, 2, 4])
      for (const have of [0, 1, 2, 3]) cases.push([dex, removed, have]);

  it(`agrees on all ${cases.length} cases`, async () => {
    const disagreements: string[] = [];
    for (const [dex, removed, have] of cases) {
      const key = { catalog_card_id: "k", dex_variant_raw: `v-${dex}-${removed}-${have}` };
      const group = id();
      const ops: WriteOp[] = [
        { op: "insert_presence_group", id: group, ...key, desired_count: 0 },
        ...Array.from({ length: have }, (): WriteOp => ({
          op: "insert_copy",
          id: id(),
          catalog_card_id: key.catalog_card_id,
          variant: "normal",
          dex_variant_raw: key.dex_variant_raw,
          presence_group_id: group,
          role: "haul",
        })),
        ...(removed > 0
          ? [{ op: "remember_removed_presence", ...key, delta: removed } as WriteOp]
          : []),
        {
          op: "replace_dex_record",
          rows: dex > 0 ? [{ ...key, quantity: dex }] : [],
          file_total: dex,
          row_count: dex > 0 ? 1 : 0,
        },
        { op: "assert_presence_counts", keys: [key] },
      ];
      let sqlPasses = true;
      try {
        await applyOps(db, { ops });
      } catch {
        sqlPasses = false;
      }
      // Undo the case so the next one starts clean (the RPC rolled back on refusal already).
      if (sqlPasses) {
        await applyOps(db, {
          ops: [{ op: "clear_dex_record" }, { op: "forget_removed_presence", ...key }],
        });
      }
      const expected =
        expectedByKey(
          dex > 0 ? [{ ...key, quantity: dex }] : [],
          removed > 0
            ? [
                {
                  catalogCardId: key.catalog_card_id,
                  dexVariantRaw: key.dex_variant_raw,
                  count: removed,
                },
              ]
            : [],
        ).get(presenceKey(key.catalog_card_id, key.dex_variant_raw)) ?? 0;
      const tsPasses = have === expected;
      if (sqlPasses !== tsPasses)
        disagreements.push(
          `dex ${dex} removed ${removed} have ${have}: sql ${sqlPasses} ts ${tsPasses}`,
        );
    }
    expect(disagreements).toEqual([]);
  });
});
