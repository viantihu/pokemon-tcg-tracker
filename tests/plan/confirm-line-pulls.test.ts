/**
 * UIL-061 — starting a new line must not relocate cards she never agreed to move.
 *
 * Her words: "You cannot infer that a card will go somewhere and just put it there. In a haul, the user
 * must validate each and every single line."
 *
 * `generateSlots` fills a new line's stages from `ctx.owned` — her WHOLE collection, not the haul — and
 * `writeNewLine` wrote those relocations into the same transaction as the one card she clicked Done on.
 * So one Done could move an unbounded number of already-shelved cards, with no confirmation and, because
 * the commit loop writes one decision per incoming DRAFT card, no `placement_decision` row for any of
 * them. Unconfirmed AND untraceable: "why is this Charmander in the back half" had no answer anywhere.
 *
 * The blast radius is wider than a front-half pull, which is what these pin. `ownedAt` matches on
 * species + band with NO ROLE FILTER, and `writeNewLine` fired on `if (ownedCopyId)` without ever
 * reading `pullFrom`. So a matching copy in the BULK BOX, a BLOCK, a SPECIALTY binder, or ANOTHER
 * LINE'S SLOT was relocated too — and in the last case its old slot was left `filled` pointing at a copy
 * that had moved (UIL-062, measured as 5 stale slots on Testing).
 *
 * Run against the REAL `apply_write_ops` RPC on real Postgres (PGlite), and seeded with
 * `seedCatalogCardsFull` — the id-only seed leaves `set_id`/`local_id`/`artwork_group_id` null, which
 * makes `buildChain` and `ownedAt` unable to match anything, so a pull could not occur at all and every
 * assertion here would pass vacuously.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { EngineContext } from "@/lib/engine";
import {
  buildHaulCommitPayload,
  planFromDraft,
  type DraftItem,
  type PlanContext,
} from "@/lib/plan";
import type { Row } from "@/lib/repo";
import { CHARMANDER_SV03_026, CHARMELEON_SV03_027 } from "../engine/fixtures";
import {
  applyOps,
  asOwner,
  asSuperuser,
  freshRpcDb,
  OWNER,
  seedBinders,
  seedCatalogCardsFull,
} from "../support/pglite-rpc";

const B1 = "1c000000-0000-0000-0000-0000000000b1";
const SPEC = "1c000000-0000-0000-0000-00000000c5ec";
const OWNED = "c0000000-0000-0000-0000-00000000aa01";

const BANDS = [
  "red",
  "orange",
  "yellow",
  "olive",
  "green",
  "dark_blue",
  "light_blue",
  "purple",
  "pink",
  "white",
];
const TYPE_COLOR_MAP: Record<string, string> = {
  Fire: "red",
  Colorless: "white",
  Trainer: "white",
};
const CATALOG = [CHARMANDER_SV03_026, CHARMELEON_SV03_027];

/** Charmeleon comes in this haul; Charmander is already shelved in the front half. */
const INCOMING: DraftItem = {
  id: "d-charmeleon",
  tcgdexId: CHARMELEON_SV03_027.tcgdexId,
  variant: "normal",
};

function ownedRow(over: Partial<Row<"copy">> = {}): Row<"copy"> {
  return {
    id: OWNED,
    catalog_card_id: CHARMANDER_SV03_026.tcgdexId,
    variant: "normal",
    role: "shelved",
    binder_id: B1,
    binder_half: "front",
    color_band: "red",
    line_slot_id: null,
    ...over,
  } as unknown as Row<"copy">;
}

function makeContext(owned: Row<"copy">[]): PlanContext {
  const catalogById = new Map(CATALOG.map((c) => [c.tcgdexId, c]));
  const ctx: EngineContext = {
    typeColorMap: TYPE_COLOR_MAP,
    catalog: CATALOG,
    owned: owned.map((r) => ({
      id: r.id,
      card: catalogById.get(r.catalog_card_id)!,
      variant: (r.variant as "normal" | "holo") ?? "normal",
      role: (r.role as "shelved" | "bulk" | "block") ?? "shelved",
      binderId: r.binder_id,
      binderHalf: (r.binder_half as "front" | "back" | null) ?? null,
      colorBand: r.color_band,
      lineSlotId: r.line_slot_id,
    })),
    binders: [
      { id: B1, name: "Binder 1", type: "general", isActive: true },
      { id: SPEC, name: "Specialty A", type: "specialty", isActive: false },
    ],
    lines: [],
    collections: [],
    now: "2026-09-15T00:00:00.000Z",
  };
  return {
    ctx,
    catalogById,
    copyRowById: new Map(owned.map((c) => [c.id, c])),
    slotRowsByLine: new Map(),
    orderedBandKeys: BANDS,
    lookups: {
      binderNameById: new Map([
        [B1, "Binder 1"],
        [SPEC, "Specialty A"],
      ]),
      bandDisplayByKey: new Map(BANDS.map((b) => [b, b])),
      collectionNameById: new Map(),
      imageUrlByTcgdexId: new Map(),
    },
  };
}

/** Commit the incoming card, confirming the listed pulls (none by default). */
async function shelveIncoming(db: PGlite, owned: Row<"copy">[], confirmedPulls: string[] = []) {
  const pc = makeContext(owned);
  const { planned } = planFromDraft(pc, [INCOMING]);
  const built = buildHaulCommitPayload(
    pc,
    planned.map((p) => ({ ...p, confirmedPulls })),
    { source: "bulk-bin", draft: [INCOMING] },
  );
  await applyOps(db, built.payload);
  return built;
}

async function copyById(db: PGlite, id: string) {
  const r = await db.query<{
    role: string;
    binder_id: string | null;
    binder_half: string | null;
    color_band: string | null;
    line_slot_id: string | null;
  }>(`select role, binder_id, binder_half, color_band, line_slot_id from copy where id = $1`, [id]);
  return r.rows[0];
}

async function decisionsFor(db: PGlite, copyId: string) {
  const r = await db.query<{ decision: string; resolved_by: string; reason: string }>(
    `select decision, resolved_by, reason from placement_decision where copy_id = $1`,
    [copyId],
  );
  return r.rows;
}

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedCatalogCardsFull(db, CATALOG);
  await seedBinders(db, [
    { id: B1, type: "general" },
    { id: SPEC, type: "specialty" },
  ]);
});
afterEach(async () => {
  await db.close();
});

/** Insert the already-owned Charmander exactly as the DB holds it. */
async function seedOwned(over: Partial<Record<string, unknown>> = {}) {
  const row = { role: "shelved", binder_id: B1, binder_half: "front", color_band: "red", ...over };
  await db.query(
    `insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band, acquired_at)
     values ($1,$2,$3,'normal',$4,$5,$6,$7, now())`,
    [
      OWNED,
      OWNER,
      CHARMANDER_SV03_026.tcgdexId,
      row.role,
      row.binder_id,
      row.binder_half,
      row.color_band,
    ],
  );
}

describe("UIL-061 · without confirmation, nothing she owns moves", () => {
  it("leaves the shelved Charmander exactly where it was", async () => {
    await seedOwned();
    const before = await copyById(db, OWNED);
    await asOwner(db);
    await shelveIncoming(db, [ownedRow()]); // no confirmedPulls
    await asSuperuser(db);

    const after = await copyById(db, OWNED);
    // The whole complaint, as one assertion: a Done on a DIFFERENT card did not move this one.
    expect(after).toEqual(before);
    expect(after.line_slot_id).toBeNull();
    expect(after.binder_half).toBe("front");
  });

  it("still creates the line, with that stage left OPEN and labelled", async () => {
    await seedOwned();
    await asOwner(db);
    await shelveIncoming(db, [ownedRow()]);
    await asSuperuser(db);

    const lines = await db.query<{ n: number }>(`select count(*)::int as n from evolution_line`);
    expect(lines.rows[0].n).toBe(1);
    // The stage exists and is open — the line does not pretend to hold a card still in her binder.
    const slot = await db.query<{ state: string; copy_id: string | null; note: string | null }>(
      `select state, copy_id, note from line_slot where stage_index = 0`,
    );
    expect(slot.rows[0].state).toBe("placeholder");
    expect(slot.rows[0].copy_id).toBeNull();
    expect(slot.rows[0].note).toContain("not confirmed");
  });

  it("writes no decision row for a card it did not move", async () => {
    await seedOwned();
    await asOwner(db);
    await shelveIncoming(db, [ownedRow()]);
    await asSuperuser(db);
    expect(await decisionsFor(db, OWNED)).toHaveLength(0);
  });

  it("does not put a card she already OWNS on the wishlist", async () => {
    await seedOwned();
    await asOwner(db);
    await shelveIncoming(db, [ownedRow()]);
    await asSuperuser(db);
    const w = await db.query<{ required_dex_id: number }>(
      `select required_dex_id from wishlist_item`,
    );
    // Declining a pull is "keep it where it is", not "I need to buy one".
    expect(w.rows.map((r) => r.required_dex_id)).not.toContain(CHARMANDER_SV03_026.dexId[0]);
  });
});

describe("UIL-061 · with confirmation, it moves AND it is traceable", () => {
  it("relocates the copy into the line's back half", async () => {
    await seedOwned();
    await asOwner(db);
    await shelveIncoming(db, [ownedRow()], [OWNED]);
    await asSuperuser(db);

    const after = await copyById(db, OWNED);
    expect(after.binder_half).toBe("back");
    expect(after.color_band).toBe("red");
    expect(after.line_slot_id).not.toBeNull();
  });

  it("writes its OWN placement_decision, resolved_by user, naming where it came from", async () => {
    await seedOwned();
    await asOwner(db);
    await shelveIncoming(db, [ownedRow()], [OWNED]);
    await asSuperuser(db);

    const rows = await decisionsFor(db, OWNED);
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe("line-pull-confirmed");
    expect(rows[0].resolved_by).toBe("user");
    // "Why is this Charmander in the back half" has to be answerable from this row alone.
    expect(rows[0].reason).toContain("front");
  });
});

describe("UIL-061 · the blast radius was wider than a front-half pull", () => {
  it("does not silently drag a copy out of the BULK BOX either", async () => {
    await seedOwned({ role: "bulk", binder_id: null, binder_half: null, color_band: null });
    const before = await copyById(db, OWNED);
    await asOwner(db);
    await shelveIncoming(db, [
      ownedRow({ role: "bulk", binder_id: null, binder_half: null, color_band: null }),
    ]);
    await asSuperuser(db);
    // `ownedAt` has no role filter, and the old writer ignored `pullFrom` — so bulk was in scope too.
    expect(await copyById(db, OWNED)).toEqual(before);
  });

  it("releases the slot a confirmed pull VACATES, instead of leaving it filled (UIL-062)", async () => {
    // The copy already belongs to an older line's slot.
    const OLD_LINE = "11111111-0000-0000-0000-0000000000a1";
    const OLD_SLOT = "22222222-0000-0000-0000-0000000000b1";
    await db.query(
      `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id)
       values ($1,$2,4,'red',$3)`,
      [OLD_LINE, OWNER, B1],
    );
    await db.query(
      `insert into line_slot (id, owner_id, line_id, stage_index, stage, state)
       values ($1,$2,$3,0,'Basic','placeholder')`,
      [OLD_SLOT, OWNER, OLD_LINE],
    );
    await seedOwned({ binder_half: "back" });
    await db.query(`update copy set line_slot_id = $1 where id = $2`, [OLD_SLOT, OWNED]);
    await db.query(`update line_slot set state = 'filled', copy_id = $1 where id = $2`, [
      OWNED,
      OLD_SLOT,
    ]);

    await asOwner(db);
    await shelveIncoming(db, [ownedRow({ binder_half: "back", line_slot_id: OLD_SLOT })], [OWNED]);
    await asSuperuser(db);

    const old = await db.query<{ state: string; copy_id: string | null }>(
      `select state, copy_id from line_slot where id = $1`,
      [OLD_SLOT],
    );
    // Left filled, this slot claims to hold a card that is now in a different line — the 5 stale
    // slots measured on Testing. It must be reopened in the SAME transaction as the move.
    expect(old.rows[0].state).toBe("placeholder");
    expect(old.rows[0].copy_id).toBeNull();

    // And no slot anywhere points at a copy that has moved on.
    const stale = await db.query<{ n: number }>(
      `select count(*)::int as n from line_slot s
       join copy c on c.id = s.copy_id
       where s.copy_id is not null and (c.line_slot_id is null or c.line_slot_id <> s.id)`,
    );
    expect(stale.rows[0].n).toBe(0);
  });
});
