/**
 * Migration 0018 — classify today's copies into her three states (UIL-088).
 *
 * Her model: SHELVED = placed in a binder or a bulk box; BULK = placed in a bulk box; IN HAUL = imported
 * but not placed anywhere, which is NOT bulk. The app wrote that third state as `role = 'bulk'`, so "a card
 * she filed in a box" and "a card the app has never put anywhere" were one value — UIL-087's cause (a).
 *
 * The classification IS the predicate the app already used for its queue (`listUnplaced` plus
 * `loadPendingPlacements`'s decision check), which is why the migration and the running app cannot disagree
 * about which copies are in the haul. One case per rule (a)–(f) plus both sides of the slot link, then the
 * conservation law the Senior BA verifies around the merge, idempotence and an empty table.
 *
 * Two of these are pinned to Testing's real data rather than to a tidy fixture, because the tidy version of
 * rule (a) hid a defect: rule (a) was documented as an ORDERING and never ran as an UPDATE, so Testing's
 * three UIL-087 leftovers (slotted, in a binder, decision row present, role still 'bulk') both survived
 * misclassified AND tripped rule (f)'s assertion, which would have failed the deploy on the one shape this
 * file exists to repair.
 *
 * `freshRpcDb()` applies every migration, so each case seeds the PRE-0018 shape and re-runs the file's
 * UPDATE to assert what it does — the same pattern as 0019's test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { OWNER, freshRpcDb, seedBinders } from "../support/pglite-rpc";

/** Just the classification UPDATE: the constraint and the assertion already ran in `freshRpcDb`. */
const CLASSIFY = (() => {
  const sql = readFileSync(
    path.join(process.cwd(), "supabase", "migrations", "0018_haul_copy_state.sql"),
    "utf8",
  );
  const at = sql.indexOf("update copy");
  expect(at).toBeGreaterThan(0);
  return sql.slice(at);
})();

/** Readable names for the fixture copies; the column is a uuid, so each maps to one. */
const ID = {
  slotted: "c0000000-0000-0000-0000-0000000000f1",
  blocked: "c0000000-0000-0000-0000-0000000000f2",
  shelved: "c0000000-0000-0000-0000-0000000000f3",
  boxed: "c0000000-0000-0000-0000-0000000000f4",
  waiting: "c0000000-0000-0000-0000-0000000000f5",
  odd: "c0000000-0000-0000-0000-0000000000f6",
  w1: "c0000000-0000-0000-0000-0000000000f7",
  w2: "c0000000-0000-0000-0000-0000000000f8",
  w3: "c0000000-0000-0000-0000-0000000000f9",
  asym: "c0000000-0000-0000-0000-0000000000fa",
} as const;

const KB = "b0000000-0000-0000-0000-00000000c001";
const LINE = "10000000-0000-0000-0000-00000000c001";
const SLOT = "50000000-0000-0000-0000-00000000c001";
const CARD = "sv03-026";

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedBinders(db, [{ id: KB, type: "general", name: "KB-001" }]);
  await db.query(
    `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, card_class)
       values ($1, 'Charmander', '{4}', '{Fire}', 'Basic', 'standard')`,
    [CARD],
  );
});
afterEach(async () => {
  await db.close();
});

/** Insert a copy in the PRE-0018 world, where "unplaced" was spelled `'bulk'`. */
async function copy(id: string, cols: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    id,
    owner_id: OWNER,
    catalog_card_id: CARD,
    role: "bulk",
    binder_id: null,
    binder_half: null,
    color_band: null,
    line_slot_id: null,
    ...cols,
  };
  const keys = Object.keys(base);
  await db.query(
    `insert into copy (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})`,
    keys.map((k) => base[k]),
  );
}
async function decisionFor(copyId: string) {
  await db.query(
    `insert into placement_decision (owner_id, copy_id, decision, reason, resolved_by)
       values ($1, $2, 'haul-place', 'routed', 'user')`,
    [OWNER, copyId],
  );
}
async function seedLineWithSlot() {
  await db.exec(`
    insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
      values ('${LINE}', '${OWNER}', 4, 'red', '${KB}', 'back', 'open');
    insert into line_slot (id, owner_id, line_id, stage_index, stage, state)
      values ('${SLOT}', '${OWNER}', '${LINE}', 0, 'Basic', 'placeholder');
  `);
}
/**
 * The ASYMMETRIC drift: the slot names the copy, the copy's own `line_slot_id` stays null. Nothing in the
 * schema ties the two halves together (0002: `line_slot.copy_id` and `copy.line_slot_id` are independent),
 * and UIL-062 and UIL-087 both shipped this. The copy must exist before the slot can reference it.
 */
async function seedSlotPointingAt(copyId: string) {
  await db.exec(`
    insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
      values ('${LINE}', '${OWNER}', 4, 'red', '${KB}', 'back', 'open');
    insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
      values ('${SLOT}', '${OWNER}', '${LINE}', 0, 'Basic', 'filled', '${copyId}');
  `);
}
async function roles() {
  const r = await db.query<{ id: string; role: string }>(`select id, role from copy order by id`);
  return Object.fromEntries(r.rows.map((x) => [x.id, x.role]));
}
async function countByRole() {
  const r = await db.query<{ role: string; n: number }>(
    `select role, count(*)::int n from copy group by role order by role`,
  );
  return Object.fromEntries(r.rows.map((x) => [x.role, x.n]));
}

describe("0018 · the classification, one case per rule", () => {
  it("(a) a copy holding a line slot is REPAIRED to shelved — the real UIL-087 leftover shape", async () => {
    // Testing carries 3 of these right now: the confirmed-pull write set slot, binder, half and band but
    // never the role, so the copy kept the import's 'bulk'. It is demonstrably placed — a line holds it —
    // so 0018 says so instead of asserting a state its own rule (a) denies. Runs FIRST, which is also what
    // stops rule (f)'s assertion from raising on exactly this shape.
    await seedLineWithSlot();
    await copy(ID.slotted, {
      line_slot_id: SLOT,
      binder_id: KB,
      binder_half: "back",
      color_band: "red",
    });
    await decisionFor(ID.slotted);
    await CLASSIFY_RUN(); // must not raise
    expect((await roles())[ID.slotted]).toBe("shelved");
  });

  it("(a) asked from the OTHER side of the link: a slot naming the copy leaves it bulk, never haul", async () => {
    // The two halves of the slot link can disagree, and this half is the one UIL-062/UIL-087 shipped. Such
    // a copy must not become 'haul' — a line is holding it, and 0019 derives that line's locale from it
    // through `line_slot.copy_id`. It is not 'shelved' either: no binder can be asserted for it. So it
    // stays 'bulk', and repairing it belongs to a migration with its own BEFORE read. Empty on Testing
    // today (the UIL-061 drift check's check B reads 0), so this clause is a guard, not a repair.
    await copy(ID.asym);
    await seedSlotPointingAt(ID.asym);
    await CLASSIFY_RUN();
    expect((await roles())[ID.asym]).toBe("bulk");
  });

  it("(b) a block copy is untouched — a block IS placed, it is a spacer in a binder", async () => {
    await copy(ID.blocked, { role: "block", binder_id: KB, binder_half: "back" });
    await CLASSIFY_RUN();
    expect((await roles())[ID.blocked]).toBe("block");
  });

  it("(c) a shelved copy is untouched", async () => {
    await copy(ID.shelved, {
      role: "shelved",
      binder_id: KB,
      binder_half: "front",
      color_band: "red",
    });
    await CLASSIFY_RUN();
    expect((await roles())[ID.shelved]).toBe("shelved");
  });

  it("(d) a bulk copy WITH a placement decision stays BULK — she or the cascade put it in the box", async () => {
    await copy(ID.boxed);
    await decisionFor(ID.boxed);
    await CLASSIFY_RUN();
    expect((await roles())[ID.boxed]).toBe("bulk");
  });

  it("(e) a bulk copy with NO decision becomes HAUL — imported, never placed", async () => {
    await copy(ID.waiting);
    await CLASSIFY_RUN();
    expect((await roles())[ID.waiting]).toBe("haul");
  });

  it("(f) a bulk copy in a binder while holding NO slot stops the deploy", async () => {
    // A placement nobody can explain: bulk clears the binder, so this row is not a state 0018 may guess at.
    // It raises rather than classifying. Note what this case does NOT prove: the `line_slot_id is null`
    // narrowing is equivalent to the un-narrowed form now that rule (a) runs first, so no fixture can pin
    // it. What raised on Testing was the FIRST cut of the file, where the un-narrowed assertion ran before
    // any repair and so fired on the three leftovers.
    await copy(ID.odd, { binder_id: KB, binder_half: "front", color_band: "red" });
    await expect(CLASSIFY_RUN()).rejects.toThrow(/carry a binder_id while holding no line slot/);
    expect((await roles())[ID.odd]).toBe("bulk"); // nothing invented a state for it
  });
});

describe("0018 · the conservation law the Senior BA verifies", () => {
  it("every row bulk LEAVES is accounted for as haul, bulk or the shelved it gained", async () => {
    // The law she can check from role counts alone, and the shape of the Testing read around the merge:
    //   bulk before  =  haul after  +  bulk after  +  (shelved after - shelved before)
    // On Testing that is 592 = 573 + 16 + 3. `block` and the `copy` total never move.
    await seedLineWithSlot();
    await copy(ID.w1);
    await copy(ID.w2);
    await copy(ID.w3);
    await copy(ID.boxed);
    await decisionFor(ID.boxed);
    await copy(ID.shelved, {
      role: "shelved",
      binder_id: KB,
      binder_half: "front",
      color_band: "red",
    });
    await copy(ID.blocked, { role: "block", binder_id: KB, binder_half: "back" });
    // The UIL-087 leftover, in its real shape: slotted, in a binder, with a decision row.
    await copy(ID.slotted, {
      line_slot_id: SLOT,
      binder_id: KB,
      binder_half: "back",
      color_band: "red",
    });
    await decisionFor(ID.slotted);

    const before = await countByRole();
    const totalBefore = Object.values(before).reduce((a, b) => a + b, 0);
    await CLASSIFY_RUN();
    const after = await countByRole();

    const shelvedGained = (after.shelved ?? 0) - (before.shelved ?? 0);
    expect((after.haul ?? 0) + (after.bulk ?? 0) + shelvedGained).toBe(before.bulk);
    expect(after.block ?? 0).toBe(before.block ?? 0);
    expect(Object.values(after).reduce((a, b) => a + b, 0)).toBe(totalBefore);
    // The split itself: three waiting copies become haul, the slotted leftover becomes shelved, and the
    // boxed one stays exactly where she put it.
    expect(after.haul).toBe(3);
    expect(after.bulk).toBe(1); // 'boxed' only
    expect(shelvedGained).toBe(1); // 'slotted', by rule (a)
  });

  it("is IDEMPOTENT: a second run moves nothing, because those rows are no longer bulk", async () => {
    await copy(ID.w1);
    await CLASSIFY_RUN();
    const after = await roles();
    await CLASSIFY_RUN();
    expect(await roles()).toEqual(after);
  });

  it("is safe with no copies at all (Production at cutover)", async () => {
    await CLASSIFY_RUN();
    expect(await roles()).toEqual({});
  });
});

/** Run the migration's classification UPDATE against the seeded pre-0018 shape. */
async function CLASSIFY_RUN() {
  await db.exec(CLASSIFY);
}
