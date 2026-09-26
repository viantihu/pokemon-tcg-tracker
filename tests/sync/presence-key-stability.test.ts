/**
 * UIL-099 E3 and E4 — the key an import writes a card under must be the key the NEXT import finds it by.
 * Tests over existing fixes, not new code: the audit found neither pinned at the boundary where a wrong key
 * turns into a twin, which is the full import → reconcile → apply → import-again loop.
 *
 * E3 (UIL-086): her Japanese set codes are lower case (`sv9`) and TCGdex's are mixed (`SV9`). The lookup
 * folds case to FIND the set, and must hand back the stored id exactly (`ja:SV9-042`). A folded id
 * (`ja:sv9-042`) would name no catalog row, and a second import resolving it differently would reconcile
 * against a different presence key and create a twin.
 *
 * E4 (UIL-060 / UIL-082): once TCGdex adds the real card behind a stand-in she created, her row must keep
 * resolving to the stand-in she matched (`manual_match_id`), not quietly switch to the real card's id,
 * which would propose retiring her stand-in copy and creating a second copy under the new key.
 *
 * Real Postgres (PGlite), real RLS, the real pipeline — manual-match-survives-reimport.test.ts's harness.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { executeApply, manualMatchStandIn } from "@/lib/sync";
import { runSyncPipeline } from "@/lib/sync/pipeline";
import { asOwner, asSuperuser, freshRpcDb, OWNER } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const HEADER =
  "Type;Category;Locale;Series;Set;Id;Number;Name;Variant;Rarity;Illustrator;Quantity;Price;Notes";
/** UTF-16LE with BOM, the real export's physical format (lib/sync/csv.ts). */
function exportBytes(...rows: string[]): Uint8Array {
  const body = Buffer.from(`${HEADER}\n${rows.join("\n")}\n`, "utf16le");
  return Uint8Array.from([0xff, 0xfe, ...body]);
}

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
});
afterEach(async () => {
  await db.close();
});

async function importAndApply(bytes: Uint8Array) {
  const client = pgliteClient(db);
  const run = await runSyncPipeline(client, bytes);
  await executeApply(client, run.bundle, OWNER);
  return run.bundle.plan;
}
async function proposalFor(bytes: Uint8Array) {
  const plan = (await runSyncPipeline(pgliteClient(db), bytes)).bundle.plan;
  return {
    parks: plan.unresolved.map((u) => `${u.dexId} ${u.reason}`),
    creates: plan.creates.map((c) => c.catalogCardId),
    retires: plan.retires.map((r) => r.catalogCardId),
  };
}
async function keys(table: "copy" | "presence_group"): Promise<string[]> {
  const r = await db.query<{ k: string }>(
    `select catalog_card_id as k from ${table} order by catalog_card_id`,
  );
  return r.rows.map((row) => row.k);
}

describe("UIL-099 E3 · a case-folded Japanese set resolves to the id exactly as stored", () => {
  // Her export writes the set code lower case; the mirror stores TCGdex's mixed case.
  const JA_ROW =
    "collection;Pokemon;Japanese;SV;Battle Partners;jpn_sv9-42;42;Pikachu;Normal;;;1;;";

  beforeEach(async () => {
    await db.exec(`
      insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id, types, locale)
      values ('ja:SV9-042', 'ピカチュウ', 'ja:SV9', 'バトルパートナーズ', '042', '{Lightning}', 'ja');
    `);
    await asOwner(db);
  });

  it("the copy and its presence group carry the STORED id, not the folded one", async () => {
    const plan = await importAndApply(exportBytes(JA_ROW));
    expect(plan.creates.map((c) => c.catalogCardId)).toEqual(["ja:SV9-042"]);
    await asSuperuser(db);
    expect(await keys("copy")).toEqual(["ja:SV9-042"]);
    expect(await keys("presence_group")).toEqual(["ja:SV9-042"]);
  });

  it("the next import of the same row finds that key: no twin, no retire, no park", async () => {
    await importAndApply(exportBytes(JA_ROW));
    expect(await proposalFor(exportBytes(JA_ROW))).toEqual({ parks: [], creates: [], retires: [] });
  });

  it("the learned alias makes the second import exact, and it still lands on the stored id", async () => {
    await importAndApply(exportBytes(JA_ROW));
    await asSuperuser(db);
    const alias = await db.query<{ locale: string; dex_code: string; tcgdex_set_id: string }>(
      "select locale, dex_code, tcgdex_set_id from set_alias",
    );
    expect(alias.rows).toEqual([{ locale: "ja", dex_code: "sv9", tcgdex_set_id: "ja:SV9" }]);
    await asOwner(db);
    // A second copy of the same printing in a later export adds ONE copy under the same key.
    const plan = (
      await runSyncPipeline(pgliteClient(db), exportBytes(JA_ROW.replace(";1;;", ";2;;")))
    ).bundle.plan;
    expect(plan.creates.map((c) => c.catalogCardId)).toEqual(["ja:SV9-042"]);
    expect(plan.retires).toEqual([]);
  });
});

describe("UIL-099 E4 · a row matched to a stand-in stays on the stand-in once TCGdex adds the card", () => {
  /** A card whose SET the mirror knows (Ancient Origins → xy7) but whose NUMBER it does not carry. */
  const ROW =
    "collection;Pokemon;English;XY;Ancient Origins;xy7-99;99;Mystery Card;Normal;Rare;;1;;";

  beforeEach(async () => {
    await db.exec(`
      insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id, types)
      values ('xy7-012', 'Card A', 'xy7', 'Ancient Origins', '012', '{Fire}');
    `);
    await asOwner(db);
  });

  it("the next import keeps her row on the stand-in: nothing created under the real id, nothing retired", async () => {
    await importAndApply(exportBytes(ROW));
    const { rows } = await db.query<{ id: string }>("select id from unresolved_entry");
    const { standInId } = await manualMatchStandIn(pgliteClient(db), rows[0].id, {
      name: "Mystery Card",
      setName: "Ancient Origins",
      setId: "xy7",
      localId: "99",
      language: "en" as const,
      kind: { kind: "pokemon", type: "Fire", stage: "Basic" },
    });

    // TCGdex catches up: the real card now exists, and the resolver alone would pick it by padding.
    await asSuperuser(db);
    await db.exec(`
      insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id, types)
      values ('xy7-099', 'Mystery Card', 'xy7', 'Ancient Origins', '099', '{Fire}');
    `);
    await asOwner(db);

    expect(await proposalFor(exportBytes(ROW))).toEqual({ parks: [], creates: [], retires: [] });
    await asSuperuser(db);
    expect(await keys("copy")).toEqual([standInId]);
  });

  it("an UNKNOWN-SET stand-in stays too, once TCGdex adds the set and the card", async () => {
    // The case only the match memory protects. A stand-in for a set TCGdex lacked has no set id, so no
    // catalog lookup can find it by the row's own set and number; the case above is also held by the
    // stand-in's own (set, number). Here, once the real set arrives, the resolver alone would move the row.
    const FUTURE = "collection;Pokemon;English;SV;Future Set;zz1-5;5;Future Card;Normal;Rare;;1;;";
    await importAndApply(exportBytes(FUTURE));
    const parkedRow = await db.query<{ id: string; reason: string }>(
      "select id, reason from unresolved_entry",
    );
    expect(parkedRow.rows[0].reason).toBe("UNKNOWN_SET");
    const { standInId } = await manualMatchStandIn(pgliteClient(db), parkedRow.rows[0].id, {
      name: "Future Card",
      setName: "Future Set",
      setId: null,
      localId: "5",
      language: "en" as const,
      kind: { kind: "pokemon", type: "Fire", stage: "Basic" },
    });

    await asSuperuser(db);
    await db.exec(`
      insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id, types)
      values ('zz1-005', 'Future Card', 'zz1', 'Future Set', '005', '{Fire}');
    `);
    await asOwner(db);

    expect(await proposalFor(exportBytes(FUTURE))).toEqual({ parks: [], creates: [], retires: [] });
    await asSuperuser(db);
    expect(await keys("copy")).toEqual([standInId]);
  });
});
