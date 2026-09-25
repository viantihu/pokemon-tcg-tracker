/**
 * UIL-098 part 4 — migration 0023: the DATABASE refuses a copy the next Dex import could not see.
 *
 * Karvi's charge (2026-09-23): card entry is a Dex import or the Sync page's match of a Dex row, nothing
 * else. Both carry the row's presence group, and the import builds "what she owns" from groups only, so a
 * copy with no group is invisible to it and gets twinned. tests/copy/only-sync-creates-copies.test.ts keeps
 * the TypeScript to one writer; this pins the database half: NOT NULL, ON DELETE RESTRICT, the migration's
 * own refusal to run over an ungrouped copy, and that the test harness's fixture shim cannot hide an app bug.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import {
  applyOps,
  asOwner,
  asSuperuser,
  freshRpcDb,
  MIGRATIONS,
  OWNER,
} from "../support/pglite-rpc";

const CARD = "sv03-026";
const G = "70000000-0000-4000-8000-000000000001";

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await db.exec(`insert into catalog_card (tcgdex_id, name) values ('${CARD}', 'Charmander')`);
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

describe("0023 · every copy has a presence group", () => {
  it("apply_write_ops refuses an insert_copy with no group, as the owner — the app's own path", async () => {
    await expect(
      applyOps(db, {
        // Built by hand to get past the type (presence_group_id is required since 0023).
        ops: [
          {
            op: "insert_copy",
            id: crypto.randomUUID(),
            catalog_card_id: CARD,
            role: "haul",
          } as never,
        ],
      }),
    ).rejects.toThrow(/presence_group_id/);
  });

  it("a direct insert with no group is refused too — RLS alone would have let the owner do it", async () => {
    await expect(
      db.query(`insert into copy (owner_id, catalog_card_id, role) values ($1, $2, 'haul')`, [
        OWNER,
        CARD,
      ]),
    ).rejects.toThrow(/presence_group_id/);
  });

  it("a copy WITH its group goes in", async () => {
    await applyOps(db, {
      ops: [
        {
          op: "insert_presence_group",
          id: G,
          catalog_card_id: CARD,
          dex_variant_raw: "Normal",
          desired_count: 0,
        },
        {
          op: "insert_copy",
          id: crypto.randomUUID(),
          catalog_card_id: CARD,
          dex_variant_raw: "Normal",
          presence_group_id: G,
          role: "haul",
        },
      ],
    });
    await asSuperuser(db);
    expect((await db.query(`select count(*)::int n from copy`)).rows).toEqual([{ n: 1 }]);
  });

  it("ON DELETE RESTRICT: a group that still holds a card cannot be deleted", async () => {
    await applyOps(db, {
      ops: [
        {
          op: "insert_presence_group",
          id: G,
          catalog_card_id: CARD,
          dex_variant_raw: "Normal",
          desired_count: 0,
        },
        {
          op: "insert_copy",
          id: crypto.randomUUID(),
          catalog_card_id: CARD,
          presence_group_id: G,
          role: "haul",
        },
      ],
    });
    await asSuperuser(db);
    await expect(db.query(`delete from presence_group where id = $1`, [G])).rejects.toThrow(
      /copy_presence_group_id_fkey/,
    );
    // Copies first, then the group — the order the Testing wipe uses — is fine.
    await db.query(`delete from copy`);
    await db.query(`delete from presence_group where id = $1`, [G]);
  });
});

describe("0023 · the harness's fixture shim cannot hide an app bug", () => {
  it("fires for the bootstrap superuser (fixture seeding): the copy gets the group an import would give it", async () => {
    await asSuperuser(db);
    await db.query(
      `insert into copy (owner_id, catalog_card_id, role) values ($1, $2, 'shelved')`,
      [OWNER, CARD],
    );
    const r = await db.query<{ card: string; variant: string }>(
      `select g.catalog_card_id card, g.dex_variant_raw variant from copy c join presence_group g on g.id = c.presence_group_id`,
    );
    expect(r.rows).toEqual([{ card: CARD, variant: "Normal" }]);
  });

  it("does NOT fire for the owner, the role app code runs as — both refusals above prove it", async () => {
    // Stated as its own case so a future change to the shim that widened it would fail HERE by name.
    await expect(
      db.query(`insert into copy (owner_id, catalog_card_id, role) values ($1, $2, 'haul')`, [
        OWNER,
        CARD,
      ]),
    ).rejects.toThrow(/presence_group_id/);
  });
});

describe("0023 · the migration refuses to run over a copy the import cannot see", () => {
  it("raises, naming the count, on a database that already holds an ungrouped copy", async () => {
    const raw = new PGlite({ extensions: { pgcrypto } });
    await raw.exec(`
      create schema if not exists auth;
      create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
      do $$ begin
        if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
        if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
        if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
      end $$;
    `);
    const upTo = MIGRATIONS.filter((f) => f < "0023");
    for (const f of upTo) {
      await raw.exec(readFileSync(path.join(process.cwd(), "supabase", "migrations", f), "utf8"));
    }
    await raw.exec(`insert into catalog_card (tcgdex_id, name) values ('${CARD}', 'Charmander');
      insert into copy (owner_id, catalog_card_id, role) values ('${OWNER}', '${CARD}', 'haul'),
                                                             ('${OWNER}', '${CARD}', 'haul');`);
    const mig = MIGRATIONS.find((f) => f.startsWith("0023"))!;
    await expect(
      raw.exec(readFileSync(path.join(process.cwd(), "supabase", "migrations", mig), "utf8")),
    ).rejects.toThrow(/0023: 2 copy row\(s\) have no presence group/);
    // Nothing changed: the column is still nullable, the copies are still there.
    const col = await raw.query<{ is_nullable: string }>(
      `select is_nullable from information_schema.columns where table_name = 'copy' and column_name = 'presence_group_id'`,
    );
    expect(col.rows[0].is_nullable).toBe("YES");
    await raw.close();
  });
});
