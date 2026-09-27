/**
 * UIL-061 (QA on #396): Lookup's movable copies, built by the REAL `lookupAnswer` on PGlite, say which line a move
 * leaves one short. The sheet's own tests feed `leaves` in directly; this proves the server model produces it: a
 * copy that fills a line slot carries the line (named as the Lines page names it) and the stage, and a front-half
 * copy carries nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { DbClient } from "@/lib/repo";
import { lookupAnswer } from "@/app/(ui)/look/actions";
import { asOwner, asSuperuser, freshRpcDb, OWNER, seedBinders } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

type Ctx = { db: DbClient; ownerId: string };
let ownerContext: () => Promise<Ctx> = async () => {
  throw new Error("test did not set an owner context");
};
vi.mock("@/lib/plan/session", () => ({
  getOwnerContext: () => ownerContext(),
  SEEDED_OWNER_ID: "00000000-0000-0000-0000-000000000001",
}));

const KB1 = "1c000000-0000-0000-0000-0000000001b1";
const LINE = "10000000-0000-0000-0000-0000000001a1";
const S_BASIC = "50000000-0000-0000-0000-0000000001a0";
const S_STAGE1 = "50000000-0000-0000-0000-0000000001a1";
const IN_LINE = "c0000000-0000-0000-0000-0000000001a1";
const FRONT = "c0000000-0000-0000-0000-0000000001a2";

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedBinders(db, [{ id: KB1, type: "general", name: "KB-001" }]);
  await db.exec(`
    insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id, set_card_count_official, dex_id, types, stage, evolve_from)
      values ('sv03-026', 'Charmander', 'sv03', 'Obsidian Flames', '026', 197, '{4}', '{Fire}', 'Basic', null),
             ('sv03-027', 'Charmeleon', 'sv03', 'Obsidian Flames', '027', 197, '{5}', '{Fire}', 'Stage1', 'Charmander');
    insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band) values
      ('${IN_LINE}', '${OWNER}', 'sv03-027', 'normal', 'shelved', '${KB1}', 'back', 'red'),
      ('${FRONT}', '${OWNER}', 'sv03-027', 'normal', 'shelved', '${KB1}', 'front', 'red');
    insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
      values ('${LINE}', '${OWNER}', 4, 'red', '${KB1}', 'back', 'open');
    insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id, target_catalog_card_id) values
      ('${S_BASIC}', '${OWNER}', '${LINE}', 0, 'Basic', 'placeholder', null, 'sv03-026'),
      ('${S_STAGE1}', '${OWNER}', '${LINE}', 1, 'Stage1', 'filled', '${IN_LINE}', 'sv03-027');
    update copy set line_slot_id = '${S_STAGE1}' where id = '${IN_LINE}';
  `);
  await asOwner(db);
  ownerContext = async () => ({ db: pgliteClient(db), ownerId: OWNER });
});
afterEach(async () => {
  await db.close();
});

describe("UIL-061 · Lookup's copies say which line a move leaves one short", () => {
  it("the copy filling the Stage 1 slot names its line and stage; the front-half copy names none", async () => {
    const res = await lookupAnswer("sv03-027");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const byId = new Map(res.copies.map((c) => [c.copyId, c]));
    expect(byId.get(IN_LINE)?.leaves).toEqual({ lineName: "CHARMANDER LINE", stage: "Stage 1" });
    expect(byId.get(FRONT)?.leaves).toBeUndefined();
  });

  it("a copy whose pointer the slot does not agree with names none (UIL-087)", async () => {
    await asSuperuser(db);
    await db.query(`update copy set line_slot_id = $1 where id = $2`, [S_STAGE1, FRONT]);
    await asOwner(db);
    const res = await lookupAnswer("sv03-027");
    if (!res.ok) throw new Error(res.error);
    expect(res.copies.find((c) => c.copyId === FRONT)?.leaves).toBeUndefined();
  });
});
