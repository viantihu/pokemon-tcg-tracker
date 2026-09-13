/**
 * UIL-003 — sync's unplaced copies can be PLACED through the Haul Plan.
 *
 * Sync creates its additions unplaced on purpose and hands them to the routing cascade
 * (sync-architecture §1.1; lib/sync/exec.ts step 3), but the plan had no way to receive them: it only
 * ever built brand-new copies from typed entry, so "Place new cards" dead-ended and the only manual
 * workaround (retyping the cards) would have DOUBLED her counts. These tests pin the fix on a real
 * Postgres (PGlite) through the real `apply_write_ops` RPC:
 *
 *   - routing an existing copy UPDATES that row — no second copy of the same physical card;
 *   - a pure routing pass writes NO haul, and its audit row carries `haul_id: null`;
 *   - the copy leaves the pending queue afterwards even when the cascade sent it to BULK, which is
 *     the case the placement columns alone cannot distinguish;
 *   - a mixed pass stamps the haul on the newly-acquired card only;
 *   - the plan for routed copies is IDENTICAL to the plan for the same cards typed by hand.
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
  CHARMANDER_SV03_026,
  CHARMELEON_SV03_027,
  EEVEE_SV035_133,
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
};

const CATALOG = [
  CHARMANDER_SV03_026,
  CHARMELEON_SV03_027,
  EEVEE_SV035_133,
  SCYTHER_SV035_123,
  VAPOREON_SV035_134,
];

/**
 * A PlanContext over uuid binders. `excludeOwnedIds` mirrors what `loadPlanContext` does for a routed
 * draft: the copies this pass is placing stay in `copyRowById` but are withheld from `ctx.owned`,
 * because they are the incoming stack rather than the established collection.
 */
function makeContext(owned: Row<"copy">[] = [], excludeOwnedIds: string[] = []): PlanContext {
  const catalogById = new Map(CATALOG.map((c) => [c.tcgdexId, c]));
  const copyRowById = new Map(owned.map((c) => [c.id, c]));
  const excluded = new Set(excludeOwnedIds);
  const ownedEngine = owned
    .filter((r) => !excluded.has(r.id))
    .map((r) => ({
      id: r.id,
      card: catalogById.get(r.catalog_card_id)!,
      variant: (r.variant as "normal" | "holo") ?? "normal",
      role: (r.role as "shelved" | "bulk" | "block") ?? "shelved",
      binderId: r.binder_id,
      binderHalf: (r.binder_half as "front" | "back" | null) ?? null,
      colorBand: r.color_band,
      lineSlotId: r.line_slot_id,
    }));
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
    now: "2026-09-13T00:00:00.000Z",
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

/** A `copy` row as sync leaves it: unplaced, no haul, keyed to a presence group. */
function unplacedCopy(id: string, tcgdexId: string, variant = "normal"): Row<"copy"> {
  return {
    id,
    catalog_card_id: tcgdexId,
    variant,
    dex_variant_raw: variant === "holo" ? "Holo" : "Normal",
    role: "bulk",
    binder_id: null,
    binder_half: null,
    color_band: null,
    line_slot_id: null,
    haul_id: null,
  } as unknown as Row<"copy">;
}

/** Insert a `copy` row directly (superuser), the way sync would have. */
async function seedCopy(db: PGlite, c: Row<"copy">): Promise<void> {
  await db.query(
    `insert into copy (id, owner_id, catalog_card_id, variant, dex_variant_raw, role,
                       binder_id, binder_half, color_band, acquired_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
    [
      c.id,
      OWNER,
      c.catalog_card_id,
      c.variant,
      c.dex_variant_raw,
      c.role,
      c.binder_id,
      c.binder_half,
      c.color_band,
    ],
  );
}

/**
 * The queue predicate from lib/plan/pending.ts, in SQL: unplaced AND never ruled on. Asserting
 * against the same definition the loader uses is the point — it is what makes the queue self-clearing.
 */
async function pendingIds(db: PGlite): Promise<string[]> {
  const r = await db.query<{ id: string }>(
    `select c.id from copy c
      where c.role = 'bulk' and c.binder_id is null and c.line_slot_id is null
        and not exists (select 1 from placement_decision d where d.copy_id = c.id)
      order by c.created_at, c.id`,
  );
  return r.rows.map((x) => x.id);
}

async function seedFor(db: PGlite, payload: WritePayload, extraIds: string[] = []): Promise<void> {
  await seedCatalogCards(db, [...referencedCatalogIds(payload), ...extraIds]);
  await seedBinders(db, [
    { id: B1, type: "general" },
    { id: SPEC, type: "specialty" },
  ]);
}

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
});
afterEach(async () => {
  await db.close();
});

describe("routing existing unplaced copies through the plan (UIL-003)", () => {
  const SCYTHER_COPY = "c0000000-0000-0000-0000-00000000dd01";

  it("places the copy sync already created instead of adding a second one", async () => {
    const pending = unplacedCopy(SCYTHER_COPY, SCYTHER_SV035_123.tcgdexId);
    const pc = makeContext([pending], [SCYTHER_COPY]);
    const draft: DraftItem[] = [
      {
        id: SCYTHER_COPY,
        tcgdexId: SCYTHER_SV035_123.tcgdexId,
        variant: "normal",
        existingCopyId: SCYTHER_COPY,
      },
    ];
    const { planned } = planFromDraft(pc, draft);
    const { payload, haulId, counts } = buildHaulCommitPayload(pc, planned, {
      source: "bulk-bin",
      draft,
    });

    // The builder routes rather than creates: no insert_copy at all.
    expect(payload.ops.some((o) => o.op === "insert_copy")).toBe(false);
    expect(payload.ops.some((o) => o.op === "update_copy" && o.id === SCYTHER_COPY)).toBe(true);
    // A routing pass is not an acquisition event.
    expect(haulId).toBeNull();
    expect(counts.copies).toBe(0);
    expect(counts.routed).toBe(1);

    await seedFor(db, payload, [SCYTHER_SV035_123.tcgdexId]);
    await seedCopy(db, pending);
    await asOwner(db);
    await applyOps(db, payload);
    await asSuperuser(db);

    // Still exactly ONE Scyther copy — the whole point. Retyping it would have made two.
    expect(await count(db, "copy")).toBe(1);
    expect(await count(db, "haul")).toBe(0);

    const row = await db.query<{
      id: string;
      role: string;
      binder_id: string | null;
      binder_half: string | null;
      color_band: string | null;
      haul_id: string | null;
      dex_variant_raw: string | null;
    }>(`select id, role, binder_id, binder_half, color_band, haul_id, dex_variant_raw from copy`);
    expect(row.rows[0]).toMatchObject({
      id: SCYTHER_COPY, // same row, same id: placement history and presence links survive
      role: "shelved",
      binder_id: B1,
      binder_half: "front",
      color_band: "green",
      haul_id: null, // not acquired in a haul; sync brought it in
      dex_variant_raw: "Normal", // Dex owns the variant; the routing pass does not touch it
    });

    // Audited like any placement, but attached to no haul.
    const audit = await db.query<{ copy_id: string; haul_id: string | null; resolved_by: string }>(
      `select copy_id, haul_id, resolved_by from placement_decision`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      copy_id: SCYTHER_COPY,
      haul_id: null,
      resolved_by: "auto",
    });

    // And it is out of the queue.
    expect(await pendingIds(db)).toEqual([]);
  });

  it("leaves the queue even when the cascade routes it BACK to bulk as a duplicate", async () => {
    // A Scyther is already shelved, so the pending one is a duplicate → bulk (system-design §5 step 3).
    const shelvedId = "c0000000-0000-0000-0000-00000000dd99";
    const shelved = {
      id: shelvedId,
      catalog_card_id: SCYTHER_SV035_123.tcgdexId,
      variant: "normal",
      role: "shelved",
      binder_id: B1,
      binder_half: "front",
      color_band: "green",
      line_slot_id: null,
    } as unknown as Row<"copy">;
    const pending = unplacedCopy(SCYTHER_COPY, SCYTHER_SV035_123.tcgdexId);

    const pc = makeContext([shelved, pending], [SCYTHER_COPY]);
    const draft: DraftItem[] = [
      {
        id: SCYTHER_COPY,
        tcgdexId: SCYTHER_SV035_123.tcgdexId,
        variant: "normal",
        existingCopyId: SCYTHER_COPY,
      },
    ];
    const { items, planned } = planFromDraft(pc, draft);
    expect(items[0].action).toBe("BULK");
    const { payload } = buildHaulCommitPayload(pc, planned, { source: "bulk-bin", draft });

    await seedFor(db, payload, [SCYTHER_SV035_123.tcgdexId]);
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band)
       values ($1, $2, $3, 'normal', 'shelved', $4, 'front', 'green')`,
      [shelvedId, OWNER, SCYTHER_SV035_123.tcgdexId, B1],
    );
    await seedCopy(db, pending);
    await asOwner(db);
    await applyOps(db, payload);
    await asSuperuser(db);

    // Placement columns are unchanged (bulk, nowhere) — indistinguishable from an untouched sync add.
    const row = await db.query<{ role: string; binder_id: string | null }>(
      `select role, binder_id from copy where id = $1`,
      [SCYTHER_COPY],
    );
    expect(row.rows[0]).toMatchObject({ role: "bulk", binder_id: null });
    // The decision row is what tells them apart, so the queue is empty and she is not re-nagged.
    expect(await pendingIds(db)).toEqual([]);
  });

  it("a mixed pass stamps the haul on the newly-acquired card only", async () => {
    const pending = unplacedCopy(SCYTHER_COPY, SCYTHER_SV035_123.tcgdexId);
    const pc = makeContext([pending], [SCYTHER_COPY]);
    const draft: DraftItem[] = [
      {
        id: SCYTHER_COPY,
        tcgdexId: SCYTHER_SV035_123.tcgdexId,
        variant: "normal",
        existingCopyId: SCYTHER_COPY,
      },
      { id: "d-eevee", tcgdexId: EEVEE_SV035_133.tcgdexId, variant: "normal" },
    ];
    const { planned } = planFromDraft(pc, draft);
    const { payload, haulId, counts } = buildHaulCommitPayload(pc, planned, {
      source: "pack-rip",
      draft,
    });
    expect(haulId).not.toBeNull();
    expect(counts).toMatchObject({ copies: 1, routed: 1, decisions: 2 });

    await seedFor(db, payload, [SCYTHER_SV035_123.tcgdexId, EEVEE_SV035_133.tcgdexId]);
    await seedCopy(db, pending);
    await asOwner(db);
    await applyOps(db, payload);
    await asSuperuser(db);

    expect(await count(db, "copy")).toBe(2);
    expect(await count(db, "haul")).toBe(1);
    const stamped = await db.query<{ catalog_card_id: string }>(
      `select catalog_card_id from copy where haul_id = $1`,
      [haulId],
    );
    expect(stamped.rows.map((r) => r.catalog_card_id)).toEqual([EEVEE_SV035_133.tcgdexId]);
    // Only the acquired card's audit row belongs to the haul.
    const byHaul = await db.query<{ n: number }>(
      `select count(*)::int as n from placement_decision where haul_id is null`,
    );
    expect(byHaul.rows[0].n).toBe(1);
    expect(await pendingIds(db)).toEqual([]);
  });

  it("an override on a routed copy moves that row, and is audited as 'user'", async () => {
    const pending = unplacedCopy(SCYTHER_COPY, SCYTHER_SV035_123.tcgdexId);
    const pc = makeContext([pending], [SCYTHER_COPY]);
    const draft: DraftItem[] = [
      {
        id: SCYTHER_COPY,
        tcgdexId: SCYTHER_SV035_123.tcgdexId,
        variant: "normal",
        existingCopyId: SCYTHER_COPY,
      },
    ];
    const { planned } = planFromDraft(pc, draft);
    const { payload, counts } = buildHaulCommitPayload(pc, planned, {
      source: "bulk-bin",
      draft,
      overrides: {
        [SCYTHER_COPY]: { kind: "shelf", binderId: B1, half: "back", band: "green" },
      },
    });
    expect(payload.ops.some((o) => o.op === "insert_copy")).toBe(false);
    expect(counts).toMatchObject({ copies: 0, routed: 1 });

    await seedFor(db, payload, [SCYTHER_SV035_123.tcgdexId]);
    await seedCopy(db, pending);
    await asOwner(db);
    await applyOps(db, payload);
    await asSuperuser(db);

    expect(await count(db, "copy")).toBe(1);
    const row = await db.query<{
      role: string;
      binder_id: string | null;
      binder_half: string | null;
    }>(`select role, binder_id, binder_half from copy where id = $1`, [SCYTHER_COPY]);
    expect(row.rows[0]).toMatchObject({ role: "shelved", binder_id: B1, binder_half: "back" });
    const audit = await db.query<{ resolved_by: string; haul_id: string | null }>(
      `select resolved_by, haul_id from placement_decision`,
    );
    expect(audit.rows[0]).toMatchObject({ resolved_by: "user", haul_id: null });
  });
});

describe("routed and typed drafts plan identically (UIL-003)", () => {
  /**
   * The invariant behind withholding routed copies from `ctx.owned`: placing what sync imported must
   * produce the same plan as taking the same cards in by hand. If they were left in `owned`, each card
   * would look like a duplicate of itself and the whole stack would route to bulk.
   */
  it("gives the same destinations for a Charmander + Charmeleon stack either way", () => {
    const cards = [CHARMANDER_SV03_026, CHARMELEON_SV03_027, VAPOREON_SV035_134];
    const ids = cards.map((_, i) => `c0000000-0000-0000-0000-00000000e0${i}0`);
    const pendingRows = cards.map((c, i) => unplacedCopy(ids[i], c.tcgdexId));

    const routedDraft: DraftItem[] = cards.map((c, i) => ({
      id: ids[i],
      tcgdexId: c.tcgdexId,
      variant: "normal",
      existingCopyId: ids[i],
    }));
    const typedDraft: DraftItem[] = cards.map((c, i) => ({
      id: ids[i],
      tcgdexId: c.tcgdexId,
      variant: "normal",
    }));

    const routed = planFromDraft(makeContext(pendingRows, ids), routedDraft).items;
    const typed = planFromDraft(makeContext(), typedDraft).items;

    expect(routed.map((i) => [i.action, i.destination])).toEqual(
      typed.map((i) => [i.action, i.destination]),
    );
    // Sanity: this stack is not all-bulk, so the comparison is actually saying something.
    expect(routed.some((i) => i.action !== "BULK")).toBe(true);
  });

  it("without the exclusion, every routed card would read as a duplicate of itself", () => {
    const id = "c0000000-0000-0000-0000-00000000e999";
    const pending = unplacedCopy(id, SCYTHER_SV035_123.tcgdexId);
    // Deliberately NOT excluded, and shelved, to show what the exclusion is protecting against.
    const asShelved = { ...pending, role: "shelved", binder_id: B1, binder_half: "front" };
    const draft: DraftItem[] = [
      { id, tcgdexId: SCYTHER_SV035_123.tcgdexId, variant: "normal", existingCopyId: id },
    ];
    const leaked = planFromDraft(makeContext([asShelved as Row<"copy">], []), draft).items;
    expect(leaked[0].action).toBe("BULK");
    const excluded = planFromDraft(makeContext([asShelved as Row<"copy">], [id]), draft).items;
    expect(excluded[0].action).toBe("FRONT");
  });
});
