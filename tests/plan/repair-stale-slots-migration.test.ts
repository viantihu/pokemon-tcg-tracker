/**
 * Migration 0010 — the one-time repair for UIL-062's stale filled line slots.
 *
 * Runs the migration's REAL SQL, read off disk, against a fresh database that has had the whole ordered
 * migration chain applied. Three things need to be true and only the first is obvious:
 *
 *   1. it releases a slot whose copy no longer points back (the 5 rows measured on Testing);
 *   2. it leaves a CORRECTLY filled slot completely alone — an over-broad predicate here would silently
 *      empty every line in her collection, which is far worse than the bug being repaired;
 *   3. it re-runs to no further effect and is a no-op on an empty table, because Production's
 *      `line_slot` is empty at cutover and the migration has to apply there too.
 *
 * It deliberately does NOT re-link the 8 shelved back-half copies with a null pointer (her Dragonair
 * shape, UIL-063). Measurement found that none of them has an intended placeholder slot to attach to, so
 * a migration choosing one would be inventing her placement decisions. One test pins that they are left
 * untouched, so the omission is a recorded decision rather than something a later edit quietly "fixes".
 *
 * Note that `freshRpcDb` applies 0010 as part of the chain, so every other suite is already an
 * incidental check that it breaks nothing on a clean database. Here it is re-executed explicitly, which
 * is also what proves idempotency.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { freshRpcDb, OWNER, seedBinders, seedCatalogCards } from "../support/pglite-rpc";

const B1 = "1c000000-0000-0000-0000-0000000000b1";
const LINE = "11111111-0000-0000-0000-0000000000a1";
const CARD = "sv03-026";

const REPAIR = readFileSync(
  path.join(process.cwd(), "supabase", "migrations", "0010_release_stale_line_slots.sql"),
  "utf8",
);

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedCatalogCards(db, [CARD]);
  await seedBinders(db, [{ id: B1, type: "general" }]);
  await db.query(
    `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id)
     values ($1,$2,4,'red',$3)`,
    [LINE, OWNER, B1],
  );
});
afterEach(async () => {
  await db.close();
});

async function addSlot(id: string, stage: number, state: string, copyId: string | null) {
  await db.query(
    `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
     values ($1,$2,$3,$4,'Basic',$5,$6)`,
    [id, OWNER, LINE, stage, state, copyId],
  );
}

async function addCopy(id: string, slotId: string | null, half = "back") {
  await db.query(
    `insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half,
                       color_band, line_slot_id, acquired_at)
     values ($1,$2,$3,'normal','shelved',$4,$5,'red',$6, now())`,
    [id, OWNER, CARD, B1, half, slotId],
  );
}

/**
 * Create a copy and a slot in FK-safe order, then optionally point the copy at a slot.
 *
 * `line_slot.copy_id` references `copy`, so the copy has to exist before the slot can name it — which
 * also means a stale slot can only ever name a copy that still exists. The pointer is set last because
 * that is the direction the real bug breaks.
 */
async function seedPair(opts: {
  copyId: string;
  slotId: string;
  stage?: number;
  slotState?: string;
  /** Where the COPY points afterwards: a slot id, or null for the broken case. */
  copyPointsAt: string | null;
  half?: string;
}) {
  await addCopy(opts.copyId, null, opts.half ?? "back");
  await addSlot(opts.slotId, opts.stage ?? 0, opts.slotState ?? "filled", opts.copyId);
  if (opts.copyPointsAt !== null) {
    await db.query(`update copy set line_slot_id = $1 where id = $2`, [
      opts.copyPointsAt,
      opts.copyId,
    ]);
  }
}

const slotState = async (id: string) =>
  (
    await db.query<{ state: string; copy_id: string | null }>(
      `select state, copy_id from line_slot where id = $1`,
      [id],
    )
  ).rows[0];

const S1 = "22222222-0000-0000-0000-0000000000b1";
const S2 = "22222222-0000-0000-0000-0000000000b2";
const C1 = "c0000000-0000-0000-0000-00000000aa01";

describe("migration 0010 · releases exactly the stale slots", () => {
  it("reopens a filled slot whose copy no longer points back", async () => {
    // The copy moved on: the slot still names it, the copy no longer points back.
    await seedPair({ copyId: C1, slotId: S1, copyPointsAt: null });
    await db.exec(REPAIR);
    expect(await slotState(S1)).toEqual({ state: "placeholder", copy_id: null });
  });

  it("reopens a slot whose copy now points at a DIFFERENT slot", async () => {
    await seedPair({ copyId: C1, slotId: S1, copyPointsAt: null });
    await addSlot(S2, 1, "placeholder", null);
    await db.query(`update copy set line_slot_id = $1 where id = $2`, [S2, C1]);
    await db.exec(REPAIR);
    expect(await slotState(S1)).toEqual({ state: "placeholder", copy_id: null });
    // The slot the copy actually points at is untouched.
    expect(await slotState(S2)).toEqual({ state: "placeholder", copy_id: null });
  });

  it("LEAVES A CORRECTLY FILLED SLOT ALONE — the predicate must not be over-broad", async () => {
    await seedPair({ copyId: C1, slotId: S1, copyPointsAt: S1 }); // both pointers agree
    await db.exec(REPAIR);
    // If this ever fails, the migration empties every line she owns.
    expect(await slotState(S1)).toEqual({ state: "filled", copy_id: C1 });
  });

  it("does not touch a shelved back-half copy with a null pointer (the Dragonair shape)", async () => {
    await addCopy(C1, null);
    await db.exec(REPAIR);
    const row = await db.query<{ line_slot_id: string | null; role: string; binder_half: string }>(
      `select line_slot_id, role, binder_half from copy where id = $1`,
      [C1],
    );
    // Deliberately unrepaired: nothing exists to attach it to, and choosing would invent a decision.
    expect(row.rows[0]).toEqual({ line_slot_id: null, role: "shelved", binder_half: "back" });
  });
});

describe("migration 0010 · safe to apply anywhere", () => {
  it("is a no-op on an empty line_slot table (Production at cutover)", async () => {
    await db.exec(REPAIR);
    const n = await db.query<{ n: number }>(`select count(*)::int as n from line_slot`);
    expect(n.rows[0].n).toBe(0);
  });

  it("is idempotent — a second run changes nothing further", async () => {
    await seedPair({ copyId: C1, slotId: S1, copyPointsAt: null });
    await db.exec(REPAIR);
    const afterFirst = await slotState(S1);
    await db.exec(REPAIR);
    expect(await slotState(S1)).toEqual(afterFirst);
  });

  it("leaves placeholder and block slots untouched whatever their state", async () => {
    await addSlot(S1, 0, "placeholder", null);
    await addSlot(S2, 1, "block", null);
    await db.exec(REPAIR);
    expect((await slotState(S1)).state).toBe("placeholder");
    expect((await slotState(S2)).state).toBe("block");
  });

  it("is applied after the schema it repairs, rather than at a fixed position", async () => {
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(path.join(process.cwd(), "supabase", "migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(files).toContain("0010_release_stale_line_slots.sql");
    // Deliberately NOT "sorts last". 0009's own test asserted that and broke the moment this file
    // existed; the requirement is that the repair runs after `line_slot` exists, not that nothing
    // follows it.
    expect(files.indexOf("0010_release_stale_line_slots.sql")).toBeGreaterThan(
      files.indexOf("0002_domain.sql"),
    );
  });
});
