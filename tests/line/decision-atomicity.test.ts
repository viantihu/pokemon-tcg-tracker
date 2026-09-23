/**
 * UIL-095 — resolving a line decision lands WHOLE or not at all.
 *
 * `applyDecision` used to perform a SEQUENCE of separate writes: the line's status, then one update per slot
 * patch, then a read of the whole `wishlist_item` table, then a wishlist update or insert per slot, then the
 * `placement_decision` row. Any failure after the first left her decision half-applied — a line capped with
 * its slot unmarked, a slot re-pointed with no wishlist row, or every write landed and NO audit row, which
 * UIL-042 says is not optional. The same class UIL-014, UIL-023 and UIL-033 each made High.
 *
 * The CONTROL block below is the pre-fix shape, written out by hand and poisoned mid-sequence, so the
 * half-applied state is on the record rather than described — the pattern log-into-collection.test.ts
 * established for UIL-033. The real path is then poisoned the same way and writes nothing.
 *
 * Real Postgres (PGlite) with every migration applied, real RLS as the authenticated owner, the real
 * `apply_write_ops` RPC. The decision seeded is a genuine "ex-only-cap" from `deriveDecisions`, the same
 * fixture apply-decision-pick-wiring.test.ts uses, so this exercises production config and not a stub.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { applyDecision } from "@/lib/line";
import { asOwner, asSuperuser, freshRpcDb, OWNER, seedBinders } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const GEN = "b0000000-0000-0000-0000-0000000000c1";
const LINE = "10000000-0000-0000-0000-0000000000c1";
const SLOT = "50000000-0000-0000-0000-0000000000c1";
const EMBEREX_DEX = 9411;
const CHEAP_ID = "atomic-cheap";
const PRICEY_ID = "atomic-pricey";
const DECISION_ID = `${LINE}:ex-only-cap:0`;

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedBinders(db, [{ id: GEN, type: "general", name: "Binder 1" }]);
  for (const [id, price] of [
    [CHEAP_ID, 5.0],
    [PRICEY_ID, 50.0],
  ] as const) {
    await db.query(
      `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from, card_class, price_market)
         values ($1, 'Emberex', $2, $3, 'Basic', null, 'specialty', $4)`,
      [id, [EMBEREX_DEX], ["Fire"], price],
    );
  }
  await db.query(
    `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
       values ($1, $2, $3, 'red', $4, 'back', 'open')`,
    [LINE, OWNER, EMBEREX_DEX, GEN],
  );
  await db.query(
    `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, target_catalog_card_id)
       values ($1, $2, $3, 0, 'Basic', 'placeholder', null)`,
    [SLOT, OWNER, LINE],
  );
});
afterEach(async () => {
  await db.close();
});

/** Make any write to `wishlist_item` fail, wherever in the sequence it happens to sit. */
async function poisonWishlist(): Promise<void> {
  await db.exec(`
    create function poison_wishlist() returns trigger language plpgsql as $$
    begin
      raise exception 'poisoned wishlist';
    end $$;
    create trigger poison_wl before insert or update on wishlist_item
      for each row execute function poison_wishlist();
  `);
}

async function state() {
  await asSuperuser(db);
  const line = await db.query<{ status: string }>(
    `select status from evolution_line where id = '${LINE}'`,
  );
  const slot = await db.query<{ resolved_decision_kind: string | null }>(
    `select resolved_decision_kind from line_slot where id = '${SLOT}'`,
  );
  const wish = await db.query<{ n: number }>(`select count(*)::int n from wishlist_item`);
  const audit = await db.query<{ n: number }>(`select count(*)::int n from placement_decision`);
  await asOwner(db);
  return {
    lineStatus: line.rows[0].status,
    slotMark: slot.rows[0].resolved_decision_kind,
    wishlistRows: wish.rows[0].n,
    auditRows: audit.rows[0].n,
  };
}

describe("UIL-095 · CONTROL — the pre-fix SEQUENCE leaves a decision half-applied", () => {
  it("line capped and slot marked, but no wishlist row and NO audit row", async () => {
    // The old shape, written out: four awaited writes in order, each its own statement. This is not a
    // description of the bug, it is the bug, executed — so the state it leaves is on the record.
    await poisonWishlist();
    await asOwner(db);
    const client = pgliteClient(db);

    let failed: string | null = null;
    try {
      await client.from("evolution_line").update({ status: "capped" }).eq("id", LINE);
      await client
        .from("line_slot")
        .update({ resolved_decision_kind: "ex-only-cap" })
        .eq("id", SLOT);
      // Third write of four. Everything before it has already committed on its own.
      const { error } = await client.from("wishlist_item").insert({
        line_slot_id: SLOT,
        chosen_catalog_card_id: CHEAP_ID,
        alternate_catalog_card_ids: [PRICEY_ID],
        will_live_in_specialty: true,
      });
      if (error) throw error;
      await client.from("placement_decision").insert({
        decision: "line-cap-confirmed",
        reason: "never reached",
        resolved_by: "user",
      });
    } catch (e) {
      // The shim hands back PostgREST's error SHAPE, not an Error, so read its message rather than
      // stringifying an object — the same thing the repo layer's `errorMessage` does.
      failed = e instanceof Error ? e.message : ((e as { message?: string }).message ?? String(e));
    }

    expect(failed).toContain("poisoned wishlist");
    expect(await state()).toEqual({
      lineStatus: "capped", // already written
      slotMark: "ex-only-cap", // already written
      wishlistRows: 0, // the one that failed
      auditRows: 0, // never reached — UIL-042's row, silently absent
    });
  });
});

describe("UIL-095 · the real path is one transaction", () => {
  it("a poisoned wishlist write leaves NOTHING behind, and the error still names the cause", async () => {
    await poisonWishlist();
    await asOwner(db);

    await expect(
      applyDecision(pgliteClient(db), OWNER, DECISION_ID, "confirm-cap", PRICEY_ID),
    ).rejects.toThrow(/poisoned wishlist/);

    // Every fact the control block showed half-written is absent here.
    expect(await state()).toEqual({
      lineStatus: "open",
      slotMark: null,
      wishlistRows: 0,
      auditRows: 0,
    });
  });

  it("and when nothing is poisoned, every fact lands together", async () => {
    await asOwner(db);
    await applyDecision(pgliteClient(db), OWNER, DECISION_ID, "confirm-cap", PRICEY_ID);
    expect(await state()).toEqual({
      lineStatus: "capped",
      slotMark: "ex-only-cap",
      wishlistRows: 1,
      auditRows: 1,
    });
    // The audit row keeps its traceability columns — 0021 taught `insert_decision` to carry them, and
    // dropping them while "preserving behaviour" is exactly the erosion UIL-094 exists to stop.
    await asSuperuser(db);
    const audit = await db.query<{ line_id: string | null; line_slot_id: string | null }>(
      `select line_id, line_slot_id from placement_decision`,
    );
    expect(audit.rows[0]).toEqual({ line_id: LINE, line_slot_id: SLOT });
  });

  it("is ONE apply_write_ops call, ops in today's order (UIL-014)", async () => {
    // A change of transaction boundary, not of outcome: the order is the order the sequenced version wrote
    // in, so the audit trail reads the same.
    const seen: string[][] = [];
    const client = pgliteClient(db);
    const spy = {
      ...client,
      rpc: (fn: "apply_write_ops", args: { payload: unknown }) => {
        const payload = args.payload as { ops: { op: string }[] };
        seen.push(payload.ops.map((o) => o.op));
        return client.rpc(fn, args as Parameters<typeof client.rpc>[1]);
      },
    } as unknown as ReturnType<typeof pgliteClient>;

    await asOwner(db);
    await applyDecision(spy, OWNER, DECISION_ID, "confirm-cap", PRICEY_ID);

    expect(seen).toHaveLength(1); // ONE call, not four writes
    expect(seen[0]).toEqual([
      "update_line",
      "update_slot",
      "upsert_wishlist_for_slot",
      "insert_decision",
    ]);
  });
});

describe("UIL-095 · the two new ops", () => {
  const upsert = (chosen: string, alternates: string[]) => ({
    op: "upsert_wishlist_for_slot" as const,
    line_slot_id: SLOT,
    required_dex_id: EMBEREX_DEX,
    required_type: "Fire",
    required_stage: "Basic",
    chosen_catalog_card_id: chosen,
    alternate_catalog_card_ids: alternates,
    will_live_in_specialty: true,
    held_for_binder_id: null,
  });
  const run = (ops: unknown[]) =>
    db.query(`select apply_write_ops($1::jsonb)`, [JSON.stringify({ ops })]);

  async function rows() {
    await asSuperuser(db);
    const r = await db.query<{ chosen_catalog_card_id: string; resolved_at: string | null }>(
      `select chosen_catalog_card_id, resolved_at from wishlist_item order by created_at`,
    );
    await asOwner(db);
    return r.rows;
  }

  it("the upsert REFRESHES the open row rather than adding a second", async () => {
    // The old TypeScript read the whole table to decide update-vs-insert. Postgres decides from the row it
    // locks now, conflicting on 0021's partial unique index.
    await asOwner(db);
    await run([upsert(CHEAP_ID, [PRICEY_ID])]);
    await run([upsert(PRICEY_ID, [CHEAP_ID])]);
    expect(await rows()).toEqual([{ chosen_catalog_card_id: PRICEY_ID, resolved_at: null }]);
  });

  it("a RESOLVED row is never resurrected — a new open row is inserted beside it", async () => {
    // The index is partial (`where resolved_at is null`), so a resolved row does not participate in the
    // conflict. That is today's behaviour, and it keeps the history of what she was chasing before.
    await asOwner(db);
    await run([upsert(CHEAP_ID, [PRICEY_ID])]);
    await run([{ op: "resolve_wishlist_for_slot", line_slot_id: SLOT }]);
    await run([upsert(PRICEY_ID, [CHEAP_ID])]);
    const all = await rows();
    expect(all).toHaveLength(2);
    expect(all[0].resolved_at).not.toBeNull();
    expect(all[1]).toEqual({ chosen_catalog_card_id: PRICEY_ID, resolved_at: null });
  });

  it("resolving is idempotent, and a slot with no open row is a silent no-op", async () => {
    await asOwner(db);
    // No row at all: the contract `delete_copy` and the target-list ops already follow.
    await run([{ op: "resolve_wishlist_for_slot", line_slot_id: SLOT }]);
    await run([upsert(CHEAP_ID, [])]);
    await run([{ op: "resolve_wishlist_for_slot", line_slot_id: SLOT }]);
    const once = await rows();
    await run([{ op: "resolve_wishlist_for_slot", line_slot_id: SLOT }]);
    expect(await rows()).toEqual(once); // the second pass matches nothing
  });

  it("the partial index REFUSES a second open row for one slot, whatever writes it", async () => {
    // The invariant lib/line/write.ts assumed since M7 and nothing enforced until 0021: with two open rows,
    // the old `openBySlot` map silently picked whichever came last.
    await asOwner(db);
    await run([upsert(CHEAP_ID, [])]);
    await asSuperuser(db);
    await expect(
      db.query(
        `insert into wishlist_item (owner_id, line_slot_id, chosen_catalog_card_id)
           values ($1, $2, $3)`,
        [OWNER, SLOT, PRICEY_ID],
      ),
    ).rejects.toThrow(/wishlist_item_one_open_per_slot|duplicate key/i);
  });
});

/** An open wishlist row for the seeded slot, as another writer (the Haul Plan, Backfill) would leave it. */
async function seedOpenWish(over: { held_for_binder_id?: string | null } = {}) {
  await asSuperuser(db);
  await db.query(
    `insert into wishlist_item (owner_id, line_slot_id, required_dex_id, required_type, required_stage,
       chosen_catalog_card_id, alternate_catalog_card_ids, will_live_in_specialty, held_for_binder_id)
     values ($1, $2, $3, 'Fire', 'Basic', $4, '{}', true, $5)`,
    [OWNER, SLOT, EMBEREX_DEX, CHEAP_ID, over.held_for_binder_id ?? null],
  );
  await asOwner(db);
}
async function wishRows() {
  await asSuperuser(db);
  const r = await db.query<{
    resolved_at: string | null;
    held_for_binder_id: string | null;
    required_dex_id: number | null;
    required_type: string | null;
    required_stage: string | null;
    chosen_catalog_card_id: string | null;
  }>(
    `select resolved_at, held_for_binder_id, required_dex_id, required_type, required_stage,
            chosen_catalog_card_id
       from wishlist_item where line_slot_id = $1 order by created_at`,
    [SLOT],
  );
  await asOwner(db);
  return r.rows;
}

describe("UIL-095 · a choice that STOPS chasing the card resolves its wish (QA's survivor)", () => {
  it("'cap without a wishlist' marks the slot's open wishlist row resolved, through applyDecision", async () => {
    // Removing the `resolve_wishlist_for_slot` op left the whole suite green: the SQL op was tested on its
    // own, but nothing drove a want-dropping choice through `applyDecision`. Product effect: she resolves a
    // decision to stop chasing a card, and it stays on her wishlist.
    await seedOpenWish();
    expect((await wishRows())[0].resolved_at).toBeNull();

    await applyDecision(pgliteClient(db), OWNER, DECISION_ID, "cap-no-wishlist");

    const rows = await wishRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].resolved_at).not.toBeNull(); // no longer on the hunt
  });
});

describe("UIL-095 · a refresh keeps what the decision does not decide (QA's second finding)", () => {
  it("re-choosing on a slot keeps the held_for_binder_id another writer set", async () => {
    // The Haul Plan (lib/plan/commit.ts) and Backfill (lib/backfill/plan.ts) write `held_for_binder_id`;
    // a line decision always sends null for it. A plain `= excluded` in the upsert wiped their value.
    await seedOpenWish({ held_for_binder_id: GEN });
    await applyDecision(pgliteClient(db), OWNER, DECISION_ID, "confirm-cap", PRICEY_ID);

    const rows = await wishRows();
    expect(rows).toHaveLength(1); // refreshed, not duplicated
    expect(rows[0].chosen_catalog_card_id).toBe(PRICEY_ID); // what she decided, overwritten
    expect(rows[0].held_for_binder_id).toBe(GEN); // what she did not, kept
    expect(rows[0].required_dex_id).toBe(EMBEREX_DEX);
  });

  it("the SQL keeps every column the caller leaves null, and overwrites what it supplies", async () => {
    // Pinned on the op itself too, so the rule does not depend on what one caller happens to send.
    await seedOpenWish({ held_for_binder_id: GEN });
    await asOwner(db);
    await db.query(`select apply_write_ops($1::jsonb)`, [
      JSON.stringify({
        ops: [
          {
            op: "upsert_wishlist_for_slot",
            line_slot_id: SLOT,
            required_dex_id: null,
            required_type: null,
            required_stage: null,
            chosen_catalog_card_id: PRICEY_ID,
            alternate_catalog_card_ids: [],
            will_live_in_specialty: false,
            held_for_binder_id: null,
          },
        ],
      }),
    ]);
    const [row] = await wishRows();
    expect(row.held_for_binder_id).toBe(GEN);
    expect(row.required_dex_id).toBe(EMBEREX_DEX); // Lookup matches a wish on species: wiping it un-wishes
    // All five columns the caller left null, each against the NON-null value `seedOpenWish` stored — so a
    // revert of any one coalesce fails here (QA: two of the five were unasserted).
    expect(row.required_type).toBe("Fire");
    expect(row.required_stage).toBe("Basic");
    expect(row.chosen_catalog_card_id).toBe(PRICEY_ID);
  });
});

/** Just the RPC definition from a migration file, for the composition claim below. */
function migrationFn(file: string): string {
  const sql = readFileSync(path.join(process.cwd(), "supabase", "migrations", file), "utf8");
  const at = sql.indexOf("\ncreate or replace function apply_write_ops(payload jsonb)");
  expect(at).toBeGreaterThan(0);
  return sql.slice(at);
}

describe("UIL-095 · migration 0021 composes on 0020", () => {
  it("is 0020's function plus the two new branches and ONE modified one, and nothing else", () => {
    /**
     * The chain's usual claim is "verbatim plus one branch", and it is NOT true of this file: 0021 also edits
     * the inherited `insert_decision` branch to carry `line_id`/`line_slot_id`, without which moving that
     * write inside the transaction would have silently dropped them. So the narrower true claim is asserted
     * instead — 0020's body, with its `insert_decision` branch swapped for this one, plus the two additions.
     * A re-issue that quietly lost an earlier branch would otherwise fail no test anywhere near itself.
     */
    const base = migrationFn("0020_removed_presence.sql");
    const mine = migrationFn("0021_wishlist_slot_ops.sql");

    const cut = (text: string, from: string, to: string) => {
      const a = text.indexOf(from);
      const b = text.indexOf(to, a);
      expect(a).toBeGreaterThan(0);
      expect(b).toBeGreaterThan(a);
      return { before: text.slice(0, a), branch: text.slice(a, b), after: text.slice(b) };
    };

    // 1. Remove 0021's two new branches.
    const added = cut(mine, "      -- NEW in 0021", "      else\n");
    const withoutAdditions = added.before + added.after;
    expect(added.branch).toContain("when 'resolve_wishlist_for_slot' then");
    expect(added.branch).toContain("when 'upsert_wishlist_for_slot' then");

    // 2. Swap 0020's insert_decision branch for 0021's, then the two must be identical.
    const oldDecision = cut(
      base,
      "      when 'insert_decision' then",
      "      when 'insert_presence_group'",
    );
    const newDecision = cut(
      withoutAdditions,
      "      -- MODIFIED in 0021",
      "      when 'insert_presence_group'",
    );
    expect(oldDecision.before + newDecision.branch + oldDecision.after).toBe(withoutAdditions);
    expect(newDecision.branch).toContain("line_slot_id");

    // 3. Every inherited branch is still there.
    for (const op of [
      "remember_removed_presence",
      "forget_removed_presence",
      "set_collection_binders",
      "insert_catalog_stand_in",
      "delete_set_alias",
      "union_collection_targets",
      "subtract_collection_targets",
    ]) {
      expect(mine).toContain(`when '${op}' then`);
    }
  });
});
