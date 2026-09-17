/**
 * UIL-045 — the Haul Plan must not show her a pocket the write will not use.
 *
 * The forecast for every worklist row is computed against ONE context that is never advanced between
 * cards (`planFromDraft`). The write is not: per-card commit re-reads the database on every Done, so it
 * sees the cards already shelved this sitting. For any card that interacts with an earlier card in the
 * same haul the two disagree, and when they disagree THE WRITE IS RIGHT.
 *
 * That is why this is not cosmetic. She reads the screen to decide which physical pocket to use. If the
 * screen says "front half" and the write says "bulk", the card goes in the binder, the database records
 * bulk, and nothing ever contradicts anything — a wrong shelf, invisible forever. A wrong write would
 * at least be discoverable.
 *
 * The scenario is deliberately the COMMONEST one rather than the most interesting: two copies of the
 * same card in one haul. `duplicateOf` only consults `role === "shelved"` copies, so at forecast time
 * neither is shelved and both rows read "front half". Shelve the first and the second is a duplicate
 * bound for bulk. No evolution line required — which is why "re-forecast only when a line was created"
 * was rejected as a fix.
 *
 * Written against the REAL `apply_write_ops` RPC on a fresh Postgres (PGlite), as the authenticated
 * owner — the same harness the per-card commit tests use, so "what was written" is read back out of
 * actual rows rather than inferred from the payload.
 *
 * The pre-fix failure is in `the screen agrees with the write`: with only the original forecast to draw
 * from, the row she reads says front-half while the copy row says bulk. The first describe block pins
 * the bug itself and passes either way, so a regression that reintroduces the drift is still caught
 * even if the fix's own API changes shape.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { EngineContext } from "@/lib/engine";
import {
  buildHaulCommitPayload,
  clearCatalogCache,
  commitCardPlacement,
  derivePlacementFrom,
  deriveSpotlightPlacement,
  PlacementChangedError,
  placementDigest,
  planFromDraft,
  type DraftItem,
  type PlanContext,
} from "@/lib/plan";
import type { Row } from "@/lib/repo";
import { NEST_BALL_SV01_181, SCYTHER_SV035_123 } from "../engine/fixtures";
import {
  applyOps,
  asOwner,
  asSuperuser,
  freshRpcDb,
  seedBinders,
  seedCatalogCardsFull,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

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

const CATALOG = [NEST_BALL_SV01_181, SCYTHER_SV035_123];

/** A context holding exactly `owned` — the two calls model "before" and "after" the first Done. */
function makeContext(owned: Row<"copy">[] = []): PlanContext {
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
    now: "2026-09-14T00:00:00.000Z",
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

/** Two copies of the same Trainer — her actual bulk-bin case, and the commonest drift trigger. */
const TWO_NEST_BALLS: DraftItem[] = [
  { id: "d-nb-1", tcgdexId: NEST_BALL_SV01_181.tcgdexId, variant: "normal" },
  { id: "d-nb-2", tcgdexId: NEST_BALL_SV01_181.tcgdexId, variant: "normal" },
];

/** Commit ONE card from a given context, exactly as `commitCardPlacement` does. */
async function shelve(
  db: PGlite,
  pc: PlanContext,
  card: DraftItem,
  haulId: string | null,
): Promise<string | null> {
  const { planned } = planFromDraft(pc, [card]);
  const built = buildHaulCommitPayload(pc, planned, {
    source: "bulk-bin",
    draft: [card],
    existingHaulId: haulId,
  });
  await applyOps(db, built.payload);
  return built.haulId;
}

/** The copy row as the database now holds it, by the catalog card and shelving order. */
async function copyRows(db: PGlite) {
  const res = await db.query<{
    id: string;
    catalog_card_id: string;
    role: string;
    binder_id: string | null;
    binder_half: string | null;
    color_band: string | null;
    line_slot_id: string | null;
    variant: string;
  }>(`select id, catalog_card_id, role, binder_id, binder_half, color_band, line_slot_id, variant
      from copy order by created_at, id`);
  return res.rows;
}

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  // FULL rows, not id-only: `isDuplicateCard` reads set_id/local_id/artwork_group_id, and with those
  // null no card is ever a duplicate — the drift under test could not occur (see seedCatalogCardsFull).
  await seedCatalogCardsFull(db, CATALOG);
  await seedBinders(db, [
    { id: B1, type: "general" },
    { id: SPEC, type: "specialty" },
  ]);
});
afterEach(async () => {
  await db.close();
});

describe("UIL-045 · the drift is real and it points at a physical pocket", () => {
  it("forecasts BOTH copies to the front half, then writes the second to bulk", async () => {
    // (1) The plan she is shown. One context, both cards, nothing advanced between them.
    const pcForecast = makeContext();
    const { items: forecast } = planFromDraft(pcForecast, TWO_NEST_BALLS);
    expect(forecast).toHaveLength(2);
    // Both rows claim the front half — the second one is already wrong and nothing says so.
    expect(forecast[0].action).toBe("FRONT");
    expect(forecast[1].action).toBe("FRONT");
    expect(forecast[1].destination).toContain("Front");

    // (2) She shelves the first card. Real write.
    await asOwner(db);
    const haulId = await shelve(db, pcForecast, TWO_NEST_BALLS[0], null);

    // (3) The second card's write re-reads state, so it now sees a shelved duplicate.
    await asSuperuser(db);
    const afterFirst = await copyRows(db);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].role).toBe("shelved");
    const pcAfter = makeContext(afterFirst as unknown as Row<"copy">[]);

    await asOwner(db);
    await shelve(db, pcAfter, TWO_NEST_BALLS[1], haulId);
    await asSuperuser(db);

    // (4) What actually landed: bulk, not the front half the screen promised.
    const rows = await copyRows(db);
    expect(rows).toHaveLength(2);
    const second = rows[1];
    expect(second.role).toBe("bulk");
    expect(second.binder_id).toBeNull();
    expect(second.color_band).toBeNull();

    // The gap, stated as the assertion: the row she read and the row that exists disagree, and the
    // database is the one that is right. This is the wrong-shelf hazard in one line.
    expect(forecast[1].action).not.toBe("BULK");
  });
});

describe("UIL-045 · the spotlight is re-derived, so the screen agrees with the write", () => {
  it("shows BULK for the second copy once the first is shelved", async () => {
    const pcForecast = makeContext();
    await asOwner(db);
    const haulId = await shelve(db, pcForecast, TWO_NEST_BALLS[0], null);
    await asSuperuser(db);

    const pcAfter = makeContext((await copyRows(db)) as unknown as Row<"copy">[]);

    // What the spotlight now shows for the card she is holding — derived against current state.
    const shown = derivePlacementFrom(pcAfter, TWO_NEST_BALLS[1]);
    expect(shown).not.toBeNull();
    expect(shown!.item.action).toBe("BULK");
    expect(shown!.item.destination).toContain("Bulk");

    // And what the write does with the very same card.
    await asOwner(db);
    await shelve(db, pcAfter, TWO_NEST_BALLS[1], haulId);
    await asSuperuser(db);
    const written = (await copyRows(db))[1];

    // The property the fix exists for: the pocket on screen is the pocket in the database.
    expect(written.role).toBe("bulk");
    expect(written.binder_id).toBeNull();
    expect(shown!.item.action).toBe("BULK");
  });

  it("still shows the FRONT half for a card that nothing this haul affects", async () => {
    // The fix must not make everything read "bulk": a non-interacting card is unchanged, which is
    // what keeps the re-derivation honest rather than merely conservative.
    const pcForecast = makeContext();
    await asOwner(db);
    await shelve(db, pcForecast, TWO_NEST_BALLS[0], null);
    await asSuperuser(db);

    const pcAfter = makeContext((await copyRows(db)) as unknown as Row<"copy">[]);
    const scyther = derivePlacementFrom(pcAfter, {
      id: "d-scyther",
      tcgdexId: SCYTHER_SV035_123.tcgdexId,
      variant: "normal",
    });
    expect(scyther!.item.action).toBe("FRONT");
  });
});

describe("UIL-045 · the digest is what lets the write refuse a stale screen", () => {
  it("changes for the second copy once the first is shelved, and is stable otherwise", async () => {
    const pcForecast = makeContext();
    const stale = derivePlacementFrom(pcForecast, TWO_NEST_BALLS[1])!;

    await asOwner(db);
    await shelve(db, pcForecast, TWO_NEST_BALLS[0], null);
    await asSuperuser(db);
    const pcAfter = makeContext((await copyRows(db)) as unknown as Row<"copy">[]);
    const fresh = derivePlacementFrom(pcAfter, TWO_NEST_BALLS[1])!;

    // Different pocket → different digest. This inequality is the conflict the write detects.
    expect(fresh.digest).not.toBe(stale.digest);
    // Same state → same digest, or every card would false-conflict and the guard would be noise.
    expect(derivePlacementFrom(pcAfter, TWO_NEST_BALLS[1])!.digest).toBe(fresh.digest);
  });

  it("ignores the reason string, so rewording an explanation is not a conflict", () => {
    const pc = makeContext();
    const { planned } = planFromDraft(pc, [TWO_NEST_BALLS[0]]);
    const result = planned[0].result;
    const before = placementDigest(result);
    const reworded = { ...result, reason: "completely different wording", proposals: [] };
    expect(placementDigest(reworded)).toBe(before);
  });
});

/**
 * The guard, end to end: the REAL `commitCardPlacement` against real Postgres through the PGlite
 * `DbClient` shim — real migrations, real RLS, real `apply_write_ops`, real band config.
 *
 * These matter more than the in-memory ones above because they run the production write path rather
 * than a hand-built context, and they run it in DB-KEY band space ("white", not "White"), which is the
 * space production uses and the one a display-band fixture would hide a fault in (UIL-012).
 */
describe("UIL-045 · the write refuses a placement she was not shown", () => {
  beforeEach(() => {
    // Process-local, 5-minute TTL: without this a later test reads the previous test's catalog.
    clearCatalogCache();
  });

  it("writes when the digest still matches", async () => {
    const client = pgliteClient(db);
    await asOwner(db);
    const first = await deriveSpotlightPlacement(client, TWO_NEST_BALLS[0]);
    expect(first).not.toBeNull();

    const res = await commitCardPlacement(client, {
      source: "bulk-bin",
      card: TWO_NEST_BALLS[0],
      expectedDigest: first!.digest,
    });
    await asSuperuser(db);
    expect(res.counts.copies).toBe(1);
    expect((await copyRows(db))[0].role).toBe("shelved");
  });

  it("REFUSES and writes nothing when the pocket moved under her", async () => {
    const client = pgliteClient(db);
    await asOwner(db);

    // The digest she was shown for card two, taken BEFORE card one is shelved — exactly the stale
    // forecast the worklist would still be displaying.
    clearCatalogCache();
    const staleForCardTwo = (await deriveSpotlightPlacement(client, TWO_NEST_BALLS[1]))!;

    // She shelves card one. Card two is now a duplicate.
    clearCatalogCache();
    const firstDigest = (await deriveSpotlightPlacement(client, TWO_NEST_BALLS[0]))!.digest;
    const one = await commitCardPlacement(client, {
      source: "bulk-bin",
      card: TWO_NEST_BALLS[0],
      expectedDigest: firstDigest,
    });

    // Done on card two, still carrying the front-half digest she read off the screen.
    clearCatalogCache();
    await expect(
      commitCardPlacement(client, {
        source: "bulk-bin",
        card: TWO_NEST_BALLS[1],
        haulId: one.haulId,
        expectedDigest: staleForCardTwo.digest,
      }),
    ).rejects.toThrow(PlacementChangedError);

    // Nothing was written for card two — a refusal, not a partial write.
    await asSuperuser(db);
    expect(await copyRows(db)).toHaveLength(1);
  });

  it("hands back the fresh destination, so the panel can show her what changed", async () => {
    const client = pgliteClient(db);
    await asOwner(db);
    clearCatalogCache();
    const stale = (await deriveSpotlightPlacement(client, TWO_NEST_BALLS[1]))!;
    clearCatalogCache();
    const one = await commitCardPlacement(client, { source: "bulk-bin", card: TWO_NEST_BALLS[0] });

    clearCatalogCache();
    let caught: PlacementChangedError | null = null;
    try {
      await commitCardPlacement(client, {
        source: "bulk-bin",
        card: TWO_NEST_BALLS[1],
        haulId: one.haulId,
        expectedDigest: stale.digest,
      });
    } catch (e) {
      caught = e as PlacementChangedError;
    }
    expect(caught).toBeInstanceOf(PlacementChangedError);
    // The fresh row, not just a message — this is what the "was X, now Y" line renders from.
    expect(caught!.fresh?.action).toBe("BULK");
    expect(caught!.actualDigest).not.toBe(stale.digest);
    // And the message names the new destination, because "it changed" alone reads as a bug.
    expect(caught!.message).toContain("Bulk");
  });

  it("does not guard an OVERRIDE, which cannot drift", async () => {
    const client = pgliteClient(db);
    await asOwner(db);
    clearCatalogCache();

    // A deliberately wrong digest. An override is written verbatim by `writeOverriddenCard`, so there
    // is no re-derivation to disagree with and the guard must stay out of the way.
    const res = await commitCardPlacement(client, {
      source: "bulk-bin",
      card: TWO_NEST_BALLS[0],
      override: { kind: "bulk" },
      expectedDigest: "deliberately-not-a-real-digest",
    });
    await asSuperuser(db);
    expect(res.counts.copies).toBe(1);
    expect((await copyRows(db))[0].role).toBe("bulk");
  });

  it("writes unguarded when no digest is offered, so existing callers are unaffected", async () => {
    const client = pgliteClient(db);
    await asOwner(db);
    clearCatalogCache();
    const res = await commitCardPlacement(client, { source: "bulk-bin", card: TWO_NEST_BALLS[0] });
    await asSuperuser(db);
    expect(res.counts.copies).toBe(1);
  });
});

/**
 * The digest's SIDE-EFFECT components (QA finding on #121).
 *
 * `placementDigest` folds in `filledExistingSlot`, `newLine` and `swap` alongside the target, because
 * each changes which physical pocket the card ends up in. None of them had a test: QA mutated them out
 * and 567/567 still passed, so the guard protected only the target. The case that slips is the one where
 * the TARGET IS IDENTICAL and only the side effect differs — a holo arriving where a normal already
 * sits inherits the normal's exact placement, so target-only digests are equal while one write also
 * displaces a card to bulk.
 *
 * Each test below fails if its own component is dropped from the digest.
 */
describe("UIL-045 · the digest covers side effects, not just the pocket", () => {
  const base = { target: { kind: "bulk" } } as unknown as Parameters<typeof placementDigest>[0];

  it("distinguishes a swap from a plain placement with the same target", () => {
    const plain = placementDigest(base);
    const swapped = placementDigest({
      ...base,
      swap: { displacedCopyId: "copy-a", incomingInherits: {} },
    } as unknown as Parameters<typeof placementDigest>[0]);
    expect(swapped).not.toBe(plain);
  });

  it("distinguishes WHICH copy a swap displaces", () => {
    const a = placementDigest({
      ...base,
      swap: { displacedCopyId: "copy-a", incomingInherits: {} },
    } as unknown as Parameters<typeof placementDigest>[0]);
    const b = placementDigest({
      ...base,
      swap: { displacedCopyId: "copy-b", incomingInherits: {} },
    } as unknown as Parameters<typeof placementDigest>[0]);
    // Same pocket for the incoming card, different card sent to bulk. Not the same outcome.
    expect(a).not.toBe(b);
  });

  it("distinguishes filling an existing slot from not filling one", () => {
    const plain = placementDigest(base);
    const filled = placementDigest({
      ...base,
      filledExistingSlot: { lineId: "line-1", stageIndex: 1 },
    } as unknown as Parameters<typeof placementDigest>[0]);
    expect(filled).not.toBe(plain);
  });

  it("distinguishes WHICH line and stage is filled", () => {
    const mk = (lineId: string, stageIndex: number) =>
      placementDigest({
        ...base,
        filledExistingSlot: { lineId, stageIndex },
      } as unknown as Parameters<typeof placementDigest>[0]);
    expect(mk("line-1", 1)).not.toBe(mk("line-2", 1));
    expect(mk("line-1", 1)).not.toBe(mk("line-1", 2));
  });

  it("distinguishes starting a new line from not starting one", () => {
    const plain = placementDigest(base);
    const newLine = placementDigest({
      ...base,
      newLine: { rootDexId: 4, colorBand: "red", slots: [] },
    } as unknown as Parameters<typeof placementDigest>[0]);
    expect(newLine).not.toBe(plain);
  });
});
