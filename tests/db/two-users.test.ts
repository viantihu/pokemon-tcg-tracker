/**
 * UIL-127b — two accounts in one database, on real Postgres (PGlite, every migration on disk), as the signed-in
 * `authenticated` role. QA's item 4 and the Tech Lead's C2, C3, C4 and C6.
 *
 * What must hold, for EVERY owner-scoped table (discovered from the schema, not listed, so a new table is covered or
 * this fails): account B reads none of A's rows, and B's updates and deletes touch none of them. apply_write_ops
 * naming A's ids changes nothing of A's. A stand-in, a learned alias and a colour setting are each their owner's. A
 * binder id a row names must be its owner's, on every path, while a binder delete still leaves its cards movable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyWriteOps, colorBandRepo, typeColorMapRepo, type DbClient } from "@/lib/repo";
import { clearCatalogCache, loadCatalogCached } from "@/lib/plan/catalog-cache";
import { applyOps, asSuperuser, freshRpcDb, OWNER as A } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const B = "00000000-0000-0000-0000-00000000000b";

/** A row id for `owner` in slot `n` (valid uuid hex; distinct per owner). */
const id = (owner: string, n: number) =>
  `${owner === A ? "a" : "b"}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const STAND_IN = (owner: string) =>
  `user:en:${owner === A ? "a" : "b"}1111111-1111-4111-8111-111111111111`;

let db: PGlite;
let current = A;

vi.mock("@/lib/plan/session", () => ({
  getOwnerContext: async () => ({ db: pgliteClient(db) as DbClient, ownerId: current }),
  SEEDED_OWNER_ID: "00000000-0000-0000-0000-000000000001",
}));

async function as(owner: string): Promise<void> {
  current = owner;
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${owner}', false);`);
  await db.exec(`set role authenticated;`);
}

/** One row in every owner-scoped table for `owner`, as a real collection would hold them. */
async function seed(owner: string): Promise<void> {
  await asSuperuser(db);
  const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
  await q(
    `insert into catalog_card (tcgdex_id, name, source, owner_id) values ($1, 'Mystery', 'user', $2)`,
    [STAND_IN(owner), owner],
  );
  await q(`insert into haul (id, owner_id, source) values ($1, $2, 'bulk-bin')`, [
    id(owner, 1),
    owner,
  ]);
  await q(`insert into binder (id, owner_id, name, type) values ($1, $2, 'KB', 'general')`, [
    id(owner, 2),
    owner,
  ]);
  await q(`insert into binder (id, owner_id, name, type) values ($1, $2, 'KB2', 'general')`, [
    id(owner, 22),
    owner,
  ]);
  await q(`insert into collection (id, owner_id, name, mode) values ($1, $2, 'Set', 'finite')`, [
    id(owner, 3),
    owner,
  ]);
  await q(
    `insert into presence_group (id, owner_id, catalog_card_id, dex_variant_raw, desired_count) values ($1, $2, 'sv03-026', 'Normal', 1)`,
    [id(owner, 4), owner],
  );
  await q(
    `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id) values ($1, $2, 4, 'red', $3)`,
    [id(owner, 5), owner, id(owner, 2)],
  );
  await q(
    `insert into copy (id, owner_id, catalog_card_id, presence_group_id, role, binder_id, binder_half, color_band)
     values ($1, $2, 'sv03-026', $3, 'shelved', $4, 'front', 'red')`,
    [id(owner, 6), owner, id(owner, 4), id(owner, 2)],
  );
  await q(
    `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, target_catalog_card_id)
     values ($1, $2, $3, 0, 'Basic', 'placeholder', 'sv03-026')`,
    [id(owner, 7), owner, id(owner, 5)],
  );
  await q(
    `insert into wishlist_item (id, owner_id, line_slot_id, required_dex_id, held_for_binder_id) values ($1, $2, $3, 4, $4)`,
    [id(owner, 8), owner, id(owner, 7), id(owner, 2)],
  );
  await q(
    `insert into binder_block (id, owner_id, binder_id, half, pocket_count, purpose, material, line_id)
     values ($1, $2, $3, 'back', 1, 'line-terminated', 'basicEnergy', $4)`,
    [id(owner, 9), owner, id(owner, 2), id(owner, 5)],
  );
  await q(
    `insert into placement_decision (id, owner_id, copy_id, decision, reason, resolved_by) values ($1, $2, $3, 'shelved', 'r', 'auto')`,
    [id(owner, 10), owner, id(owner, 6)],
  );
  await q(
    `insert into unresolved_entry (id, owner_id, dex_id, dex_variant_raw, quantity, reason) values ($1, $2, 'me6-14', 'Normal', 1, 'UNKNOWN_SET')`,
    [id(owner, 11), owner],
  );
  await q(`insert into last_sync_snapshot (id, owner_id, snapshot) values ($1, $2, '{}'::jsonb)`, [
    id(owner, 12),
    owner,
  ]);
  await q(
    `insert into removed_presence (owner_id, catalog_card_id, dex_variant_raw, count) values ($1, 'sv03-026', 'Holo', 1)`,
    [owner],
  );
  await q(
    `insert into dex_presence (owner_id, catalog_card_id, dex_variant_raw, quantity) values ($1, 'sv03-026', 'Normal', 1)`,
    [owner],
  );
  await q(`insert into dex_import (owner_id, file_total, row_count) values ($1, 1, 1)`, [owner]);
  await q(`insert into onboarding (owner_id) values ($1)`, [owner]);
  await q(
    `insert into set_alias (owner_id, locale, dex_code, tcgdex_set_id) values ($1, 'en', 'OBF', 'sv03')`,
    [owner],
  );
  await q(
    `insert into owner_band_order (owner_id, band, position) select $1, band, position from color_band`,
    [owner],
  );
  await q(
    `insert into owner_type_band (owner_id, card_type, band) select $1, card_type, band from type_color_map`,
    [owner],
  );
}

/** Every public table carrying an owner_all policy: the owner-scoped tables, discovered. */
async function ownerTables(): Promise<string[]> {
  await asSuperuser(db);
  const r = await db.query<{ tablename: string }>(`
    select tablename from pg_policies
    where schemaname = 'public' and cmd = 'ALL' and qual ~ 'owner_id = auth\\.uid\\(\\)' order by 1`);
  return r.rows.map((x) => x.tablename);
}

async function countFor(table: string, owner: string): Promise<number> {
  await asSuperuser(db);
  const r = await db.query<{ n: number }>(
    `select count(*)::int as n from "${table}" where owner_id = $1`,
    [owner],
  );
  return r.rows[0].n;
}

beforeEach(async () => {
  db = await freshRpcDb();
  clearCatalogCache();
  await db.exec(
    `insert into catalog_card (tcgdex_id, name, types) values ('sv03-026', 'Charmander', '{Fire}')`,
  );
  await seed(A);
  await seed(B);
});
afterEach(async () => {
  await db.close();
});

describe("UIL-127b · every owner table: B cannot read, change or delete A's rows", () => {
  it("the seed covers every owner-scoped table (a new one must be added here, or this fails)", async () => {
    for (const t of await ownerTables()) expect(await countFor(t, A), t).toBeGreaterThan(0);
  });

  it("B's select, update and delete reach none of A's rows, in every owner table", async () => {
    const tables = await ownerTables();
    expect(tables.length).toBeGreaterThanOrEqual(19);
    const before = new Map<string, number>();
    for (const t of tables) before.set(t, await countFor(t, A));
    for (const t of tables) {
      await as(B);
      const seen = await db.query<{ n: number }>(
        `select count(*)::int as n from "${t}" where owner_id = '${A}'`,
      );
      expect(seen.rows[0].n, `${t}: B reads A's rows`).toBe(0);
      const upd = await db.query(`update "${t}" set owner_id = owner_id where owner_id = '${A}'`);
      expect(upd.affectedRows ?? 0, `${t}: B updates A's rows`).toBe(0);
      const del = await db.query(`delete from "${t}" where owner_id = '${A}'`);
      expect(del.affectedRows ?? 0, `${t}: B deletes A's rows`).toBe(0);
    }
    for (const t of tables) expect(await countFor(t, A), t).toBe(before.get(t));
  });

  it("apply_write_ops as B naming A's ids changes nothing of A's", async () => {
    await as(B);
    await applyOps(db, {
      ops: [
        {
          op: "update_copy",
          id: id(A, 6),
          patch: { role: "bulk", binder_id: null, binder_half: null, color_band: null },
        },
        { op: "update_line", id: id(A, 5), patch: { status: "closed" } },
        { op: "update_slot", id: id(A, 7), patch: { note: "B was here" } },
        { op: "delete_copy", id: id(A, 6) },
      ],
    });
    await asSuperuser(db);
    const copy = await db.query(`select role, binder_id from copy where id = $1`, [id(A, 6)]);
    expect(copy.rows).toEqual([{ role: "shelved", binder_id: id(A, 2) }]);
    const line = await db.query(`select status from evolution_line where id = $1`, [id(A, 5)]);
    expect(line.rows).toEqual([{ status: "open" }]);
    const slot = await db.query(`select note from line_slot where id = $1`, [id(A, 7)]);
    expect(slot.rows).toEqual([{ note: null }]);
  });
});

describe("UIL-127b · a stand-in is its owner's", () => {
  it("B cannot read or edit A's stand-in, and may create its own twin of it", async () => {
    await as(B);
    const seen = await db.query(
      `select tcgdex_id from catalog_card where source = 'user' order by 1`,
    );
    expect(seen.rows).toEqual([{ tcgdex_id: STAND_IN(B) }]);
    const upd = await db.query(`update catalog_card set name = 'mine now' where tcgdex_id = $1`, [
      STAND_IN(A),
    ]);
    expect(upd.affectedRows ?? 0).toBe(0);
    // The twin index is per owner: B's stand-in with A's exact name, set and number is B's own.
    await db.query(`update catalog_card set name = 'Mystery' where tcgdex_id = $1`, [STAND_IN(B)]);
    await applyOps(db, {
      ops: [
        {
          op: "insert_catalog_stand_in",
          tcgdex_id: "user:fr:b2222222-2222-4222-8222-222222222222",
          name: "Mystery",
          set_id: null,
          set_name: null,
          local_id: null,
          dex_id: [],
          types: [],
          stage: null,
          card_class: "standard",
        } as never,
      ],
    });
    await asSuperuser(db);
    const mine = await db.query(
      `select owner_id from catalog_card where tcgdex_id like 'user:fr:%'`,
    );
    expect(mine.rows).toEqual([{ owner_id: B }]);
    const theirs = await db.query(`select name from catalog_card where tcgdex_id = $1`, [
      STAND_IN(A),
    ]);
    expect(theirs.rows).toEqual([{ name: "Mystery" }]);
  });

  it("B cannot create a stand-in in A's name", async () => {
    await as(B);
    await expect(
      db.query(
        `insert into catalog_card (tcgdex_id, name, source, owner_id) values ($1, 'x', 'user', $2)`,
        ["user:en:b3333333-3333-4333-8333-333333333333", A],
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("C4: the cached catalog never hands one account's stand-in to another, whoever warms it first", async () => {
    for (const [first, second] of [
      [A, B],
      [B, A],
    ]) {
      clearCatalogCache();
      await as(first);
      const a = (await loadCatalogCached(pgliteClient(db))).map((r) => r.tcgdex_id);
      await as(second);
      const b = (await loadCatalogCached(pgliteClient(db))).map((r) => r.tcgdex_id);
      expect(a).toContain(STAND_IN(first));
      expect(a).not.toContain(STAND_IN(second));
      expect(b).toContain(STAND_IN(second));
      expect(b).not.toContain(STAND_IN(first));
      expect(a).toContain("sv03-026");
      expect(b).toContain("sv03-026");
    }
  });
});

describe("UIL-127b · a learned set alias is its owner's", () => {
  it("B's match of the same set code teaches B, not A; B's forget removes only B's", async () => {
    await as(B);
    await applyOps(db, {
      ops: [
        {
          op: "upsert_set_alias",
          locale: "en",
          dex_code: "OBF",
          tcgdex_set_id: "sv99",
          source: "manual",
        },
      ],
    });
    await asSuperuser(db);
    const both = await db.query(`select owner_id, tcgdex_set_id from set_alias order by owner_id`);
    expect(both.rows).toEqual([
      { owner_id: A, tcgdex_set_id: "sv03" },
      { owner_id: B, tcgdex_set_id: "sv99" },
    ]);
    await as(B);
    await applyOps(db, { ops: [{ op: "delete_set_alias", locale: "en", dex_code: "OBF" }] });
    await asSuperuser(db);
    const left = await db.query(`select owner_id from set_alias`);
    expect(left.rows).toEqual([{ owner_id: A }]);
  });
});

describe("UIL-127b · colour settings are per account (Karvi: 'Yes, per user')", () => {
  const order = async (owner: string) => {
    await as(owner);
    return (await colorBandRepo.listOrdered(pgliteClient(db))).map((b) => b.band);
  };
  const map = async (owner: string) => {
    await as(owner);
    return Object.fromEntries(
      (await typeColorMapRepo.list(pgliteClient(db))).map((t) => [t.card_type, t.band]),
    );
  };

  it("C4: B's reorder leaves A's order; B's type change leaves A's map", async () => {
    const aOrder = await order(A);
    const aMap = await map(A);
    await as(B);
    await applyWriteOps(pgliteClient(db), {
      ops: [{ op: "set_band_order", bands: [...aOrder].reverse() }],
    });
    await applyWriteOps(pgliteClient(db), {
      ops: [{ op: "set_type_band", card_type: "Fire", band: "pink" }],
    });
    expect(await order(B)).toEqual([...aOrder].reverse());
    expect((await map(B)).Fire).toBe("pink");
    expect(await order(A)).toEqual(aOrder);
    expect(await map(A)).toEqual(aMap);
  });

  it("an account with no colour rows reads the defaults, and its first change copies them in whole", async () => {
    await asSuperuser(db);
    await db.exec(
      `delete from owner_type_band where owner_id = '${B}'; delete from owner_band_order where owner_id = '${B}';`,
    );
    const defaults = await db.query<{ card_type: string; band: string }>(
      `select card_type, band from type_color_map`,
    );
    expect(Object.keys(await map(B)).length).toBe(defaults.rows.length);
    await as(B);
    await applyWriteOps(pgliteClient(db), {
      ops: [{ op: "set_type_band", card_type: "Water", band: "red" }],
    });
    const after = await map(B);
    expect(Object.keys(after).length).toBe(defaults.rows.length);
    expect(after.Water).toBe("red");
  });

  it("an order that does not name every band once is refused, and nothing changes", async () => {
    const before = await order(B);
    await as(B);
    for (const bands of [
      before.slice(1),
      [...before.slice(1), before[1]],
      [...before.slice(1), "mauve"],
    ]) {
      await expect(
        applyWriteOps(pgliteClient(db), { ops: [{ op: "set_band_order", bands }] }),
      ).rejects.toThrow(/every band once/);
    }
    expect(await order(B)).toEqual(before);
  });

  it("C6: A's Settings type change recomputes A's stored bands and never B's", async () => {
    const { setTypeBand } = await import("@/app/(ui)/settings/actions");
    await as(A);
    const res = await setTypeBand("Fire", "orange");
    expect(res.ok).toBe(true);
    await asSuperuser(db);
    const bands = await db.query<{ owner_id: string; color_band: string }>(
      `select owner_id, color_band from copy order by owner_id`,
    );
    expect(bands.rows).toEqual([
      { owner_id: A, color_band: "orange" },
      { owner_id: B, color_band: "red" },
    ]);
  });
});

describe("UIL-127b · a binder a row names is its owner's (the Tech Lead's C2), on every path", () => {
  const direct: [string, string, (binder: string) => [string, unknown[]]][] = [
    [
      "copy.binder_id",
      "copy",
      (binder) => [
        `insert into copy (owner_id, catalog_card_id, presence_group_id, role, binder_id, binder_half, color_band) values ($1, 'sv03-026', $2, 'shelved', $3, 'front', 'red')`,
        [B, id(B, 4), binder],
      ],
    ],
    [
      "evolution_line.binder_id",
      "evolution_line",
      (binder) => [
        `insert into evolution_line (owner_id, root_dex_id, color_band, binder_id) values ($1, 7, 'red', $2)`,
        [B, binder],
      ],
    ],
    [
      "binder_block.binder_id",
      "binder_block",
      (binder) => [
        `insert into binder_block (owner_id, binder_id, half, pocket_count, purpose, material) values ($1, $2, 'back', 1, 'collection-reserve', 'basicEnergy')`,
        [B, binder],
      ],
    ],
    [
      "wishlist_item.held_for_binder_id",
      "wishlist_item",
      (binder) => [
        `insert into wishlist_item (owner_id, required_dex_id, held_for_binder_id) values ($1, 4, $2)`,
        [B, binder],
      ],
    ],
  ];

  it.each(direct)(
    "a direct table write, %s: A's binder refused, B's own accepted",
    async (_, _t, write) => {
      await as(B);
      const [bad, badParams] = write(id(A, 2));
      await expect(db.query(bad, badParams)).rejects.toThrow(/isn't one of yours/);
      const [good, goodParams] = write(id(B, 2));
      await expect(db.query(good, goodParams)).resolves.toBeTruthy();
    },
  );

  it.each([
    ["copy.binder_id", { op: "update_copy", id: id(B, 6), patch: { binder_id: id(A, 2) } }],
    [
      "evolution_line.binder_id",
      { op: "insert_line", id: id(B, 32), root_dex_id: 7, color_band: "red", binder_id: id(A, 2) },
    ],
    [
      "binder_block.binder_id",
      {
        op: "insert_binder_block",
        id: id(B, 30),
        binder_id: id(A, 2),
        half: "back",
        pocket_count: 1,
        purpose: "collection-reserve",
        material: "basicEnergy",
        copy_id: null,
        line_id: null,
      },
    ],
    [
      "wishlist_item.held_for_binder_id",
      {
        op: "insert_wishlist",
        id: id(B, 31),
        line_slot_id: null,
        required_dex_id: 4,
        required_type: null,
        required_stage: null,
        chosen_catalog_card_id: null,
        alternate_catalog_card_ids: [],
        held_for_binder_id: id(A, 2),
      },
    ],
  ])("through apply_write_ops, %s: A's binder refused", async (_, op) => {
    await as(B);
    await expect(applyOps(db, { ops: [op as never] })).rejects.toThrow(/isn't one of yours/);
  });

  it("C3: a binder delete leaves its shelved card binderless, and that card can still be touched and moved", async () => {
    await as(A);
    await db.query(`delete from binder_block where binder_id = $1`, [id(A, 2)]);
    await db.query(`delete from binder where id = $1`, [id(A, 2)]);
    await asSuperuser(db);
    const orphan = await db.query(`select role, binder_id from copy where id = $1`, [id(A, 6)]);
    expect(orphan.rows).toEqual([{ role: "shelved", binder_id: null }]);
    await as(A);
    // Touched without a new binder: not refused (the payload does not set its binder).
    await applyWriteOps(pgliteClient(db), {
      ops: [{ op: "update_copy", id: id(A, 6), patch: { color_band: "red" } }],
    });
    // Moved into her other binder: accepted.
    await applyWriteOps(pgliteClient(db), {
      ops: [
        { op: "update_copy", id: id(A, 6), patch: { binder_id: id(A, 22), binder_half: "front" } },
      ],
    });
    await asSuperuser(db);
    const moved = await db.query(`select binder_id from copy where id = $1`, [id(A, 6)]);
    expect(moved.rows).toEqual([{ binder_id: id(A, 22) }]);
  });

  it("a shelved card the payload puts in NO binder is refused (the backstop for UIL-127a)", async () => {
    await as(A);
    await expect(
      applyWriteOps(pgliteClient(db), {
        ops: [{ op: "update_copy", id: id(A, 6), patch: { binder_id: null } }],
      }),
    ).rejects.toThrow(/no binder to go to/);
  });

  it("a restore-shaped superuser insert passes when owners match, and is refused when they do not", async () => {
    await asSuperuser(db);
    await expect(
      db.query(
        `insert into evolution_line (owner_id, root_dex_id, color_band, binder_id) values ($1, 8, 'red', $2)`,
        [A, id(A, 2)],
      ),
    ).resolves.toBeTruthy();
    await expect(
      db.query(
        `insert into evolution_line (owner_id, root_dex_id, color_band, binder_id) values ($1, 9, 'red', $2)`,
        [B, id(A, 2)],
      ),
    ).rejects.toThrow(/isn't one of yours/);
  });

  it("a row whose binder is not changed is never refused for it (a mismatch written before 0033 stays editable)", async () => {
    await asSuperuser(db);
    await db.exec(`set session_replication_role = replica;`);
    await db.query(`update copy set binder_id = $1 where id = $2`, [id(A, 2), id(B, 6)]);
    await db.exec(`set session_replication_role = origin;`);
    await as(B);
    // The same binder id written again is no change: accepted.
    await applyOps(db, {
      ops: [{ op: "update_copy", id: id(B, 6), patch: { binder_id: id(A, 2), color_band: "red" } }],
    });
    // Moving it to B's own binder: accepted.
    await applyOps(db, {
      ops: [{ op: "update_copy", id: id(B, 6), patch: { binder_id: id(B, 2) } }],
    });
  });
});
