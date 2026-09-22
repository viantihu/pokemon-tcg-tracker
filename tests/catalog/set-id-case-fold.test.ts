/**
 * UIL-086, the read half — `findSetIdsFoldingCase` against real Postgres.
 *
 * The pure resolution logic is pinned in tests/sync/ja-set-code-case.test.ts through a fake port; this
 * proves the query underneath it actually answers, because that is where the fix could be right in
 * TypeScript and wrong in SQL: `.eq("set_id", …)` is case-sensitive, `ilike` is not, and the `locale`
 * column is what keeps a Japanese code out of the English catalog.
 *
 * Stored ids are NEVER rewritten here (the Tech Lead's constraint): the fixture stores exactly what
 * TCGdex serves — ja ids namespaced and mixed case, en ids bare and lower — and only the lookup folds.
 *
 * ON THE QUERY'S `locale` FILTER, which has no test of its own on purpose: it is defence in depth, not
 * load-bearing, and the database proves it. A ja id is namespaced (`ja:SV9`) and an en id never is, so no
 * en set id can fold onto a ja code; and the row that would break that symmetry — locale 'en' carrying a
 * `ja:`-prefixed id — is refused outright by migration 0016's `catalog_card_locale_namespace` check
 * constraint. I tried to seed it and PGlite rejected the insert. So removing the filter changes no
 * answer reachable from real data, and a fixture engineered around the constraint would assert behaviour
 * for a row that cannot exist. The filter stays because it costs nothing and states the intent.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { catalogCardRepo } from "@/lib/repo";
import { asOwner, asSuperuser, freshRpcDb } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

let db: PGlite;

/** `locale` is a real column as of migration 0016; the `ja:` prefix is the id namespace. */
async function seedSet(setId: string, locale: "en" | "ja", localIds: string[]) {
  for (const localId of localIds) {
    await db.query(
      `insert into catalog_card (tcgdex_id, name, dex_id, set_id, local_id, types, stage, card_class, locale)
         values ($1, $2, '{}', $3, $4, '{}', null, 'standard', $5)`,
      [`${setId}-${localId}`, `Card ${localId}`, setId, localId, locale],
    );
  }
}

beforeEach(async () => {
  db = await freshRpcDb();
  // Her three Japanese sets, stored as TCGdex serves them.
  await seedSet("ja:SV9", "ja", ["042", "043"]);
  await seedSet("ja:MC", "ja", ["007"]);
  await seedSet("ja:S12a", "ja", ["112"]);
  // An English set whose bare id folds to the same string as a Japanese code she might type.
  await seedSet("sv09", "en", ["042"]);
});
afterEach(async () => {
  await db.close();
});

describe("catalogCardRepo.findSetIdsFoldingCase (UIL-086)", () => {
  it("finds the mixed-case stored id for each of her lower-case Japanese codes", async () => {
    await asOwner(db);
    const client = pgliteClient(db);
    expect(await catalogCardRepo.findSetIdsFoldingCase(client, "ja:sv9", "ja")).toEqual(["ja:SV9"]);
    expect(await catalogCardRepo.findSetIdsFoldingCase(client, "ja:mc", "ja")).toEqual(["ja:MC"]);
    expect(await catalogCardRepo.findSetIdsFoldingCase(client, "ja:s12a", "ja")).toEqual([
      "ja:S12a",
    ]);
    await asSuperuser(db);
  });

  it("is scoped by LOCALE, so a Japanese code cannot fold onto an English set", async () => {
    await asOwner(db);
    const client = pgliteClient(db);
    // `ja:sv09` folds to nothing in ja; the English `sv09` exists but is a different locale AND a
    // different string once namespaced. Either way it must not come back for a ja lookup.
    expect(await catalogCardRepo.findSetIdsFoldingCase(client, "ja:sv09", "ja")).toEqual([]);
    expect(await catalogCardRepo.findSetIdsFoldingCase(client, "SV09", "en")).toEqual(["sv09"]);
    await asSuperuser(db);
  });

  it("returns nothing for a set the mirror does not hold under ANY casing (her `mem`)", async () => {
    await asOwner(db);
    expect(await catalogCardRepo.findSetIdsFoldingCase(pgliteClient(db), "ja:mem", "ja")).toEqual(
      [],
    );
    await asSuperuser(db);
  });

  it("an exact-case code still answers with itself, so the caller can tell 'already right' from 'not there'", async () => {
    await asOwner(db);
    expect(await catalogCardRepo.findSetIdsFoldingCase(pgliteClient(db), "ja:SV9", "ja")).toEqual([
      "ja:SV9",
    ]);
    await asSuperuser(db);
  });

  it("treats LIKE wildcards as literal characters — `_` must not match a neighbouring set", async () => {
    // `ja:S12a` and `ja:S1_a` differ by one character. If the pattern's `_` were left as a wildcard,
    // asking for `ja:s1_a` would match `ja:S12a` and teach a confidently wrong set.
    await asOwner(db);
    const found = await catalogCardRepo.findSetIdsFoldingCase(pgliteClient(db), "ja:s1_a", "ja");
    await asSuperuser(db);
    expect(found).toEqual([]);
  });

  it("reports BOTH ids when two stored sets fold to one code, so the caller can refuse to guess", async () => {
    await seedSet("ja:Mc", "ja", ["008"]); // a second set folding to `ja:mc`
    await asOwner(db);
    const found = await catalogCardRepo.findSetIdsFoldingCase(pgliteClient(db), "ja:mc", "ja");
    await asSuperuser(db);
    expect([...found].sort()).toEqual(["ja:MC", "ja:Mc"]);
  });
});
