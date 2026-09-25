/**
 * M10 — the M5 BACKFILL commit is TRULY ATOMIC (dev-spec §5 M5, §5 M10; migration 0007_backfill_ops).
 *
 * Mirrors tests/plan/commit-atomicity.test.ts and tests/sync/exec-atomicity.test.ts: runs the REAL
 * pure planners (`planFrontHalf` / `planBackLine` / `planSpecialty`) through the REAL op builder
 * (`buildBackfillPayload`) and applies the result via `apply_write_ops` on a fresh Postgres (PGlite,
 * migrations 0001→0007) as the authenticated owner with RLS on. Proves:
 *
 *   - each of the three backfill paths writes its COMPLETE record set — including the binder_block
 *     rows and the collection target union that 0006 had no ops for;
 *   - a poison op mid-batch leaves ZERO rows across copy / evolution_line / line_slot / binder_block /
 *     wishlist_item / placement_decision AND leaves `collection.target_catalog_card_ids` untouched;
 *   - the collection union is idempotent — re-tagging the same card never duplicates an id.
 *
 * Every card is a copy her Dex import left WAITING in her haul (UIL-098): `HAUL` seeds them, in presence
 * groups as an import leaves them, and the planners place them. So "zero rows" after a rollback now reads
 * "every copy still waiting, and no copy created" — the copy table's count never changes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { TypeColorMap } from "@/lib/engine";
import {
  buildBackfillPayload,
  planBackLine,
  planFrontHalf,
  planSpecialty,
  type BackfillWrites,
  type PlanDeps,
} from "@/lib/backfill";
import type { WriteOp, WritePayload } from "@/lib/repo";
import {
  ARVEN_SV03_186,
  CHARIZARD_BASE1_4,
  CHARIZARD_EX_SV035_183,
  CHARMANDER_SV03_026,
  CHARMELEON_SV03_027,
  SCIZOR_SV03_141,
} from "../engine/fixtures";
import {
  applyOps,
  asOwner,
  asSuperuser,
  count,
  freshRpcDb,
  OWNER,
  referencedCatalogIds,
  seedBinders,
  seedCatalogCards,
  seedCollections,
  seedHaulCopies,
} from "../support/pglite-rpc";

const B1 = "1c000000-0000-0000-0000-0000000000b1"; // general binder
const SPEC = "1c000000-0000-0000-0000-00000000c5ec"; // specialty binder
const COLL = "c0111111-0000-0000-0000-0000000000c1"; // a running collection

const FIXTURES = [
  CHARMANDER_SV03_026,
  CHARMELEON_SV03_027,
  CHARIZARD_BASE1_4,
  CHARIZARD_EX_SV035_183,
  SCIZOR_SV03_141,
  ARVEN_SV03_186,
];

/** The copies waiting in her haul — one per pocket the tests below fill, keyed by (card, Dex variant). */
const HAUL = [
  {
    id: "a0000000-0000-4000-8000-000000000001",
    catalogCardId: CHARMANDER_SV03_026.tcgdexId,
    variant: "normal",
    dexVariantRaw: "Normal",
  },
  {
    id: "a0000000-0000-4000-8000-000000000002",
    catalogCardId: ARVEN_SV03_186.tcgdexId,
    variant: "reverse",
    dexVariantRaw: "Reverse Holo",
  },
  {
    id: "a0000000-0000-4000-8000-000000000003",
    catalogCardId: SCIZOR_SV03_141.tcgdexId,
    variant: "holo",
    dexVariantRaw: "Holo",
  },
  {
    id: "a0000000-0000-4000-8000-000000000004",
    catalogCardId: CHARIZARD_BASE1_4.tcgdexId,
    variant: "holo",
    dexVariantRaw: "Holo",
  },
  {
    id: "a0000000-0000-4000-8000-000000000005",
    catalogCardId: CHARIZARD_EX_SV035_183.tcgdexId,
    variant: "holo",
    dexVariantRaw: "Holo",
  },
];

/** A taker over `HAUL`, the way `takerFor` hands out a real pool: each key's copies once, in order. */
function haulTaker(): PlanDeps["takeCopy"] {
  const used = new Set<string>();
  return (tcgdexId, dexVariantRaw) => {
    const c = HAUL.find(
      (h) => h.catalogCardId === tcgdexId && h.dexVariantRaw === dexVariantRaw && !used.has(h.id),
    );
    if (!c) throw new Error(`no waiting ${tcgdexId} (${dexVariantRaw}) in the fixture`);
    used.add(c.id);
    return c.id;
  };
}

/** The confirmed type→band map (0003_config.sql), as the planners see it. */
const TYPE_COLOR_MAP: TypeColorMap = {
  Fire: "red",
  Fighting: "orange",
  Lightning: "yellow",
  Dragon: "olive",
  Grass: "green",
  Darkness: "dark_blue",
  Water: "light_blue",
  Psychic: "purple",
  Fairy: "pink",
  Colorless: "white",
  Metal: "white",
  Trainer: "white",
  Supporter: "white",
  Item: "white",
};

function deps(): PlanDeps {
  return {
    ownerId: OWNER,
    catalogById: new Map(FIXTURES.map((c) => [c.tcgdexId, c])),
    typeColorMap: TYPE_COLOR_MAP,
    binderNameById: new Map([
      [B1, "Binder 1"],
      [SPEC, "Specialty A"],
    ]),
    bandDisplayByKey: new Map([
      ["red", "Red"],
      ["white", "White"],
    ]),
    collectionNameById: new Map([[COLL, "Charizard through the years"]]),
    newId: () => crypto.randomUUID(), // real uuids — every id column is uuid
    takeCopy: haulTaker(),
    now: "2026-09-08T00:00:00.000Z",
  };
}

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
});
afterEach(async () => {
  await db.close();
});

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await db.query<T>(sql, params)).rows;
}

/**
 * Seed the catalog + binders a payload references, the collection, and every waiting copy in `HAUL`, then
 * act as the owner.
 */
async function seedFor(payload: WritePayload, collTargets: string[] = []): Promise<void> {
  await seedCatalogCards(db, [
    ...new Set([...referencedCatalogIds(payload), ...HAUL.map((h) => h.catalogCardId)]),
  ]);
  await seedHaulCopies(db, HAUL);
  await seedBinders(db, [
    { id: B1, type: "general", name: "Binder 1" },
    { id: SPEC, type: "specialty", name: "Specialty A" },
  ]);
  await seedCollections(db, [
    { id: COLL, name: "Charizard through the years", targetCatalogCardIds: collTargets },
  ]);
  await asOwner(db);
}

/** Copies still waiting in her haul (unplaced). */
async function waiting(): Promise<number> {
  return (await q<{ n: number }>(`select count(*)::int n from copy where role = 'haul'`))[0].n;
}

async function collectionTargets(): Promise<string[]> {
  const rows = await q<{ ids: string[] }>(
    `select target_catalog_card_ids as ids from collection where id = $1`,
    [COLL],
  );
  return rows[0].ids;
}

/* ----------------------- 0007's security properties ----------------------- */

describe("0007 replaces apply_write_ops without loosening it", () => {
  it("is still SECURITY INVOKER with a pinned search_path, executable by authenticated but not anon", async () => {
    const meta = await q<{ secdef: boolean; config: string[] | null }>(
      `select p.prosecdef as secdef, p.proconfig as config
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'apply_write_ops'`,
    );
    expect(meta).toHaveLength(1); // replaced in place — not a second overload
    expect(meta[0].secdef).toBe(false); // SECURITY DEFINER would bypass owner RLS
    expect(meta[0].config).toEqual(["search_path=public, pg_temp"]);

    // 0006's grants survive the replace (and 0007 re-asserts them anyway).
    const canExecute = async (role: string) =>
      (
        await q<{ ok: boolean }>(
          `select has_function_privilege($1, 'apply_write_ops(jsonb)', 'execute') as ok`,
          [role],
        )
      )[0].ok;
    expect(await canExecute("authenticated")).toBe(true);
    expect(await canExecute("service_role")).toBe(true);
    expect(await canExecute("anon")).toBe(false);
  });
});

/* -------------------------------- front half ------------------------------- */

describe("backfill front-half commit atomicity (fresh Postgres via PGlite)", () => {
  const writes = (): BackfillWrites =>
    planFrontHalf(
      {
        binderId: B1,
        half: "front",
        cards: [
          { tcgdexId: CHARMANDER_SV03_026.tcgdexId, dexVariantRaw: "Normal" }, // Fire → red
          { tcgdexId: ARVEN_SV03_186.tcgdexId, dexVariantRaw: "Reverse Holo" }, // Trainer (no types) → white
        ],
      },
      deps(),
    );

  it("places one waiting copy per card with its auto-computed band + a PlacementDecision each", async () => {
    const w = writes();
    const payload = buildBackfillPayload(w);
    // UIL-098: the payload creates nothing. Pre-fix it held one insert_copy per card.
    expect(payload.ops.filter((o) => o.op === "insert_copy")).toEqual([]);
    await seedFor(payload);
    await applyOps(db, payload);
    await asSuperuser(db);

    expect(await count(db, "copy")).toBe(HAUL.length); // no copy created
    expect(await waiting()).toBe(HAUL.length - 2);
    expect(await count(db, "placement_decision")).toBe(2);
    // A flat front-half entry touches nothing else.
    expect(await count(db, "evolution_line")).toBe(0);
    expect(await count(db, "line_slot")).toBe(0);
    expect(await count(db, "binder_block")).toBe(0);
    expect(await count(db, "wishlist_item")).toBe(0);

    const copies = await q<{
      id: string;
      catalog_card_id: string;
      color_band: string;
      variant: string;
      grouped: boolean;
    }>(
      `select id, catalog_card_id, color_band, variant, presence_group_id is not null as grouped
         from copy
        where role = 'shelved' and binder_id = $1 and binder_half = 'front'
        order by catalog_card_id`,
      [B1],
    );
    // The SAME rows her import made, still in their presence groups; the variant is Dex's, untouched.
    expect(copies).toEqual([
      {
        id: HAUL[0].id,
        catalog_card_id: CHARMANDER_SV03_026.tcgdexId,
        color_band: "red",
        variant: "normal",
        grouped: true,
      },
      {
        id: HAUL[1].id,
        catalog_card_id: ARVEN_SV03_186.tcgdexId,
        color_band: "white",
        variant: "reverse",
        grouped: true,
      },
    ]);

    // Backfill is a transcription: no haul row, and the audit trail is always the collector's own call.
    const audit = await q<{ resolved_by: string; haul_id: string | null; reason: string }>(
      `select resolved_by, haul_id, reason from placement_decision`,
    );
    expect(audit.every((r) => r.resolved_by === "user")).toBe(true);
    expect(audit.every((r) => r.haul_id === null)).toBe(true);
    expect(audit.every((r) => r.reason.length > 0)).toBe(true);

    // owner_id defaulted to auth.uid() on every row — it is never carried in the payload.
    expect(
      (
        await q<{ bad: number }>(`select count(*)::int bad from copy where owner_id <> $1`, [OWNER])
      )[0].bad,
    ).toBe(0);
    expect(
      (
        await q<{ bad: number }>(
          `select count(*)::int bad from placement_decision where owner_id <> $1`,
          [OWNER],
        )
      )[0].bad,
    ).toBe(0);
  });
});

/* ------------------------------ back-half line ----------------------------- */

describe("backfill back-line commit atomicity (fresh Postgres via PGlite)", () => {
  /** A Charmander line: FILLED root, placeholder Stage1, 2-pocket repurposed-duplicate block Stage2. */
  const writes = (): BackfillWrites =>
    planBackLine(
      {
        binderId: B1,
        bandKey: "red",
        rootDexId: 4,
        requiredType: "Fire",
        terminated: false,
        stages: [
          {
            stageIndex: 0,
            stage: "Basic",
            dexId: 4,
            decision: "filled",
            filledTcgdexId: CHARMANDER_SV03_026.tcgdexId,
            filledDexVariantRaw: "Normal",
          },
          {
            stageIndex: 1,
            stage: "Stage1",
            dexId: 5,
            decision: "placeholder",
            targetCatalogCardId: CHARMELEON_SV03_027.tcgdexId,
            alternateCatalogCardIds: [CHARIZARD_BASE1_4.tcgdexId],
            specialtyOnly: false,
          },
          {
            stageIndex: 2,
            stage: "Stage2",
            dexId: 6,
            decision: "block",
            blockMaterial: "repurposedDuplicate",
            blockCopyTcgdexId: SCIZOR_SV03_141.tcgdexId,
            blockCopyDexVariantRaw: "Holo",
            pocketCount: 2,
          },
        ],
      },
      deps(),
    );

  it("writes the line, all three slots, places both copies, the wishlist item, and the binder_block", async () => {
    const w = writes();
    const payload = buildBackfillPayload(w);
    expect(payload.ops.filter((o) => o.op === "insert_copy")).toEqual([]);
    await seedFor(payload);
    await applyOps(db, payload);
    await asSuperuser(db);

    expect(await count(db, "evolution_line")).toBe(1);
    expect(await count(db, "line_slot")).toBe(3);
    expect(await count(db, "copy")).toBe(HAUL.length); // no copy created
    expect(await waiting()).toBe(HAUL.length - 2); // the FILLED copy + the sacrificed duplicate placed
    expect(await count(db, "wishlist_item")).toBe(1);
    expect(await count(db, "binder_block")).toBe(1);
    expect(await count(db, "placement_decision")).toBe(2);

    // The deferred circular link resolved: the copy points at its slot and the slot points back.
    const wired = await q<{ n: number }>(
      `select count(*)::int n
         from copy c join line_slot s on s.id = c.line_slot_id
        where s.copy_id = c.id and s.state = 'filled' and s.stage_index = 0`,
    );
    expect(wired[0].n).toBe(1);

    // The placeholder slot carries the wishlist target + ranked alternates.
    const wl = await q<{
      required_dex_id: number;
      required_type: string;
      chosen: string;
      alts: string[];
      state: string;
    }>(
      `select w.required_dex_id, w.required_type, w.chosen_catalog_card_id as chosen,
              w.alternate_catalog_card_ids as alts, s.state
         from wishlist_item w join line_slot s on s.id = w.line_slot_id`,
    );
    expect(wl[0]).toEqual({
      required_dex_id: 5,
      required_type: "Fire",
      chosen: CHARMELEON_SV03_027.tcgdexId,
      alts: [CHARIZARD_BASE1_4.tcgdexId],
      state: "placeholder",
    });

    // The block row — the capability 0006 was missing entirely. It names the sacrificed copy + line.
    const block = await q<{
      half: string;
      pocket_count: number;
      purpose: string;
      material: string;
      copy_role: string;
      line_band: string;
    }>(
      `select b.half, b.pocket_count, b.purpose, b.material, c.role as copy_role,
              l.color_band as line_band
         from binder_block b
         join copy c on c.id = b.copy_id
         join evolution_line l on l.id = b.line_id
        where b.binder_id = $1`,
      [B1],
    );
    expect(block[0]).toEqual({
      half: "back",
      pocket_count: 2,
      purpose: "line-terminated",
      material: "repurposedDuplicate",
      copy_role: "block",
      line_band: "red",
    });
    expect(
      (
        await q<{ bad: number }>(
          `select count(*)::int bad from binder_block where owner_id <> $1`,
          [OWNER],
        )
      )[0].bad,
    ).toBe(0);
  });

  it("a poison op mid-batch leaves ZERO rows in every backfill table — full rollback", async () => {
    const w = writes();
    const payload = buildBackfillPayload(w);
    await seedFor(payload);

    // Inject a copy referencing a catalog card we did NOT seed: it violates
    // copy.catalog_card_id → catalog_card AFTER the line + earlier copies have already inserted.
    const poison: WriteOp = {
      op: "insert_copy",
      presence_group_id: "00000000-0000-4000-8000-00000000900d", // a group that does not exist: this op must fail (0023)
      id: crypto.randomUUID(),
      catalog_card_id: "does-not-exist-in-catalog",
      variant: "normal",
      role: "bulk",
    };
    const half = Math.floor(payload.ops.length / 2);
    const poisoned: WritePayload = {
      ops: [...payload.ops.slice(0, half), poison, ...payload.ops.slice(half)],
    };

    await expect(applyOps(db, poisoned)).rejects.toThrow();
    await asSuperuser(db);

    for (const t of [
      "evolution_line",
      "line_slot",
      "binder_block",
      "wishlist_item",
      "placement_decision",
    ]) {
      expect(await count(db, t)).toBe(0);
    }
    // Every copy is back where it was: waiting, unplaced.
    expect(await count(db, "copy")).toBe(HAUL.length);
    expect(await waiting()).toBe(HAUL.length);
  });

  it("an unknown op tag raises and rolls the whole batch back", async () => {
    const w = writes();
    const payload = buildBackfillPayload(w);
    await seedFor(payload);

    const bogus = { op: "insert_teapot", id: crypto.randomUUID() } as unknown as WriteOp;
    await expect(applyOps(db, { ops: [...payload.ops, bogus] })).rejects.toThrow(/unknown op/);
    await asSuperuser(db);
    expect(await count(db, "evolution_line")).toBe(0);
    expect(await waiting()).toBe(HAUL.length);
  });
});

/* --------------------------- specialty + collections ---------------------------- */

describe("backfill specialty commit atomicity + collection tagging (fresh Postgres via PGlite)", () => {
  const writes = (): BackfillWrites =>
    planSpecialty(
      {
        binderId: SPEC,
        cards: [
          { tcgdexId: CHARIZARD_BASE1_4.tcgdexId, dexVariantRaw: "Holo", collectionIds: [COLL] },
          {
            tcgdexId: CHARIZARD_EX_SV035_183.tcgdexId,
            dexVariantRaw: "Holo",
            collectionIds: [COLL],
          },
          { tcgdexId: SCIZOR_SV03_141.tcgdexId, dexVariantRaw: "Holo", collectionIds: [] }, // untagged
        ],
      },
      deps(),
    );

  it("places the copies and UNIONS the tagged ids into the collection, preserving prior members", async () => {
    const w = writes();
    const payload = buildBackfillPayload(w);
    // The collection already targets one card; the union must keep it and append, not replace.
    await seedFor(payload, [CHARMANDER_SV03_026.tcgdexId]);

    // One op per collection, carrying both tagged ids (the untagged card contributes nothing).
    const unions = payload.ops.filter((o) => o.op === "union_collection_targets");
    expect(unions).toHaveLength(1);

    await applyOps(db, payload);
    await asSuperuser(db);

    expect(await count(db, "copy")).toBe(HAUL.length); // no copy created
    expect(await waiting()).toBe(HAUL.length - 3);
    expect(await count(db, "placement_decision")).toBe(3);
    // A specialty binder is a single section: no half, no band.
    const spec = await q<{ n: number }>(
      `select count(*)::int n from copy
        where role = 'shelved' and binder_id = $1 and binder_half is null and color_band is null`,
      [SPEC],
    );
    expect(spec[0].n).toBe(3);

    expect(await collectionTargets()).toEqual([
      CHARMANDER_SV03_026.tcgdexId, // pre-existing member, kept in place
      CHARIZARD_BASE1_4.tcgdexId,
      CHARIZARD_EX_SV035_183.tcgdexId,
    ]);
    // The untagged card is NOT a collection target.
    expect(await collectionTargets()).not.toContain(SCIZOR_SV03_141.tcgdexId);
  });

  it("the union is idempotent — re-tagging the same cards never duplicates an id", async () => {
    const payload = buildBackfillPayload(writes());
    await seedFor(payload);
    await applyOps(db, payload);

    // Re-tag the very same cards: once as a second commit of just the union ops (re-applying the
    // whole payload would re-insert its decision rows), once with the id repeated inside a single op.
    const unions = payload.ops.filter((o) => o.op === "union_collection_targets");
    expect(unions).toHaveLength(1);
    await applyOps(db, { ops: unions });
    await applyOps(db, {
      ops: [
        {
          op: "union_collection_targets",
          collection_id: COLL,
          catalog_card_ids: [CHARIZARD_BASE1_4.tcgdexId, CHARIZARD_BASE1_4.tcgdexId],
        },
      ],
    });
    await asSuperuser(db);

    const targets = await collectionTargets();
    expect(targets).toEqual([CHARIZARD_BASE1_4.tcgdexId, CHARIZARD_EX_SV035_183.tcgdexId]);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it("a failed specialty commit leaves the collection's target list UNCHANGED", async () => {
    const payload = buildBackfillPayload(writes());
    const before = [CHARMANDER_SV03_026.tcgdexId];
    await seedFor(payload, before);

    // The union ops run last, so a poison op appended after them proves the whole statement — not
    // just the inserts — rolls back.
    const poisoned: WritePayload = {
      ops: [
        ...payload.ops,
        {
          op: "insert_copy",
          presence_group_id: "00000000-0000-4000-8000-00000000900d", // a group that does not exist: this op must fail (0023)
          id: crypto.randomUUID(),
          catalog_card_id: "does-not-exist-in-catalog",
          variant: "normal",
          role: "bulk",
        },
      ],
    };
    await expect(applyOps(db, poisoned)).rejects.toThrow();
    await asSuperuser(db);

    expect(await collectionTargets()).toEqual(before);
    expect(await waiting()).toBe(HAUL.length);
    expect(await count(db, "placement_decision")).toBe(0);
  });

  it("tagging a collection that is not the caller's is a silent no-op (RLS), not a crash", async () => {
    const payload = buildBackfillPayload(writes());
    await seedFor(payload);
    await applyOps(db, {
      ops: [
        {
          op: "union_collection_targets",
          collection_id: "c0111111-0000-0000-0000-00000000dead", // no such collection
          catalog_card_ids: [CHARIZARD_BASE1_4.tcgdexId],
        },
      ],
    });
    await asSuperuser(db);
    expect(await collectionTargets()).toEqual([]);
  });
});
