/**
 * `setAliasRepo.upsert` is `upsert(row)` with NO `onConflict` — supabase-js's "conflict on the primary
 * key" — and the PGlite shim refused that shape until now, so alias learning ("one manual match can drain a
 * whole set", sync-ui-spec §A.8) had never run end to end on real Postgres; UIL-029's entry carries the
 * note. Now it does: the shim reads the table's primary key from the catalog, here the composite
 * (locale, dex_code), and Postgres — not a double — decides what an overwrite is.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { setAliasRepo } from "@/lib/repo";
import { asOwner, asSuperuser, freshRpcDb } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

const keys = async () =>
  (
    await db.query<{ k: string }>("select locale || ':' || dex_code as k from set_alias order by 1")
  ).rows.map((r) => r.k);

describe("UIL-029 · setAliasRepo.upsert on real Postgres, under RLS, through the shim", () => {
  it("learns an alias, then overwrites it: one row, the new set and source, created_at kept", async () => {
    const client = pgliteClient(db);
    const first = await setAliasRepo.upsert(client, {
      locale: "ja",
      dex_code: "SV4a",
      tcgdex_set_id: "sv04.5",
    });
    expect(first).toMatchObject({
      locale: "ja",
      dex_code: "SV4a",
      tcgdex_set_id: "sv04.5",
      source: "manual", // the column default, so the payload need not say it
    });

    const second = await setAliasRepo.upsert(client, {
      locale: "ja",
      dex_code: "SV4a",
      tcgdex_set_id: "sv05",
      source: "name-resolved",
    });
    expect(second).toMatchObject({ tcgdex_set_id: "sv05", source: "name-resolved" });
    // An overwrite, not a delete-and-insert.
    expect(second.created_at).toEqual(first.created_at);
    expect(await keys()).toEqual(["ja:SV4a"]);
    expect(await setAliasRepo.getByCode(client, "ja", "SV4a")).toMatchObject({
      tcgdex_set_id: "sv05",
    });
  });

  it("the key is composite: the same dex_code in the other locale is a second row, not an overwrite", async () => {
    const client = pgliteClient(db);
    await setAliasRepo.upsert(client, { locale: "ja", dex_code: "m6", tcgdex_set_id: "sv04.5" });
    await setAliasRepo.upsert(client, { locale: "en", dex_code: "m6", tcgdex_set_id: "sv04" });
    expect(await keys()).toEqual(["en:m6", "ja:m6"]);
  });
});

describe("UIL-029 · the shim's upsert() without onConflict", () => {
  it("refuses a table with no primary key rather than guessing a target", async () => {
    await asSuperuser(db);
    await db.exec("create table nopk (a text)");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loose = pgliteClient(db) as unknown as { from: (t: string) => any };
    await expect(loose.from("nopk").upsert({ a: "x" }).select()).rejects.toThrow(/no primary key/);
  });
});
