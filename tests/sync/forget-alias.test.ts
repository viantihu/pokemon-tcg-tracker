/**
 * Forgetting a learned set alias (UIL-047 C3, second half; migration 0014). Three layers, the same
 * shape as exec-atomicity.test.ts:
 *
 *  1. Pure — which WAITING entries a forget re-parks, and the ordered op set it emits (lib/sync/alias.ts).
 *  2. RPC (PGlite, real plpgsql, 0001→0014 applied) — `delete_set_alias` removes exactly the keyed row as
 *     the authenticated owner; the re-parks land in the same transaction; a poison op rolls the whole
 *     thing back; the branches inherited from 0008/0013 still behave. Plus a mechanical check of 0014's
 *     "0013's body verbatim plus one branch" claim, by diffing the two function texts.
 *  3. End to end — the real `forgetSetAlias` against a PGlite-backed DbClient (real reads under RLS, real
 *     RPC), not a fake whose semantics are the author's guess.
 *
 * The fixture is the live shape from the issue log: `ja:m6 → swshp`, taught by hand, with `en:m6` a
 * DIFFERENT alias sharing the code — the cross-locale confusion C3 is about — that must not be touched.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Row, WritePayload } from "@/lib/repo";
import {
  buildForgetAliasOps,
  entriesUnderAlias,
  entryAliasKey,
  forgetSetAlias,
  reparkCandidates,
} from "@/lib/sync";
import { applyOps, asOwner, asSuperuser, freshRpcDb, OWNER } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

type Entry = Pick<Row<"unresolved_entry">, "id" | "dex_id" | "locale" | "status" | "reason">;

const E = (
  id: string,
  dex_id: string,
  locale: string,
  status: Entry["status"],
  reason: Entry["reason"],
): Entry => ({ id, dex_id, locale, status, reason });

const IDS = {
  jaCard1: "e0000000-0000-0000-0000-000000000001",
  jaCard2: "e0000000-0000-0000-0000-000000000002",
  jaSet: "e0000000-0000-0000-0000-000000000003",
  jaResolved: "e0000000-0000-0000-0000-000000000004",
  jaDismissed: "e0000000-0000-0000-0000-000000000005",
  enCard: "e0000000-0000-0000-0000-000000000006",
  otherSet: "e0000000-0000-0000-0000-000000000007",
};

/** The queue as it stands while `ja:m6 → swshp` is live. Both locale spellings appear on purpose. */
const ENTRIES: Entry[] = [
  E(IDS.jaCard1, "jpn_m6-12", "Japanese", "WAITING", "UNKNOWN_CARD"),
  E(IDS.jaCard2, "jpn_m6-20", "ja", "WAITING", "UNKNOWN_CARD"),
  E(IDS.jaSet, "jpn_m6-33", "ja", "WAITING", "UNKNOWN_SET"), // parked before the alias; already honest
  E(IDS.jaResolved, "jpn_m6-5", "ja", "RESOLVED", "UNKNOWN_SET"), // the match that taught it
  E(IDS.jaDismissed, "jpn_m6-7", "ja", "DISMISSED", "UNKNOWN_CARD"),
  E(IDS.enCard, "m6-14", "English", "WAITING", "UNKNOWN_CARD"), // en:m6 — a different alias
  E(IDS.otherSet, "jpn_sv9-1", "ja", "WAITING", "UNKNOWN_CARD"), // ja:sv9 — a different alias
];

const JA_M6 = { locale: "ja", dexCode: "m6", tcgdexSetId: "swshp" };

describe("forget alias — pure decision (lib/sync/alias.ts)", () => {
  it("entryAliasKey strips jpn_ and normalises the export's locale spelling", () => {
    expect(entryAliasKey({ dex_id: "jpn_m6-12", locale: "Japanese" })).toBe("ja:m6");
    expect(entryAliasKey({ dex_id: "jpn_m6-20", locale: "ja" })).toBe("ja:m6");
    expect(entryAliasKey({ dex_id: "m6-14", locale: "English" })).toBe("en:m6");
    expect(entryAliasKey({ dex_id: "m6-14", locale: null })).toBe("en:m6");
  });

  it("entriesUnderAlias: WAITING rows under the key only — not the other locale, not RESOLVED/DISMISSED", () => {
    const under = entriesUnderAlias(ENTRIES, JA_M6).map((e) => e.id);
    expect(under).toEqual([IDS.jaCard1, IDS.jaCard2, IDS.jaSet]);
  });

  it("reparkCandidates: only the entries whose 'set is known' claim rests on the alias", () => {
    expect(reparkCandidates(ENTRIES, JA_M6).map((e) => e.id)).toEqual([IDS.jaCard1, IDS.jaCard2]);
  });

  it("buildForgetAliasOps: the delete first, then one reason-only re-park per candidate", () => {
    const ops = buildForgetAliasOps(JA_M6, ENTRIES);
    expect(ops[0]).toEqual({ op: "delete_set_alias", locale: "ja", dex_code: "m6" });
    expect(ops.slice(1)).toEqual([
      { op: "update_unresolved_entry", id: IDS.jaCard1, patch: { reason: "UNKNOWN_SET" } },
      { op: "update_unresolved_entry", id: IDS.jaCard2, patch: { reason: "UNKNOWN_SET" } },
    ]);
  });

  it("an alias nothing waits on is just the delete", () => {
    expect(buildForgetAliasOps({ locale: "en", dexCode: "ba22e" }, ENTRIES)).toEqual([
      { op: "delete_set_alias", locale: "en", dex_code: "ba22e" },
    ]);
  });
});

/* ------------------------------------ RPC layer (PGlite) ------------------------------------ */

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seed();
});
afterEach(async () => {
  await db.close();
});

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await db.query<T>(sql, params)).rows;
}

/** Three live aliases (two share the code `m6` across locales) and the queue above, as superuser. */
async function seed(): Promise<void> {
  await db.exec(`
    insert into catalog_card (tcgdex_id, name, set_id) values ('swshp-001', 'Promo', 'swshp');
    insert into set_alias (locale, dex_code, tcgdex_set_id, source) values
      ('ja', 'm6', 'swshp', 'manual'),
      ('en', 'm6', 'me06', 'name-resolved'),
      ('en', 'ba22e', 'swshp', 'manual');
  `);
  for (const e of ENTRIES) {
    await db.query(
      `insert into unresolved_entry (id, owner_id, dex_id, dex_variant_raw, quantity, locale, reason, status, manual_match_id)
       values ($1, $2, $3, '', 1, $4, $5, $6, $7)`,
      [
        e.id,
        OWNER,
        e.dex_id,
        e.locale,
        e.reason,
        e.status,
        e.status === "RESOLVED" ? "swshp-001" : null,
      ],
    );
  }
}

async function aliasKeys(): Promise<string[]> {
  const rows = await q<{ k: string }>(
    `select locale || ':' || dex_code as k from set_alias order by 1`,
  );
  return rows.map((r) => r.k);
}

async function reasons(): Promise<Record<string, { status: string; reason: string }>> {
  const rows = await q<{ id: string; status: string; reason: string }>(
    `select id, status, reason from unresolved_entry`,
  );
  return Object.fromEntries(rows.map((r) => [r.id, { status: r.status, reason: r.reason }]));
}

const UNCHANGED = Object.fromEntries(
  ENTRIES.map((e) => [e.id, { status: e.status, reason: e.reason }]),
);

/** The function definition onward — anchored on the definition line, not the header prose above it. */
function migrationFn(file: string): string {
  const sql = readFileSync(path.join(process.cwd(), "supabase", "migrations", file), "utf8");
  const at = sql.indexOf("\ncreate or replace function apply_write_ops(payload jsonb)");
  expect(at).toBeGreaterThan(0);
  return sql.slice(at);
}

describe("forget alias — delete_set_alias through apply_write_ops (PGlite)", () => {
  it("0014 is 0013's function verbatim plus the one delete_set_alias branch", () => {
    // 0013 (UIL-078) replaced apply_write_ops first — 0008's body + three update_slot patch keys — so
    // this file is built on THAT body, and the composed function (0013 then 0014) is what ships.
    const base = migrationFn("0013_decision_persistence.sql");
    const mine = migrationFn("0014_forget_set_alias.sql");
    const start = mine.indexOf("      -- NEW in 0014");
    const end = mine.indexOf("      else\n", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const withoutNewBranch = mine.slice(0, start) + mine.slice(end);
    expect(withoutNewBranch).toBe(base);
    // And the branch itself is what the TypeScript op mirrors.
    expect(mine.slice(start, end)).toContain("when 'delete_set_alias' then");
    expect(mine.slice(start, end)).toContain(
      "where locale = (op ->> 'locale') and dex_code = (op ->> 'dex_code');",
    );
    // The inherited 0013 branch is still there: the composed function carries BOTH additions.
    expect(mine).toContain(
      "resolved_decision_collection_id = case when p ? 'resolved_decision_collection_id'",
    );
  });

  it("as the owner: removes exactly the keyed row and re-parks the set's UNKNOWN_CARD entries together", async () => {
    await asOwner(db);
    await applyOps(db, { ops: buildForgetAliasOps(JA_M6, ENTRIES) });
    await asSuperuser(db);

    // The other locale's alias for the same code, and the unrelated one, survive.
    expect(await aliasKeys()).toEqual(["en:ba22e", "en:m6"]);

    expect(await reasons()).toEqual({
      ...UNCHANGED,
      [IDS.jaCard1]: { status: "WAITING", reason: "UNKNOWN_SET" },
      [IDS.jaCard2]: { status: "WAITING", reason: "UNKNOWN_SET" },
      // jaSet was already UNKNOWN_SET; jaResolved / jaDismissed / enCard / otherSet untouched.
    });
  });

  it("a poison op after the forget rolls back the alias delete AND the re-parks", async () => {
    await asOwner(db);
    const ops: WritePayload["ops"] = [
      ...buildForgetAliasOps(JA_M6, ENTRIES),
      {
        op: "insert_copy",
        presence_group_id: "00000000-0000-4000-8000-00000000900d",
        id: crypto.randomUUID(),
        catalog_card_id: "ghost",
        role: "bulk",
      },
    ];
    await expect(applyOps(db, { ops })).rejects.toThrow();
    await asSuperuser(db);
    expect(await aliasKeys()).toEqual(["en:ba22e", "en:m6", "ja:m6"]);
    expect(await reasons()).toEqual(UNCHANGED);
  });

  it("a key that matches no row is a silent no-op, like delete_copy", async () => {
    await asOwner(db);
    await applyOps(db, { ops: [{ op: "delete_set_alias", locale: "ja", dex_code: "nope" }] });
    await asSuperuser(db);
    expect(await aliasKeys()).toEqual(["en:ba22e", "en:m6", "ja:m6"]);
  });

  it("the inherited branches still behave: upsert re-teaches an alias; an unknown op still raises", async () => {
    await asOwner(db);
    await applyOps(db, {
      ops: [
        { op: "delete_set_alias", locale: "ja", dex_code: "m6" },
        { op: "upsert_set_alias", locale: "ja", dex_code: "m6", tcgdex_set_id: "correct-set" },
      ],
    });
    await expect(
      applyOps(db, { ops: [{ op: "bogus_op" } as unknown as WritePayload["ops"][number]] }),
    ).rejects.toThrow(/unknown op/);
    await asSuperuser(db);
    const row = await q<{ tcgdex_set_id: string; source: string }>(
      `select tcgdex_set_id, source from set_alias where locale = 'ja' and dex_code = 'm6'`,
    );
    expect(row).toEqual([{ tcgdex_set_id: "correct-set", source: "manual" }]);
  });
});

/* ---------------------------- end to end: the real module ---------------------------- */

describe("forgetSetAlias — real module against a PGlite-backed DbClient", () => {
  it("drops the alias, re-parks the two 'needs your match' entries, and reports what it did", async () => {
    await asOwner(db);
    const res = await forgetSetAlias(pgliteClient(db), "ja", "m6");
    expect(res).toEqual({ alias: JA_M6, reparked: 2 });
    await asSuperuser(db);
    expect(await aliasKeys()).toEqual(["en:ba22e", "en:m6"]);
    expect((await reasons())[IDS.jaCard1]).toEqual({ status: "WAITING", reason: "UNKNOWN_SET" });
    expect((await reasons())[IDS.jaCard2]).toEqual({ status: "WAITING", reason: "UNKNOWN_SET" });
    expect((await reasons())[IDS.enCard]).toEqual({ status: "WAITING", reason: "UNKNOWN_CARD" });
  });

  it("an alias nothing waits on reports zero re-parks", async () => {
    await asOwner(db);
    const res = await forgetSetAlias(pgliteClient(db), "en", "ba22e");
    expect(res.reparked).toBe(0);
    await asSuperuser(db);
    expect(await aliasKeys()).toEqual(["en:m6", "ja:m6"]);
  });

  it("refuses an alias that is not there, before writing anything", async () => {
    await asOwner(db);
    await expect(forgetSetAlias(pgliteClient(db), "ja", "nope")).rejects.toThrow(/already gone/);
    await asSuperuser(db);
    expect(await aliasKeys()).toEqual(["en:ba22e", "en:m6", "ja:m6"]);
    expect(await reasons()).toEqual(UNCHANGED);
  });
});
