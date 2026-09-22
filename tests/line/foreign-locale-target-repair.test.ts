/**
 * Migration 0019 — release placeholder targets that name a card from the other regional variant than the
 * line they sit in (UIL-090's data half).
 *
 * Measured on Testing 2026-09-22: 22 of 60 `line_slot` rows carry a `ja:` target while every slotted copy
 * is English, so 22 English lines are chasing Japanese cards. The code fix alone does not heal them:
 * `lib/line/load.ts` reads `const chosen = targetCc ?? alt[0]`, so a STORED target outranks the freshly
 * ranked alternates and those rows would keep displaying the Japanese card.
 *
 * It RELEASES rather than re-targets, which is 0010's precedent: re-pointing would need the ranking rule
 * re-implemented in SQL, a second definition of a rule that lives in TypeScript. After release the slot
 * shows the locale-correct cheapest printing from `altOptions`, computed at load, so nothing reads blank.
 *
 * The migration runs as part of `freshRpcDb()`, so these cases seed the BROKEN shape and then assert what
 * a fresh apply leaves — the same way the other migration tests work.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { OWNER, freshRpcDb, seedBinders } from "../support/pglite-rpc";

const SQL = readFileSync(
  path.join(process.cwd(), "supabase", "migrations", "0019_release_foreign_locale_targets.sql"),
  "utf8",
);

const KB = "b0000000-0000-0000-0000-00000000f101";
const ROOT_DEX = 9481;
const S1_DEX = 9482;
const EN_LINE = "10000000-0000-0000-0000-00000000f101";
const JA_LINE = "10000000-0000-0000-0000-00000000f102";
const BARE_LINE = "10000000-0000-0000-0000-00000000f103";
const EN_COPY = "c0000000-0000-0000-0000-00000000f101";
const JA_COPY = "c0000000-0000-0000-0000-00000000f102";

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedBinders(db, [{ id: KB, type: "general", name: "KB-002" }]);
  for (const [id, name, dex, locale] of [
    ["sv09-088", "Toedscool", ROOT_DEX, "en"],
    ["sv09-089", "Toedscruel", S1_DEX, "en"],
    ["ja:SV9-088", "ノノクラゲ", ROOT_DEX, "ja"],
    ["ja:SV9-089", "ノノクラゲex", S1_DEX, "ja"],
  ] as const) {
    await db.query(
      `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, card_class, locale)
         values ($1, $2, $3, '{Fighting}', 'Basic', 'standard', $4)`,
      [id, name, [dex], locale],
    );
  }
  await db.query(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
       values ($1, $2, 'sv09-088', 'shelved', $3, 'back', 'orange'),
              ($4, $2, 'ja:SV9-088', 'shelved', $3, 'back', 'orange')`,
    [EN_COPY, OWNER, KB, JA_COPY],
  );
});
afterEach(async () => {
  await db.close();
});

/** Re-run just the repair, as a second apply would — it must be idempotent. */
const runRepair = () => db.exec(SQL);

async function targets() {
  const r = await db.query<{ id: string; target_catalog_card_id: string | null }>(
    `select id, target_catalog_card_id from line_slot order by id`,
  );
  return Object.fromEntries(r.rows.map((x) => [x.id, x.target_catalog_card_id]));
}

/** An EN line (stage 0 filled by an English copy) whose stage 1 placeholder targets a JA card. */
async function seedEnLineWithJaTarget() {
  await db.exec(`
    insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
      values ('${EN_LINE}', '${OWNER}', ${ROOT_DEX}, 'orange', '${KB}', 'back', 'open');
    insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
      values ('50000000-0000-0000-0000-0000000000e0', '${OWNER}', '${EN_LINE}', 0, 'Basic', 'filled', '${EN_COPY}');
    insert into line_slot (id, owner_id, line_id, stage_index, stage, state, target_catalog_card_id)
      values ('50000000-0000-0000-0000-0000000000e1', '${OWNER}', '${EN_LINE}', 1, 'Stage1', 'placeholder', 'ja:SV9-089');
    update copy set line_slot_id = '50000000-0000-0000-0000-0000000000e0' where id = '${EN_COPY}';
  `);
}

describe("0019 · releases a foreign-locale target", () => {
  it("nulls the ja target inside an English line, and leaves the filled slot alone", async () => {
    await seedEnLineWithJaTarget();
    // The broken shape, as it exists on Testing.
    expect((await targets())["50000000-0000-0000-0000-0000000000e1"]).toBe("ja:SV9-089");
    await runRepair();
    expect((await targets())["50000000-0000-0000-0000-0000000000e1"]).toBeNull();
    // The line and its filled slot are untouched — this releases a target, it does not unfill anything.
    const filled = await db.query<{ state: string; copy_id: string | null }>(
      `select state, copy_id from line_slot where id = '50000000-0000-0000-0000-0000000000e0'`,
    );
    expect(filled.rows[0]).toEqual({ state: "filled", copy_id: EN_COPY });
  });

  it("is SYMMETRIC: an English target inside a Japanese line goes too", async () => {
    await db.exec(`
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
        values ('${JA_LINE}', '${OWNER}', ${ROOT_DEX}, 'orange', '${KB}', 'back', 'open');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
        values ('50000000-0000-0000-0000-0000000000a0', '${OWNER}', '${JA_LINE}', 0, 'Basic', 'filled', '${JA_COPY}');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, target_catalog_card_id)
        values ('50000000-0000-0000-0000-0000000000a1', '${OWNER}', '${JA_LINE}', 1, 'Stage1', 'placeholder', 'sv09-089');
      update copy set line_slot_id = '50000000-0000-0000-0000-0000000000a0' where id = '${JA_COPY}';
    `);
    await runRepair();
    expect((await targets())["50000000-0000-0000-0000-0000000000a1"]).toBeNull();
  });

  it("KEEPS a target of the line's own locale", async () => {
    await db.exec(`
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
        values ('${EN_LINE}', '${OWNER}', ${ROOT_DEX}, 'orange', '${KB}', 'back', 'open');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
        values ('50000000-0000-0000-0000-0000000000e0', '${OWNER}', '${EN_LINE}', 0, 'Basic', 'filled', '${EN_COPY}');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, target_catalog_card_id)
        values ('50000000-0000-0000-0000-0000000000e1', '${OWNER}', '${EN_LINE}', 1, 'Stage1', 'placeholder', 'sv09-089');
      update copy set line_slot_id = '50000000-0000-0000-0000-0000000000e0' where id = '${EN_COPY}';
    `);
    await runRepair();
    expect((await targets())["50000000-0000-0000-0000-0000000000e1"]).toBe("sv09-089");
  });

  it("LEAVES ALONE a line with no filled copy — no evidence of its locale, so no change", async () => {
    await db.exec(`
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
        values ('${BARE_LINE}', '${OWNER}', ${ROOT_DEX}, 'orange', '${KB}', 'back', 'open');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, target_catalog_card_id)
        values ('50000000-0000-0000-0000-0000000000b0', '${OWNER}', '${BARE_LINE}', 0, 'Basic', 'placeholder', 'ja:SV9-088'),
               ('50000000-0000-0000-0000-0000000000b1', '${OWNER}', '${BARE_LINE}', 1, 'Stage1', 'placeholder', 'sv09-089');
    `);
    await runRepair();
    const t = await targets();
    expect(t["50000000-0000-0000-0000-0000000000b0"]).toBe("ja:SV9-088");
    expect(t["50000000-0000-0000-0000-0000000000b1"]).toBe("sv09-089");
  });

  it("derives from the lowest FILLED COPY, not the lowest slot — so a foreign target cannot invert it", async () => {
    // Stage 0 is a placeholder wrongly targeting a Japanese card; stage 1 holds an ENGLISH copy. A repair
    // that read "the lowest slot's card" would call this line Japanese and release the English target at
    // stage 2 instead of the Japanese one at stage 0. This is the same precedence `lineLocaleOf` uses.
    await db.exec(`
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
        values ('${EN_LINE}', '${OWNER}', ${ROOT_DEX}, 'orange', '${KB}', 'back', 'open');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, target_catalog_card_id)
        values ('50000000-0000-0000-0000-0000000000c0', '${OWNER}', '${EN_LINE}', 0, 'Basic', 'placeholder', 'ja:SV9-088');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
        values ('50000000-0000-0000-0000-0000000000c1', '${OWNER}', '${EN_LINE}', 1, 'Stage1', 'filled', '${EN_COPY}');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, target_catalog_card_id)
        values ('50000000-0000-0000-0000-0000000000c2', '${OWNER}', '${EN_LINE}', 2, 'Stage2', 'placeholder', 'sv09-089');
      update copy set line_slot_id = '50000000-0000-0000-0000-0000000000c1' where id = '${EN_COPY}';
    `);
    await runRepair();
    const t = await targets();
    expect(t["50000000-0000-0000-0000-0000000000c0"]).toBeNull(); // the Japanese one released
    expect(t["50000000-0000-0000-0000-0000000000c2"]).toBe("sv09-089"); // the English one kept
  });

  it("an IN-HAUL Japanese copy does not make an English line Japanese (UIL-088 + 0018 ordering)", async () => {
    // 0018 now ships ahead of this file, so a fresh apply runs 0018 then 0019 and the `copy` table can
    // carry `role = 'haul'` rows by the time this repair runs. A haul copy is placed nowhere, so it holds
    // no slot — and 0018's rule (e) refuses to label any copy a slot NAMES as haul, so the two migrations
    // cannot disagree about one. It therefore cannot reach this repair's "filled copies first" derivation,
    // which reads copies through `line_slot.copy_id`. Pinned because the ordering is what makes it true.
    await seedEnLineWithJaTarget();
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band, line_slot_id)
         values ($1, $2, 'ja:SV9-089', 'haul', null, null, null, null)`,
      ["c0000000-0000-0000-0000-00000000f103", OWNER],
    );
    await runRepair();
    const t = await targets();
    // Still released: the line's locale came from its FILLED English copy, not from the loose ja copy.
    expect(t["50000000-0000-0000-0000-0000000000e1"]).toBeNull();
    const roles = await db.query<{ role: string }>(
      `select role from copy where id = 'c0000000-0000-0000-0000-00000000f103'`,
    );
    expect(roles.rows[0].role).toBe("haul"); // and 0019 did not touch the copy either
  });

  it("is IDEMPOTENT: a second apply changes nothing", async () => {
    await seedEnLineWithJaTarget();
    await runRepair();
    const after = await targets();
    await runRepair();
    expect(await targets()).toEqual(after);
  });

  it("is safe with no lines at all (Production at cutover)", async () => {
    await runRepair();
    expect(await targets()).toEqual({});
  });
});
