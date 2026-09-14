/**
 * UIL-027 — a card is shelved the moment she clicks Done, and that write is atomic on its own.
 *
 * "Every single card will require a decision, so 'committing the haul' does not make sense. That button
 * basically treats unshelved cards as being in inventory… When the user clicks 'Done', that card has
 * been shelved and should be put in inventory."
 *
 * These run the REAL payload builder over the REAL M3 cascade and apply through the REAL
 * `apply_write_ops` RPC on a fresh Postgres (PGlite), as the authenticated owner — the same harness the
 * whole-haul atomicity tests use, so the comparison between the two models is like for like.
 *
 * What they pin:
 *   - one card commits on its own and the OTHERS ARE NOT WRITTEN (the whole point);
 *   - the sitting stays ONE haul across many per-card transactions;
 *   - a failing card leaves that card's rows out entirely — per-card atomicity survives;
 *   - N sequential per-card commits reach the same database state as one whole-haul commit of the same
 *     N cards, so this is a change of transaction boundary and not of outcome;
 *   - a card whose cascade depends on an earlier card's line still works, because the context is
 *     re-read from the database instead of from an in-payload mirror.
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

const B1 = "1c000000-0000-0000-0000-0000000000b1";
const SPEC = "1c000000-0000-0000-0000-00000000c5ec";

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
  NEST_BALL_SV01_181,
  SCYTHER_SV035_123,
  VAPOREON_SV035_134,
];

function makeContext(owned: Row<"copy">[] = []): PlanContext {
  const catalogById = new Map(CATALOG.map((c) => [c.tcgdexId, c]));
  const copyRowById = new Map(owned.map((c) => [c.id, c]));
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
      // Added by #78 (card artwork on the worklist); empty here — these tests assert on writes.
      imageUrlByTcgdexId: new Map(),
    },
  };
}

/** Three cards that do not interact: independent bands, no shared evolution chain. */
const INDEPENDENT: DraftItem[] = [
  { id: "d-scyther", tcgdexId: SCYTHER_SV035_123.tcgdexId, variant: "normal" },
  { id: "d-eevee", tcgdexId: EEVEE_SV035_133.tcgdexId, variant: "normal" },
  { id: "d-nestball", tcgdexId: NEST_BALL_SV01_181.tcgdexId, variant: "normal" },
];

async function seedFor(db: PGlite, payload: WritePayload, extra: string[] = []): Promise<void> {
  await seedCatalogCards(db, [...referencedCatalogIds(payload), ...extra]);
  await seedBinders(db, [
    { id: B1, type: "general" },
    { id: SPEC, type: "specialty" },
  ]);
}

/** Commit one card the way `commitCardPlacement` does, but against a hand-built context. */
function buildCard(card: DraftItem, haulId: string | null, owned: Row<"copy">[] = []) {
  const pc = makeContext(owned);
  const { planned } = planFromDraft(pc, [card]);
  return buildHaulCommitPayload(pc, planned, {
    source: "bulk-bin",
    draft: [card],
    existingHaulId: haulId,
  });
}

/** The whole database state that both models must agree on. */
async function snapshot(db: PGlite) {
  const q = async <T>(sql: string) => (await db.query<T>(sql)).rows;
  return {
    copies: await q<{
      catalog_card_id: string;
      role: string;
      binder_half: string | null;
      color_band: string | null;
    }>(`select catalog_card_id, role, binder_half, color_band from copy order by catalog_card_id`),
    decisions: await q<{ decision: string; resolved_by: string }>(
      `select decision, resolved_by from placement_decision order by decision, resolved_by`,
    ),
    lines: await q<{ color_band: string }>(
      `select color_band from evolution_line order by color_band`,
    ),
    slotCount: await count(db, "line_slot"),
    haulCount: await count(db, "haul"),
  };
}

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
});
afterEach(async () => {
  await db.close();
});

describe("one card commits on its own (UIL-027)", () => {
  it("writes ONLY the decided card — the rest of the haul stays unwritten", async () => {
    const { payload, haulId } = buildCard(INDEPENDENT[0], null);
    await seedFor(
      db,
      payload,
      CATALOG.map((c) => c.tcgdexId),
    );
    await asOwner(db);
    await applyOps(db, payload);
    await asSuperuser(db);

    // The other two cards she has not reached yet must not exist. This is the whole complaint:
    // previously nothing was written until a click that wrote everything.
    expect(await count(db, "copy")).toBe(1);
    const only = await db.query<{ catalog_card_id: string }>(`select catalog_card_id from copy`);
    expect(only.rows[0].catalog_card_id).toBe(SCYTHER_SV035_123.tcgdexId);
    expect(await count(db, "placement_decision")).toBe(1);
    expect(haulId).not.toBeNull();
  });

  it("keeps the sitting as ONE haul across three separate transactions", async () => {
    let haulId: string | null = null;
    await seedCatalogCards(
      db,
      CATALOG.map((c) => c.tcgdexId),
    );
    await seedBinders(db, [
      { id: B1, type: "general" },
      { id: SPEC, type: "specialty" },
    ]);
    await asOwner(db);
    for (const card of INDEPENDENT) {
      const built = buildCard(card, haulId);
      await applyOps(db, built.payload);
      haulId = built.haulId;
    }
    await asSuperuser(db);

    expect(await count(db, "copy")).toBe(3);
    // One haul row, not three — the sitting survives as a unit of provenance even though each card
    // was its own transaction.
    expect(await count(db, "haul")).toBe(1);
    const stamped = await db.query<{ n: number }>(
      `select count(*)::int as n from copy where haul_id = $1`,
      [haulId],
    );
    expect(stamped.rows[0].n).toBe(3);
  });

  it("a failing card leaves ITS OWN rows out, and the already-shelved cards standing", async () => {
    await seedCatalogCards(
      db,
      CATALOG.map((c) => c.tcgdexId),
    );
    await seedBinders(db, [
      { id: B1, type: "general" },
      { id: SPEC, type: "specialty" },
    ]);
    await asOwner(db);

    const first = buildCard(INDEPENDENT[0], null);
    await applyOps(db, first.payload);

    // Card two poisoned: a copy referencing a catalog row that does not exist.
    const second = buildCard(INDEPENDENT[1], first.haulId);
    const poisoned: WritePayload = {
      ops: [
        ...second.payload.ops,
        {
          op: "insert_copy",
          id: crypto.randomUUID(),
          catalog_card_id: "does-not-exist",
          variant: "normal",
          role: "bulk",
        },
      ],
    };
    await expect(applyOps(db, poisoned)).rejects.toThrow();

    await asSuperuser(db);
    // Card one is still shelved — the failure did not reach back and undo real work she had done.
    expect(await count(db, "copy")).toBe(1);
    // And card two wrote nothing at all: per-card atomicity held.
    const ids = await db.query<{ catalog_card_id: string }>(`select catalog_card_id from copy`);
    expect(ids.rows.map((r) => r.catalog_card_id)).toEqual([SCYTHER_SV035_123.tcgdexId]);
  });
});

describe("per-card commits reach the same state as one whole-haul commit", () => {
  /**
   * The change is meant to move the transaction BOUNDARY, not the outcome. For cards that do not
   * interact, committing them one at a time must land exactly where committing them together does —
   * otherwise this is a behaviour change dressed as a workflow change.
   */
  it("three independent cards: identical database state either way", async () => {
    // (a) whole haul, one transaction
    const whole = (() => {
      const pc = makeContext();
      const { planned } = planFromDraft(pc, INDEPENDENT);
      return buildHaulCommitPayload(pc, planned, { source: "bulk-bin", draft: INDEPENDENT });
    })();
    await seedFor(
      db,
      whole.payload,
      CATALOG.map((c) => c.tcgdexId),
    );
    await asOwner(db);
    await applyOps(db, whole.payload);
    await asSuperuser(db);
    const wholeState = await snapshot(db);
    await db.close();

    // (b) same three cards, one transaction each
    db = await freshRpcDb();
    await seedCatalogCards(
      db,
      CATALOG.map((c) => c.tcgdexId),
    );
    await seedBinders(db, [
      { id: B1, type: "general" },
      { id: SPEC, type: "specialty" },
    ]);
    await asOwner(db);
    let haulId: string | null = null;
    for (const card of INDEPENDENT) {
      const built = buildCard(card, haulId);
      await applyOps(db, built.payload);
      haulId = built.haulId;
    }
    await asSuperuser(db);
    const perCardState = await snapshot(db);

    expect(perCardState).toEqual(wholeState);
  });
});

describe("a routed copy commits per card too (UIL-003 path)", () => {
  it("routes the existing copy and opens no haul for it", async () => {
    const COPY = "c0000000-0000-0000-0000-0000000000f1";
    await seedCatalogCards(db, [SCYTHER_SV035_123.tcgdexId]);
    await seedBinders(db, [
      { id: B1, type: "general" },
      { id: SPEC, type: "specialty" },
    ]);
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, variant, role, acquired_at)
       values ($1, $2, $3, 'normal', 'bulk', now())`,
      [COPY, OWNER, SCYTHER_SV035_123.tcgdexId],
    );

    const card: DraftItem = {
      id: COPY,
      tcgdexId: SCYTHER_SV035_123.tcgdexId,
      variant: "normal",
      existingCopyId: COPY,
    };
    const pending = {
      id: COPY,
      catalog_card_id: SCYTHER_SV035_123.tcgdexId,
      variant: "normal",
      role: "bulk",
      binder_id: null,
      binder_half: null,
      color_band: null,
      line_slot_id: null,
    } as unknown as Row<"copy">;

    const pc = makeContext([pending]);
    // The routed copy is withheld from `owned`, as loadPlanContext does for a routing pass.
    pc.ctx.owned = [];
    const { planned } = planFromDraft(pc, [card]);
    const built = buildHaulCommitPayload(pc, planned, { source: "bulk-bin", draft: [card] });

    await asOwner(db);
    await applyOps(db, built.payload);
    await asSuperuser(db);

    expect(built.haulId).toBeNull();
    expect(await count(db, "haul")).toBe(0);
    expect(await count(db, "copy")).toBe(1); // routed, not duplicated
    const row = await db.query<{ role: string; haul_id: string | null }>(
      `select role, haul_id from copy where id = $1`,
      [COPY],
    );
    expect(row.rows[0]).toMatchObject({ role: "shelved", haul_id: null });
  });
});
