/**
 * UIL-108 — a stand-in's language, in the database: the id carries it, `catalog_card.locale` agrees with the
 * id (the Senior BA's one condition), and a twin is the same card in the SAME language. Real PGlite with
 * every migration applied (0027 included), real RLS, the real `manualMatchStandIn`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { manualMatchStandIn, StandInTwinError, type StandInInput } from "@/lib/sync";
import { asOwner, asSuperuser, freshRpcDb, OWNER } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

let db: PGlite;
const E1 = "e0000000-0000-0000-0000-0000000001e1";
const E2 = "e0000000-0000-0000-0000-0000000001e2";
const OLD = "user:0f0e0d0c-0b0a-4908-8706-050403020100";
const q = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

async function entry(id: string, locale: string, variant: string) {
  await asSuperuser(db);
  await db.query(
    `insert into unresolved_entry (id, owner_id, dex_id, dex_set_name, dex_number, dex_name,
       dex_variant_raw, quantity, locale, reason, status)
       values ($1, $2, 'sv03-999', 'Obsidian Flames', '999', 'Mystery Fossil', $4, 1, $3,
         'UNKNOWN_CARD', 'WAITING')`,
    [id, OWNER, locale, variant],
  );
  await asOwner(db);
}

const FOSSIL = (language: StandInInput["language"]): StandInInput => ({
  name: "Mystery Fossil",
  setName: "Obsidian Flames",
  setId: "sv03",
  localId: "999",
  language,
  kind: { kind: "pokemon", type: "Fire", stage: "Basic" },
});

async function standIns() {
  await asSuperuser(db);
  const rows = await q<{ tcgdex_id: string; locale: string }>(
    "select tcgdex_id, locale from catalog_card where source = 'user' order by tcgdex_id",
  );
  await asOwner(db);
  return rows;
}

beforeEach(async () => {
  db = await freshRpcDb();
  await db.exec(`
    insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id, types)
      values ('sv03-027', 'Charmeleon', 'sv03', 'Obsidian Flames', '027', '{Fire}');
  `);
  await entry(E1, "International", "Normal");
  await entry(E2, "Japanese", "Reverse Holo");
});
afterEach(async () => {
  await db.close();
});

describe("UIL-108 · the id carries the language, and the column agrees with it", () => {
  it("a French stand-in is user:fr:<uuid> with locale fr; a Japanese one user:ja:<uuid> with locale ja", async () => {
    const fr = await manualMatchStandIn(pgliteClient(db), E1, FOSSIL("fr"));
    const ja = await manualMatchStandIn(pgliteClient(db), E2, FOSSIL("ja"));
    expect(fr.standInId).toMatch(/^user:fr:[0-9a-f-]{36}$/);
    expect(ja.standInId).toMatch(/^user:ja:[0-9a-f-]{36}$/);
    const rows = await standIns();
    expect(rows.find((r) => r.tcgdex_id === fr.standInId)?.locale).toBe("fr");
    expect(rows.find((r) => r.tcgdex_id === ja.standInId)?.locale).toBe("ja");
  });

  it("the column is written FROM the id: a disagreeing locale in the write is overwritten", async () => {
    await asSuperuser(db);
    await db.query(
      `insert into catalog_card (tcgdex_id, name, source, locale)
         values ('user:de:1f0e0d0c-0b0a-4908-8706-050403020100', 'x', 'user', 'en')`,
    );
    expect(await q("select locale from catalog_card where tcgdex_id like 'user:de:%'")).toEqual([
      { locale: "de" },
    ]);
    // And an update that tries to move the column away from the id is put back.
    await db.query("update catalog_card set locale = 'ja' where tcgdex_id like 'user:de:%'");
    expect(await q("select locale from catalog_card where tcgdex_id like 'user:de:%'")).toEqual([
      { locale: "de" },
    ]);
  });

  it("the check itself refuses a disagreement, trigger or no trigger (belt and braces)", async () => {
    await asSuperuser(db);
    await db.exec("alter table catalog_card disable trigger catalog_card_stand_in_locale");
    await expect(
      db.query(
        `insert into catalog_card (tcgdex_id, name, source, locale)
           values ('user:de:2f0e0d0c-0b0a-4908-8706-050403020100', 'x', 'user', 'en')`,
      ),
    ).rejects.toThrow(/catalog_card_locale_namespace/);
    await db.exec("alter table catalog_card enable trigger catalog_card_stand_in_locale");
  });

  it("a stand-in made before UIL-108 (user:<uuid>, locale en) is still valid, as the 5 on Testing are", async () => {
    await asSuperuser(db);
    await db.query(
      `insert into catalog_card (tcgdex_id, name, source) values ($1, 'Old stand-in', 'user')`,
      [OLD],
    );
    expect(await q("select locale from catalog_card where tcgdex_id = $1", [OLD])).toEqual([
      { locale: "en" },
    ]);
  });

  it("an id outside the shape is refused: an unknown language, or a malformed uuid", async () => {
    await asSuperuser(db);
    // An unknown language: the trigger derives locale 'xx' from the id, which the column's domain refuses.
    await expect(
      db.query(`insert into catalog_card (tcgdex_id, name, source) values ($1, 'x', 'user')`, [
        "user:xx:3f0e0d0c-0b0a-4908-8706-050403020100",
      ]),
    ).rejects.toThrow(/catalog_card_locale_check/);
    // A known language with a malformed tail, or a language in the wrong case: the id-shape check.
    for (const bad of ["user:fr:not-a-uuid", "user:FR:3f0e0d0c-0b0a-4908-8706-050403020100"]) {
      await expect(
        db.query(`insert into catalog_card (tcgdex_id, name, source) values ($1, 'x', 'user')`, [
          bad,
        ]),
      ).rejects.toThrow(/catalog_card_stand_in_id_language/);
    }
  });

  it("a mirrored card keeps 0016's rule exactly: only en or ja, and ja only in the ja: namespace", async () => {
    await asSuperuser(db);
    await expect(
      db.query(`insert into catalog_card (tcgdex_id, name, locale) values ('sv03-900', 'x', 'fr')`),
    ).rejects.toThrow(/catalog_card_locale_namespace/);
    await expect(
      db.query(
        `insert into catalog_card (tcgdex_id, name, locale) values ('ja:SV3-900', 'x', 'en')`,
      ),
    ).rejects.toThrow(/catalog_card_locale_namespace/);
  });

  it("refuses a stand-in with no language, or one we do not offer, before writing anything", async () => {
    for (const language of ["", "xx"] as never[]) {
      await expect(manualMatchStandIn(pgliteClient(db), E1, FOSSIL(language))).rejects.toThrow(
        /Pick the language the card is printed in/,
      );
    }
    expect(await standIns()).toEqual([]);
  });
});

describe("UIL-108 · a twin is the same card in the SAME language", () => {
  it("an English and a Japanese stand-in of one card are two cards", async () => {
    await manualMatchStandIn(pgliteClient(db), E1, FOSSIL("en"));
    await manualMatchStandIn(pgliteClient(db), E2, FOSSIL("ja"));
    expect((await standIns()).map((r) => r.locale).sort()).toEqual(["en", "ja"]);
  });

  it("the same card in the same language is refused, naming the language, with the twin offered", async () => {
    const first = await manualMatchStandIn(pgliteClient(db), E1, FOSSIL("fr"));
    const attempt = manualMatchStandIn(pgliteClient(db), E2, {
      ...FOSSIL("fr"),
      name: "  mystery FOSSIL ",
    });
    await expect(attempt).rejects.toBeInstanceOf(StandInTwinError);
    await expect(attempt).rejects.toThrow(/\(French\) already exists/);
    expect(((await attempt.catch((e: unknown) => e)) as StandInTwinError).twin.tcgdex_id).toBe(
      first.standInId,
    );
    expect(await standIns()).toHaveLength(1);
  });

  it("a stand-in made before UIL-108 recorded no language, so it is nobody's twin", async () => {
    await asSuperuser(db);
    await db.query(
      `insert into catalog_card (tcgdex_id, name, set_name, local_id, source)
         values ($1, 'Mystery Fossil', 'Obsidian Flames', '999', 'user')`,
      [OLD],
    );
    await asOwner(db);
    const made = await manualMatchStandIn(pgliteClient(db), E1, FOSSIL("en"));
    expect(made.standInId).toMatch(/^user:en:/);
  });

  it("the database refuses the twin too, for two entries racing each other", async () => {
    await asSuperuser(db);
    await db.query(
      `insert into catalog_card (tcgdex_id, name, set_name, local_id, source)
         values ('user:fr:4f0e0d0c-0b0a-4908-8706-050403020100', 'Mystery Fossil', 'Obsidian Flames', '999', 'user')`,
    );
    await expect(
      db.query(
        `insert into catalog_card (tcgdex_id, name, set_name, local_id, source)
           values ('user:fr:5f0e0d0c-0b0a-4908-8706-050403020100', ' MYSTERY fossil', 'obsidian flames', '999', 'user')`,
      ),
    ).rejects.toThrow(/catalog_card_stand_in_twin/);
    // Two stand-ins that recorded no language are outside the index, as they were before 0027.
    for (const id of [OLD, "user:6f0e0d0c-0b0a-4908-8706-050403020100"]) {
      await db.query(
        `insert into catalog_card (tcgdex_id, name, set_name, local_id, source)
           values ($1, 'Old', 'Set', '1', 'user')`,
        [id],
      );
    }
  });

  it("a racing entry that made the same stand-in first is reported as a twin, not a raw database error", async () => {
    await asOwner(db);
    const client = pgliteClient(db);
    const realRpc = client.rpc.bind(client);
    // The other entry's stand-in lands between this one's twin check and its write.
    vi.spyOn(client, "rpc").mockImplementationOnce(async (fn, args) => {
      await asSuperuser(db);
      await db.query(
        `insert into catalog_card (tcgdex_id, name, set_name, local_id, source)
           values ('user:fr:7f0e0d0c-0b0a-4908-8706-050403020100', 'Mystery Fossil', 'Obsidian Flames', '999', 'user')`,
      );
      await asOwner(db);
      return realRpc(fn, args);
    });
    const attempt = manualMatchStandIn(client, E1, FOSSIL("fr"));
    await expect(attempt).rejects.toBeInstanceOf(StandInTwinError);
    expect(((await attempt.catch((e: unknown) => e)) as StandInTwinError).twin.tcgdex_id).toBe(
      "user:fr:7f0e0d0c-0b0a-4908-8706-050403020100",
    );
    // Nothing of the losing attempt landed: still the one stand-in, and the entry still waiting.
    expect(await standIns()).toHaveLength(1);
    await asSuperuser(db);
    expect(await q("select status from unresolved_entry where id = $1", [E1])).toEqual([
      { status: "WAITING" },
    ]);
  });
});
