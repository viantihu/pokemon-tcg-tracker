/**
 * M10 — the haul commit is TRULY ATOMIC (dev-spec §5 M6 "committing is atomic and writes a
 * PlacementDecision per card"; §5 M10). Runs the REAL payload builder (`buildHaulCommitPayload` over
 * the real M3 cascade) and applies it through the `apply_write_ops` RPC on a fresh Postgres (PGlite),
 * as the authenticated owner. Proves:
 *   - a successful commit writes the COMPLETE record set + one PlacementDecision per card;
 *   - a commit that fails partway (a bad FK mid-batch) leaves ZERO rows — full rollback;
 *   - the M7 override path and holo-swap displacement land exactly as the interim did.
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
import type { Row, WritePayload } from "@/lib/repo";
import {
  CHARIZARD_BASE1_4,
  CHARIZARD_EX_SV035_006,
  CHARIZARD_EX_SV035_183,
  CHARIZARD_EX_SV03_125_DARK,
  CHARMANDER_SV03_026,
  CHARMELEON_SV03_027,
  EEVEE_SV035_133,
  NEST_BALL_SV01_181,
  SCYTHER_SV035_123,
  VAPOREON_SV035_134,
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
} from "../support/pglite-rpc";

const B1 = "1c000000-0000-0000-0000-0000000000b1"; // active general binder
const SPEC = "1c000000-0000-0000-0000-00000000c5ec"; // specialty binder

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

const CATALOG = [
  CHARMANDER_SV03_026,
  CHARMELEON_SV03_027,
  CHARIZARD_BASE1_4,
  CHARIZARD_EX_SV035_006,
  CHARIZARD_EX_SV035_183,
  CHARIZARD_EX_SV03_125_DARK,
  EEVEE_SV035_133,
  VAPOREON_SV035_134,
  SCYTHER_SV035_123,
  NEST_BALL_SV01_181,
];

/** Build a PlanContext with uuid binders; `owned` optionally seeds shelved copies (for holo-swap). */
function makeContext(owned: Row<"copy">[] = []): PlanContext {
  const catalogById = new Map(CATALOG.map((c) => [c.tcgdexId, c]));
  const copyRowById = new Map(owned.map((c) => [c.id, c]));
  const ownedEngine = owned.map((r) => {
    const card = catalogById.get(r.catalog_card_id)!;
    return {
      id: r.id,
      card,
      variant: (r.variant as "normal" | "holo") ?? "normal",
      role: (r.role as "shelved" | "bulk" | "block") ?? "shelved",
      binderId: r.binder_id,
      binderHalf: (r.binder_half as "front" | "back" | null) ?? null,
      colorBand: r.color_band,
      lineSlotId: r.line_slot_id,
    };
  });
  const ctx: EngineContext = {
    typeColorMap: TYPE_COLOR_MAP,
    catalog: CATALOG,
    owned: ownedEngine,
    binders: [
      { id: B1, name: "Binder 1", type: "general", isActive: true },
      { id: SPEC, name: "Specialty A", type: "specialty", isActive: false },
    ],
    lines: [],
    collections: [],
    now: "2026-09-08T00:00:00.000Z",
  };
  return {
    ctx,
    catalogById,
    copyRowById,
    slotRowsByLine: new Map(),
    orderedBandKeys: BANDS,
    lookups: {
      binderNameById: new Map([
        [B1, "Binder 1"],
        [SPEC, "Specialty A"],
      ]),
      bandDisplayByKey: new Map(BANDS.map((b) => [b, b])),
      collectionNameById: new Map(),
    },
  };
}

/** Seed everything a payload's inserts reference (catalog + binders) so FKs resolve, then act as owner. */
async function seedFor(db: PGlite, payload: WritePayload): Promise<void> {
  await seedCatalogCards(db, referencedCatalogIds(payload));
  await seedBinders(db, [
    { id: B1, type: "general" },
    { id: SPEC, type: "specialty" },
  ]);
  await asOwner(db);
}

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
});
afterEach(async () => {
  await db.close();
});

describe("haul commit atomicity (fresh Postgres via PGlite)", () => {
  // A mixed haul: NEWLINE (Charmeleon, Fire) + SPEC (Charizard ex holo) + FRONT (Vaporeon).
  const draft: DraftItem[] = [
    { id: "d-charmeleon", tcgdexId: CHARMELEON_SV03_027.tcgdexId, variant: "normal" },
    { id: "d-zardex", tcgdexId: CHARIZARD_EX_SV035_006.tcgdexId, variant: "holo" },
    { id: "d-vaporeon", tcgdexId: VAPOREON_SV035_134.tcgdexId, variant: "normal" },
  ];

  it("writes the complete record set + a PlacementDecision per card", async () => {
    const pc = makeContext();
    const { planned } = planFromDraft(pc, draft);
    const { payload, haulId, counts } = buildHaulCommitPayload(pc, planned, {
      source: "show",
      draft,
    });

    await seedFor(db, payload);
    await applyOps(db, payload);
    await asSuperuser(db);

    // Every table matches the counts the builder computed — the whole set landed.
    expect(await count(db, "haul")).toBe(1);
    expect(await count(db, "copy")).toBe(counts.copies);
    expect(counts.copies).toBe(3);
    expect(await count(db, "evolution_line")).toBe(counts.lines);
    expect(await count(db, "line_slot")).toBe(counts.slots);
    expect(await count(db, "wishlist_item")).toBe(counts.wishlist);
    expect(await count(db, "placement_decision")).toBe(counts.decisions);
    expect(counts.decisions).toBe(3);

    // Audit: one row per card, every one automated with a non-empty reason (dev-spec §4).
    const audit = await db.query<{ resolved_by: string; reason: string; copy_id: string }>(
      `select resolved_by, reason, copy_id from placement_decision where haul_id = $1`,
      [haulId],
    );
    expect(audit.rows).toHaveLength(3);
    expect(audit.rows.every((r) => r.resolved_by === "auto")).toBe(true);
    expect(audit.rows.every((r) => r.reason.length > 0)).toBe(true);
    expect(audit.rows.every((r) => r.copy_id !== null)).toBe(true);

    // The Charmeleon copy is wired to its line slot and the slot points back (round-trip intact).
    const zardLine = await db.query<{ n: number }>(
      `select count(*)::int as n from evolution_line where color_band = 'red'`,
    );
    expect(zardLine.rows[0].n).toBe(1);
    const wired = await db.query<{ n: number }>(
      `select count(*)::int as n
         from copy c join line_slot s on s.id = c.line_slot_id
        where s.copy_id = c.id and s.state = 'filled'`,
    );
    expect(wired.rows[0].n).toBe(1);

    // The specialty (Charizard ex) copy shelved in the specialty binder; the Vaporeon shelved front.
    const spec = await db.query<{ n: number }>(
      `select count(*)::int as n from copy where role = 'shelved' and binder_id = $1 and binder_half is null`,
      [SPEC],
    );
    expect(spec.rows[0].n).toBe(1);
    const front = await db.query<{ n: number }>(
      `select count(*)::int as n from copy where role = 'shelved' and binder_id = $1 and binder_half = 'front'`,
      [B1],
    );
    expect(front.rows[0].n).toBe(1);

    // owner_id defaulted to auth.uid() on every owned row (never carried in the payload).
    const owners = await db.query<{ bad: number }>(
      `select count(*)::int as bad from copy where owner_id <> $1`,
      [OWNER],
    );
    expect(owners.rows[0].bad).toBe(0);
  });

  it("rolls back COMPLETELY when an op fails mid-batch (bad FK) — zero rows written", async () => {
    const pc = makeContext();
    const { planned } = planFromDraft(pc, draft);
    const { payload } = buildHaulCommitPayload(pc, planned, { source: "show", draft });

    // Seed the legitimately-referenced rows, then inject a poison copy referencing a card we did NOT
    // seed — it violates copy.catalog_card_id → catalog_card AFTER the haul + earlier copies inserted.
    await seedFor(db, payload);
    const poisoned: WritePayload = {
      ops: [
        ...payload.ops.slice(0, 4),
        {
          op: "insert_copy",
          id: crypto.randomUUID(),
          catalog_card_id: "does-not-exist-in-catalog",
          variant: "normal",
          role: "bulk",
        },
        ...payload.ops.slice(4),
      ],
    };

    await expect(applyOps(db, poisoned)).rejects.toThrow();

    await asSuperuser(db);
    for (const t of [
      "haul",
      "copy",
      "evolution_line",
      "line_slot",
      "wishlist_item",
      "placement_decision",
    ]) {
      expect(await count(db, t)).toBe(0);
    }
  });

  it("override path: places exactly where told, audited as 'user', cascade side effects skipped", async () => {
    const pc = makeContext();
    const overrideDraft: DraftItem[] = [
      { id: "d-charmeleon", tcgdexId: CHARMELEON_SV03_027.tcgdexId, variant: "normal" },
    ];
    const { planned } = planFromDraft(pc, overrideDraft);
    const { payload, counts } = buildHaulCommitPayload(pc, planned, {
      source: "trade",
      draft: overrideDraft,
      overrides: { "d-charmeleon": { kind: "bulk" } },
    });

    await seedFor(db, payload);
    await applyOps(db, payload);
    await asSuperuser(db);

    expect(counts.copies).toBe(1);
    expect(counts.lines).toBe(0); // cascade's NEWLINE side effects skipped
    expect(counts.slots).toBe(0);
    expect(await count(db, "evolution_line")).toBe(0);
    expect(await count(db, "line_slot")).toBe(0);
    const copy = await db.query<{
      role: string;
      binder_id: string | null;
      line_slot_id: string | null;
    }>(`select role, binder_id, line_slot_id from copy`);
    expect(copy.rows[0]).toMatchObject({ role: "bulk", binder_id: null, line_slot_id: null });
    const decision = await db.query<{ resolved_by: string; decision: string }>(
      `select resolved_by, decision from placement_decision`,
    );
    expect(decision.rows[0].resolved_by).toBe("user");
    expect(decision.rows[0].decision).toBe("placement-override");
  });

  it("holo-swap: incoming holo inherits the shelved normal's role; the normal is displaced to bulk", async () => {
    // A shelved NORMAL Vaporeon already lives front-half in Binder 1 (light_blue).
    const ownedId = "c0000000-0000-0000-0000-0000000000aa";
    const owned = {
      id: ownedId,
      catalog_card_id: VAPOREON_SV035_134.tcgdexId,
      variant: "normal",
      role: "shelved",
      binder_id: B1,
      binder_half: "front",
      color_band: "light_blue",
      line_slot_id: null,
    } as unknown as Row<"copy">;

    const pc = makeContext([owned]);
    const swapDraft: DraftItem[] = [
      { id: "d-vap-holo", tcgdexId: VAPOREON_SV035_134.tcgdexId, variant: "holo" },
    ];
    const { planned } = planFromDraft(pc, swapDraft);
    const { payload } = buildHaulCommitPayload(pc, planned, {
      source: "pack-rip",
      draft: swapDraft,
    });

    // The builder must have emitted the displacement update.
    expect(payload.ops.some((o) => o.op === "update_copy" && o.id === ownedId)).toBe(true);

    // Seed catalog + binders + the pre-existing owned copy, then apply as owner.
    await seedCatalogCards(db, referencedCatalogIds(payload));
    await seedBinders(db, [
      { id: B1, type: "general" },
      { id: SPEC, type: "specialty" },
    ]);
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band)
       values ($1, $2, $3, 'normal', 'shelved', $4, 'front', 'light_blue')`,
      [ownedId, OWNER, VAPOREON_SV035_134.tcgdexId, B1],
    );
    await asOwner(db);
    await applyOps(db, payload);
    await asSuperuser(db);

    // Two copies now: the displaced normal (→ bulk, placement cleared) + the incoming holo (front).
    expect(await count(db, "copy")).toBe(2);
    const displaced = await db.query<{
      role: string;
      binder_id: string | null;
      color_band: string | null;
    }>(`select role, binder_id, color_band from copy where id = $1`, [ownedId]);
    expect(displaced.rows[0]).toMatchObject({ role: "bulk", binder_id: null, color_band: null });
    const holo = await db.query<{ n: number }>(
      `select count(*)::int as n from copy
        where variant = 'holo' and role = 'shelved' and binder_id = $1 and binder_half = 'front' and color_band = 'light_blue'`,
      [B1],
    );
    expect(holo.rows[0].n).toBe(1);
  });
});
