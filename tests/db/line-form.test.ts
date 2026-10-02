/**
 * UIL-133 γ — migration 0038: a line keeps ONE form (plain, a trainer's, a regional form, Dark or Light), written when
 * it is made, so an overridden card (β) never changes what the whole line is (the Tech Lead's review of #454).
 *
 *   1. The SQL reads a card's form exactly as the app does (lib/engine/form.ts), name by name.
 *   2. Her lines are stamped from what they hold or chase, the most evolved card with a form; a line holding cards of
 *      more than one form is counted in a NOTICE (never named: the deploy log is public), never refused; a baseline taken before 0038, restored, is stamped
 *      when the restore commits with the very same forms; with triggers skipped it stays unstamped and the app still
 *      reads it right; the migration ends with no line unstamped.
 *   3. Writers: insert_line stores the form it is given; an older writer's line is stamped at commit from the cards
 *      the same write put in it; nothing outside the vocabulary is stored.
 *
 * Every card is a real TCGdex printing (2026-10-01/02) unless marked. Real Postgres (PGlite, every migration).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { CatalogCard } from "@/lib/engine";
import { loadLineScreen } from "@/lib/line";
import type { WriteOp } from "@/lib/repo";
import { formOf, ownFormOf } from "@/lib/engine/form";
import {
  applyOps,
  asOwner,
  asSuperuser,
  freshRpcDb,
  OWNER,
  seedBinders,
  seedCatalogCardsFull,
} from "../support/pglite-rpc";
import { CHARMANDER_SV03_026 } from "../engine/fixtures";
import { pgliteClient } from "../support/pglite-client";

const KB = "1c000000-0000-4000-8000-000000000038";
const id = (n: number, prefix: string) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LINE = (n: number) => id(n, "10000000");
const SLOT = (n: number, i: number) => id(n * 10 + i, "20000000");
const COPY = (n: number, i: number) => id(n * 10 + i, "c0000000");

const real = (
  tcgdexId: string,
  name: string,
  dex: number[],
  stage: string | null,
  evolveFrom: string | null,
): CatalogCard => ({
  ...CHARMANDER_SV03_026,
  tcgdexId,
  name,
  dexId: dex,
  setId: tcgdexId.replace(/^ja:/, "").split("-")[0],
  localId: tcgdexId.split("-")[1] ?? "1",
  stage,
  evolveFrom,
  artworkGroupId: `art-${tcgdexId}`,
});

const EN = [
  real("sv03-118", "Toedscool", [948], "Basic", null),
  real("sv09-089", "Toedscruel", [949], "Stage1", "Toedscool"),
  real("sv10-109", "Arven's Toedscool", [948], "Basic", null),
  real("sv10-110", "Arven's Toedscruel", [949], "Stage1", "Arven's Toedscool"),
  real("base1-49", "Drowzee", [96], "Basic", null),
  real("gym2-56", "Sabrina's Hypno", [97], "Stage1", "Drowzee"),
  real("base1-58", "Pikachu", [25], "Basic", null),
  real("sm4-31", "Alolan Raichu", [26], "Stage1", "Pikachu"),
  real("sv03-026", "Charmander", [4], "Basic", null),
  real("base5-32", "Dark Charmeleon", [5], "Stage1", "Charmander"),
  real("neo4-12", "Light Arcanine", [59], "Stage1", "Growlithe"),
  real("swsh12.5-084", "Galarian Meowth", [52], "Basic", null),
  // NOT a real printing (TCGdex names every one "Galarian Perrserker"): it drops the prefix, to walk the inheritance.
  real("x-863", "Perrserker", [863], "Stage1", "Galarian Meowth"),
  // NOT a real printing either: its evolveFrom names a card this catalog does not hold; the name alone says the form.
  real("x-862", "Obstagoon", [862], "Stage2", "Galarian Linoone"),
  real("sm1-79", "Alolan Persian", [53], "Stage1", "Alolan Meowth"),
  real("me01-114", "Boss's Orders", [], null, null),
  real("dp5-3", "Darkrai", [491], "Basic", null),
];
const JA = [
  real("ja:SV9a-047", "ペパーのノノクラゲ", [948], "Basic", null),
  real("ja:SV9a-048", "ペパーのリククラゲ", [949], "Stage1", null),
  real("ja:SM5M-001", "アローラサンド", [27], "Basic", null),
  real("ja:PMCG4-008", "わるいアーボック", [24], "Stage1", null),
  real("ja:MC-080", "オーガポン みどりのめん", [1017], "Basic", null),
  real("ja:MC-001", "エリカのナゾノクサ", [43], "Basic", null),
];
const CATALOG = [...EN, ...JA];

let db: PGlite;
afterEach(async () => {
  if (db && !db.closed) await db.close();
});

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  await asSuperuser(db);
  return (await db.query<T>(sql, params)).rows;
}

async function seedCatalog(): Promise<void> {
  await asSuperuser(db);
  await seedCatalogCardsFull(db, EN);
  for (const c of JA) {
    await db.query(
      `insert into catalog_card (tcgdex_id, name, dex_id, set_id, local_id, stage, evolve_from, locale)
         values ($1, $2, $3, $4, $5, $6, $7, 'ja')`,
      [c.tcgdexId, c.name, c.dexId, c.setId, c.localId, c.stage, c.evolveFrom],
    );
  }
}

/** A line and its stages: a card she holds there, the card she chases, or (null) nothing. */
type Stage = null | { holds: string } | { chases: string } | { target: string };
async function line(n: number, root: number, stages: Stage[]): Promise<void> {
  await q(
    `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
       values ($1, $2, $3, 'orange', $4, 'back', 'open')`,
    [LINE(n), OWNER, root, KB],
  );
  for (const [i, st] of stages.entries()) {
    const holds = st && "holds" in st ? st.holds : null;
    if (holds) {
      await q(
        `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
           values ($1, $2, $3, 'shelved', $4, 'back', 'orange')`,
        [COPY(n, i), OWNER, holds, KB],
      );
    }
    await q(
      `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id, stage_choice,
                              target_catalog_card_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        SLOT(n, i),
        OWNER,
        LINE(n),
        i,
        ["Basic", "Stage1", "Stage2"][i],
        holds ? "filled" : "placeholder",
        holds ? COPY(n, i) : null,
        st && "chases" in st ? "chase" : null,
        st && "chases" in st ? st.chases : st && "target" in st ? st.target : null,
      ],
    );
    if (holds) {
      await q(`update copy set line_slot_id = $1 where id = $2`, [SLOT(n, i), COPY(n, i)]);
    }
  }
}

/* ------------------------------------------ 1. parity ------------------------------------------ */

describe("0038 · the SQL reads a card's form exactly as the app does", () => {
  beforeEach(async () => {
    db = await freshRpcDb();
    await seedCatalog();
  });

  it("card_own_form agrees with ownFormOf on every name, en and ja", async () => {
    const names: [string, string][] = [
      ...CATALOG.map((c) => [c.name, c.tcgdexId] as [string, string]),
      ["Arven’s Toedscool", "sv10-109"],
      ["Team Rocket's Mewtwo ex", "sv10-081"],
      ["Lt. Surge's Raichu", "gym2-11"],
      ["Rocket's Hitmonchan", "gym1-11"],
      ["ALOLAN Vulpix", "sm1-1"],
      ["Hisuian Decidueye", "swsh10-082"],
      ["Paldean Wooper", "sv02-1"],
      ["Galarian Farfetch'd", "swsh2-94"],
      ["Farfetch'd", "base1-27"],
      ["Mr. Mime", "base2-6"],
      ["Dark Charizard", "base5-4"],
      ["ネクロズマ あかつきのつばさ", "ja:SM5p-021"],
      ["ポワルン たいようのすがた", "ja:MC-102"],
      ["ロケット団のミュウツーex", "ja:M2a-063"],
      ["ペパーのノノクラゲ", "sv10-109"],
      ["ガラル ニャース", "ja:S1a-1"],
      ["やさしいウインディ", "ja:neo4-1"],
    ];
    const sql = await q<{ f: string | null }>(
      `select card_own_form(n, i) f from unnest($1::text[], $2::text[]) with ordinality as t(n, i, o) order by o`,
      [names.map((x) => x[0]), names.map((x) => x[1])],
    );
    expect(sql.map((r) => r.f)).toEqual(names.map(([n, i]) => ownFormOf(n, i)));
  });

  it("catalog_card_form agrees with formOf on every catalog card: Trainer cards, inheritance, ja", async () => {
    const sql = await q<{ i: string; f: string | null }>(
      `select tcgdex_id i, catalog_card_form(tcgdex_id) f from catalog_card order by tcgdex_id`,
    );
    const byId = new Map(CATALOG.map((c) => [c.tcgdexId, c]));
    expect(sql.map((r) => [r.i, r.f])).toEqual(
      sql.map((r) => [r.i, formOf(byId.get(r.i)!, CATALOG)]),
    );
    // The cases that matter, by name.
    const f = new Map(sql.map((r) => [r.i, r.f]));
    expect(f.get("x-863")).toBe("region:galarian");
    expect(f.get("x-862")).toBe("region:galarian");
    expect(f.get("me01-114")).toBeNull();
    expect(f.get("dp5-3")).toBeNull();
    expect(f.get("ja:MC-080")).toBeNull();
    expect(f.get("ja:SV9a-048")).toBe("trainer:ペパー");
  });
});

/* ------------------------------------------ 2. her lines ------------------------------------------ */

/** Her shapes, by number: what each holds or chases. */
async function herLines(): Promise<void> {
  await line(1, 948, [{ holds: "sv03-118" }, { holds: "sv09-089" }]); // plain
  await line(2, 948, [{ chases: "sv10-109" }, { holds: "sv10-110" }]); // her 206bfa6a: Arven's
  await line(3, 96, [{ holds: "base1-49" }, { holds: "gym2-56" }]); // her 4b1cace4 shape: plain Basic, trainer's Hypno
  await line(4, 25, [{ holds: "base1-58" }, { chases: "sm4-31" }]); // a Pikachu under an Alolan Raichu she chases
  await line(5, 948, [null, null]); // nothing known
  await line(6, 948, [{ target: "sv10-109" }, { holds: "sv09-089" }]); // an engine's leftover target is not hers
  await line(7, 948, [{ holds: "ja:SV9a-047" }, null]); // Japanese Arven's
  await line(8, 4, [{ holds: "sv03-026" }, { holds: "base5-32" }]); // a Charmander under a Dark Charmeleon
  await line(9, 52, [{ holds: "swsh12.5-084" }, { holds: "sm1-79" }]); // two forms: the most evolved names it
}
const HER_FORMS = {
  [LINE(1)]: "plain",
  [LINE(2)]: "trainer:arven",
  [LINE(3)]: "trainer:sabrina",
  [LINE(4)]: "region:alolan",
  [LINE(5)]: "plain",
  [LINE(6)]: "plain",
  [LINE(7)]: "trainer:ペパー",
  [LINE(8)]: "dark",
  [LINE(9)]: "region:alolan",
};

const forms = async (schema = "public") =>
  Object.fromEntries(
    (
      await q<{ id: string; form: string | null }>(
        `select id, form from ${schema}.evolution_line order by id`,
      )
    ).map((r) => [r.id, r.form]),
  );

const MIGRATION = () =>
  readFileSync(path.join(process.cwd(), "supabase", "migrations", "0038_line_form.sql"), "utf8");

/**
 * A restore, as restore.sql makes one: in ONE transaction, the snapshot's lines (the columns it has: a baseline taken
 * before 0038 has no form), then its copies with their slot held back, its slots, and the slot pointers.
 */
async function restoreFrom(
  schema: string,
  opts: { replica?: boolean } = {},
): Promise<Record<string, unknown>> {
  await asSuperuser(db);
  const cols = async (t: string) =>
    (
      await db.query<{ c: string }>(
        `select string_agg(quote_ident(b.column_name), ', ' order by b.ordinal_position) c
           from information_schema.columns b
           join information_schema.columns p
             on p.table_schema = 'public' and p.table_name = $2 and p.column_name = b.column_name
          where b.table_schema = $1 and b.table_name = $2`,
        [schema, t],
      )
    ).rows[0].c;
  const [lc, cc, sc] = [await cols("evolution_line"), await cols("copy"), await cols("line_slot")];
  const copySel = cc.replace(/\bline_slot_id\b/, "null::uuid");
  await db.exec(`begin;
    ${opts.replica ? "set local session_replication_role = replica;" : ""}
    update copy set line_slot_id = null where line_slot_id is not null;
    delete from line_slot where true;
    delete from copy where true;
    delete from evolution_line where true;
    insert into evolution_line (${lc}) select ${lc} from ${schema}.evolution_line;
    insert into copy (${cc}) select ${copySel} from ${schema}.copy;
    insert into line_slot (${sc}) select ${sc} from ${schema}.line_slot;
    update copy c set line_slot_id = b.line_slot_id from ${schema}.copy b
     where b.id = c.id and b.line_slot_id is not null;`);
  const inside = await forms();
  await db.exec(`commit;`);
  return inside;
}

describe("0038 · every line she has is stamped from what it holds or chases", () => {
  let notices: string[];
  beforeEach(async () => {
    db = await freshRpcDb({ before: "0038" });
    await seedCatalog();
    await seedBinders(db, [{ id: KB, type: "general", name: "KB-001" }]);
    await herLines();
    // A labelled Testing baseline is a plain copy of these tables, taken before 0038 (CREATE TABLE AS: no keys).
    await asSuperuser(db);
    await db.exec(`create schema backup_t;
      create table backup_t.evolution_line as table public.evolution_line;
      create table backup_t.line_slot as table public.line_slot;
      create table backup_t.copy as table public.copy;`);
    notices = [];
    await db.exec(MIGRATION(), { onNotice: (n) => notices.push(n.message ?? "") });
    await db.query(`insert into supabase_migrations.schema_migrations (version) values ('0038')`);
  });

  it("each line reads its form; a plain card under a form card does not make the line plain", async () => {
    expect(await forms()).toEqual(HER_FORMS);
  });

  it("lines holding cards of more than one form are counted, never named (a public deploy log), and never refused", () => {
    // Lines 3 (plain + trainer), 4 (plain + Alolan, chased), 8 (plain + Dark), 9 (Galarian + Alolan). Not line 6: an
    // engine's leftover target is not hers.
    expect(notices).toContain(
      "0038: 4 line(s) hold cards of more than one form; each stamped by its most evolved card",
    );
    expect(notices.join(" ")).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-|trainer:|region:/);
  });

  it("a baseline taken before 0038, restored, is stamped when the restore commits: the same forms as the migration's", async () => {
    const inside = await restoreFrom("backup_t");
    // Before the commit no line has a form yet: its slots and copies come back after it.
    expect(Object.values(inside).every((f) => f === null)).toBe(true);
    expect(await forms()).toEqual(HER_FORMS);
  });

  it("with triggers skipped (session_replication_role = replica) a restored line stays unstamped, and the app reads its form all the same", async () => {
    await restoreFrom("backup_t", { replica: true });
    expect(Object.values(await forms()).every((f) => f === null)).toBe(true);
    await asOwner(db);
    const screen = await loadLineScreen(pgliteClient(db));
    const label = (id: string) => screen.lines.find((l) => l.lineId === id)?.speciesLabel;
    expect(label(LINE(2))).toBe("ARVEN'S TOEDSCOOL LINE");
    expect(label(LINE(1))).toBe("TOEDSCOOL LINE");
  });

  it("the migration ends with every line stamped, and says so if one is not", async () => {
    const sql = MIGRATION();
    const from = sql.indexOf("\n-- >>> 0038 NO NULLS");
    const to = sql.indexOf("\n-- <<< 0038 NO NULLS");
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const check = sql.slice(from, to);
    await asSuperuser(db);
    await db.exec(check); // every line stamped: passes
    await db.exec(`begin; set local session_replication_role = replica;
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
        values ('${LINE(99)}', '${OWNER}', 948, 'orange', '${KB}', 'back', 'open');
      commit;`);
    await expect(db.exec(check)).rejects.toThrow(/0038: 1 line\(s\) left without a form/);
  });
});

/* ------------------------------------------ 3. writers ------------------------------------------ */

describe("0038 · insert_line writes the line's form, and a line written without one is stamped at commit", () => {
  beforeEach(async () => {
    db = await freshRpcDb();
    await seedCatalog();
    await seedBinders(db, [{ id: KB, type: "general", name: "KB-001" }]);
    await asOwner(db);
  });

  const insertLine = (n: number, form?: string): WriteOp => ({
    op: "insert_line",
    id: LINE(n),
    root_dex_id: 948,
    color_band: "orange",
    binder_id: KB,
    half: "back",
    status: "open",
    ...(form !== undefined ? { form } : {}),
  });

  it("stores the form it is given", async () => {
    await applyOps(db, { ops: [insertLine(1, "trainer:arven"), insertLine(2, "plain")] });
    expect(await forms()).toEqual({ [LINE(1)]: "trainer:arven", [LINE(2)]: "plain" });
  });

  it("an older writer that sends none: its line is stamped from the cards the same write put in it", async () => {
    await q(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
         values ($1, $2, 'sv10-110', 'shelved', $3, 'back', 'orange')`,
      [COPY(3, 1), OWNER, KB],
    );
    await asOwner(db);
    await applyOps(db, {
      ops: [
        insertLine(3),
        {
          op: "insert_slot",
          id: SLOT(3, 0),
          line_id: LINE(3),
          stage_index: 0,
          stage: "Basic",
          state: "placeholder",
          copy_id: null,
          target_catalog_card_id: null,
          note: null,
        },
        {
          op: "insert_slot",
          id: SLOT(3, 1),
          line_id: LINE(3),
          stage_index: 1,
          stage: "Stage1",
          state: "filled",
          copy_id: COPY(3, 1),
          target_catalog_card_id: "sv10-110",
          note: null,
        },
        { op: "update_copy", id: COPY(3, 1), patch: { line_slot_id: SLOT(3, 1) } },
      ],
    });
    expect(await forms()).toEqual({ [LINE(3)]: "trainer:arven" });
  });

  it("the stamp is a deferred constraint trigger that fires only for a line with no form", async () => {
    const [t] = await q<{ deferrable: boolean; deferred: boolean; def: string }>(
      `select tgdeferrable deferrable, tginitdeferred deferred, pg_get_triggerdef(oid) def
         from pg_trigger where tgname = 'evolution_line_stamp_form'`,
    );
    expect(t).toMatchObject({ deferrable: true, deferred: true });
    expect(t.def).toMatch(/AFTER INSERT ON public\.evolution_line/);
    expect(t.def).toMatch(/WHEN \(\(new\.form IS NULL\)\)/);
  });

  it("update_line changes a line's form (her ruling on a line), within the vocabulary", async () => {
    await applyOps(db, { ops: [insertLine(5, "plain")] });
    await applyOps(db, {
      ops: [{ op: "update_line", id: LINE(5), patch: { form: "trainer:team rocket" } }],
    });
    expect(await forms()).toEqual({ [LINE(5)]: "trainer:team rocket" });
    await expect(
      applyOps(db, { ops: [{ op: "update_line", id: LINE(5), patch: { form: "rocket" } }] }),
    ).rejects.toThrow(/evolution_line_form_known/);
    // A patch without the key leaves it alone.
    await applyOps(db, { ops: [{ op: "update_line", id: LINE(5), patch: { status: "open" } }] });
    expect(await forms()).toEqual({ [LINE(5)]: "trainer:team rocket" });
  });

  it("update_line never clears a form: nothing would stamp it again (the stamp is for an insert)", async () => {
    await applyOps(db, { ops: [insertLine(6, "region:alolan")] });
    await expect(
      applyOps(db, {
        ops: [
          {
            op: "update_line",
            id: LINE(6),
            patch: { form: null } as unknown as { form: string },
          },
        ],
      }),
    ).rejects.toThrow(/can be changed, not cleared/);
    expect(await forms()).toEqual({ [LINE(6)]: "region:alolan" });
  });

  it.each(["arven", "trainer:", "region:kantonian", ""])("refuses '%s'", async (form) => {
    await expect(applyOps(db, { ops: [insertLine(4, form)] })).rejects.toThrow(
      /evolution_line_form_known/,
    );
  });
});
