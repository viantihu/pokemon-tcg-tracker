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
 *   - a failing card leaves that card's rows out entirely — per-card atomicity survives;
 *   - N sequential per-card commits reach the same database state as one whole-haul commit of the same
 *     N cards, so this is a change of transaction boundary and not of outcome;
 *   - a card whose cascade depends on an earlier card's line still works, because the context is
 *     re-read from the database instead of from an in-payload mirror.
 *
 * Every card is a copy waiting in her haul (UIL-098 part 2), seeded before the commit, which PLACES it.
 * "Not written" therefore means "still in the haul, with no decision" rather than "no copy row". The
 * sitting-is-one-haul case went with the haul row itself: only a hand-typed card ever opened one.
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
  haulRow,
  OWNER,
  referencedCatalogIds,
  seedBinders,
  seedCatalogCards,
  seedHaulRows,
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

/**
 * `haul` is the card(s) being placed: in `copyRowById` but NOT in `owned`, exactly as `loadPlanContext`
 * builds it with `excludeOwnedCopyIds`.
 */
function makeContext(owned: Row<"copy">[] = [], haul: DraftItem[] = []): PlanContext {
  const catalogById = new Map(CATALOG.map((c) => [c.tcgdexId, c]));
  const haulRows = haul.map(
    (d) =>
      ({
        id: d.id,
        catalog_card_id: d.tcgdexId,
        variant: d.variant,
        role: "haul",
        binder_id: null,
        binder_half: null,
        color_band: null,
        line_slot_id: null,
      }) as unknown as Row<"copy">,
  );
  const copyRowById = new Map([...owned, ...haulRows].map((c) => [c.id, c]));
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
  haulRow("d0000000-0000-4000-8000-0000000005c1", SCYTHER_SV035_123.tcgdexId),
  haulRow("d0000000-0000-4000-8000-0000000005c2", EEVEE_SV035_133.tcgdexId),
  haulRow("d0000000-0000-4000-8000-0000000005c3", NEST_BALL_SV01_181.tcgdexId),
];

async function seedFor(db: PGlite, payload: WritePayload, extra: string[] = []): Promise<void> {
  await seedCatalogCards(db, [...referencedCatalogIds(payload), ...extra]);
  await seedBinders(db, [
    { id: B1, type: "general" },
    { id: SPEC, type: "specialty" },
  ]);
  // The whole sitting's haul copies exist before any card is placed, as the import leaves them.
  await seedHaulRows(db, INDEPENDENT);
}

/** Commit one card the way `commitCardPlacement` does, but against a hand-built context. */
function buildCard(card: DraftItem, owned: Row<"copy">[] = []) {
  const pc = makeContext(owned, [card]);
  const { planned } = planFromDraft(pc, [card]);
  return buildHaulCommitPayload(pc, planned, { draft: [card] });
}

/** Catalog ids of the copies that have been placed — out of the haul. */
async function placedIds(db: PGlite): Promise<string[]> {
  const r = await db.query<{ catalog_card_id: string }>(
    `select catalog_card_id from copy where role <> 'haul' order by catalog_card_id`,
  );
  return r.rows.map((row) => row.catalog_card_id);
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
    const { payload } = buildCard(INDEPENDENT[0]);
    await seedFor(
      db,
      payload,
      CATALOG.map((c) => c.tcgdexId),
    );
    await asOwner(db);
    await applyOps(db, payload);
    await asSuperuser(db);

    // The other two cards she has not reached yet must still be waiting, undecided. This is the whole
    // complaint: previously nothing was written until a click that wrote everything.
    expect(await placedIds(db)).toEqual([SCYTHER_SV035_123.tcgdexId]);
    expect(await count(db, "copy where role = 'haul'")).toBe(2);
    expect(await count(db, "placement_decision")).toBe(1);
    // And placing a card from the haul opens no haul row (UIL-098): only a typed card ever did.
    expect(await count(db, "haul")).toBe(0);
  });

  it("a failing card leaves ITS OWN rows out, and the already-shelved cards standing", async () => {
    await seedFor(
      db,
      { ops: [] },
      CATALOG.map((c) => c.tcgdexId),
    );
    await asOwner(db);

    const first = buildCard(INDEPENDENT[0]);
    await applyOps(db, first.payload);

    // Card two poisoned: a copy referencing a catalog row that does not exist — the TEST's op, since the
    // builder no longer emits `insert_copy` (UIL-098).
    const second = buildCard(INDEPENDENT[1]);
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
    expect(await placedIds(db)).toEqual([SCYTHER_SV035_123.tcgdexId]);
    // And card two wrote nothing at all: still in the haul, no decision. Per-card atomicity held.
    const two = await db.query<{ role: string }>(`select role from copy where id = $1`, [
      INDEPENDENT[1].id,
    ]);
    expect(two.rows[0].role).toBe("haul");
    expect(await count(db, "placement_decision")).toBe(1);
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
      const pc = makeContext([], INDEPENDENT);
      const { planned } = planFromDraft(pc, INDEPENDENT);
      return buildHaulCommitPayload(pc, planned, { draft: INDEPENDENT });
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
    await seedFor(
      db,
      { ops: [] },
      CATALOG.map((c) => c.tcgdexId),
    );
    await asOwner(db);
    for (const card of INDEPENDENT) {
      const built = buildCard(card);
      await applyOps(db, built.payload);
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
    const card = haulRow(COPY, SCYTHER_SV035_123.tcgdexId);
    await seedHaulRows(db, [card]);

    // The routed copy is withheld from `owned`, as loadPlanContext does for a routing pass.
    const pc = makeContext([], [card]);
    const { planned } = planFromDraft(pc, [card]);
    const built = buildHaulCommitPayload(pc, planned, { draft: [card] });

    await asOwner(db);
    await applyOps(db, built.payload);
    await asSuperuser(db);

    expect(await count(db, "haul")).toBe(0);
    expect(await count(db, "copy")).toBe(1); // routed, not duplicated
    const row = await db.query<{ role: string; haul_id: string | null }>(
      `select role, haul_id from copy where id = $1`,
      [COPY],
    );
    expect(row.rows[0]).toMatchObject({ role: "shelved", haul_id: null });
  });
});
