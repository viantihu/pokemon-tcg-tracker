/**
 * Every loader of the whole catalog reads it through the ONE shared cache (lib/plan/catalog-cache.ts), gets the same
 * answer it got from its own full read, and never writes to the shared rows. Real code, real Postgres (PGlite, every
 * migration), as the owner.
 *
 * WHY (the Tech Lead's measurement on her real data, a production build): the full catalog (36,334 rows, ~25 MB of
 * JSON) was re-downloaded in 38 sequential pages by NINE loaders that bypassed the cache only `loadPlanContext` and
 * Backfill used: ~76% of all app database time on Testing, ~2.5 s each. A Haul Plan "Confirm & next" on a line card
 * did two of them; a Lines Move into a line, three or four.
 *
 * THREE THINGS, each pinned here for each loader:
 *  1. SAME ANSWER. Run with the catalog read as it was (`catalogCardRepo.listAll`, swapped in below), then from the
 *     cache cold and warm: the loader's whole result is identical, and a write sends the identical payload and leaves
 *     the identical rows. Her own stand-in rides along (the cache merges hers in fresh on every call), placed in the
 *     Emberdrake family between the mirror's two printings by id, so a read in a different order is in play.
 *  2. ONE READ. With the cache warm, a loader asks the catalog table for her stand-ins only: no mirror page, no full
 *     read. A loader put back on its own full read fails here, whatever it returns.
 *  3. NO WRITES TO SHARED ROWS. Outside production the cache hands out FROZEN rows (each row, its arrays, the array),
 *     so a loader that writes to one throws here instead of corrupting every later request on the instance.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { listSetOptions, loadCollHub } from "@/app/(ui)/coll/actions";
import { setTypeBand } from "@/app/(ui)/settings/actions";
import { loadBackfillContext } from "@/lib/backfill";
import { applyMove, loadLineScreen, type MoveNameLookups } from "@/lib/line";
import { loadFamilyLines, loadLinePopupModel } from "@/lib/line/popup-load";
import { loadLineStagesModel } from "@/lib/line/stages-load";
import { applyStageDecisions } from "@/lib/line/write";
import {
  clearCatalogCache,
  commitCardPlacement,
  loadCatalogCached,
  loadPlanContext,
  planFromDraft,
} from "@/lib/plan";
import type { DbClient } from "@/lib/repo";
import { asOwner, asSuperuser, freshRpcDb, haulRow, OWNER } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";
import { HP, seedHotPaths } from "../support/hot-path-fixture";
import { recordingClient as recorded } from "../support/recording-client";

/** `uncached`: the catalog is read as the nine loaders read it before, straight from the table, every call. */
const mode = vi.hoisted(() => ({ uncached: false }));
vi.mock("@/lib/plan/catalog-cache", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/plan/catalog-cache")>();
  const { catalogCardRepo } = await import("@/lib/repo");
  return {
    ...real,
    loadCatalogCached: (db: DbClient, options?: Parameters<typeof real.loadCatalogCached>[1]) =>
      mode.uncached ? catalogCardRepo.listAll(db) : real.loadCatalogCached(db, options),
  };
});

let db: PGlite;
/** The client the session seam hands a server action (Collections, Settings). */
let session: DbClient;
vi.mock("@/lib/plan/session", () => ({
  getOwnerContext: async () => ({ db: session, ownerId: OWNER }),
}));

/** A write payload, its NEW ids (generated per run) named by first appearance; every seeded id kept as it is. */
function normalized(payloads: unknown[]): unknown {
  const known = new Set(Object.values(HP).filter((v) => typeof v === "string") as string[]);
  const fresh = new Map<string, string>();
  return JSON.parse(
    JSON.stringify(payloads).replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      (id) => {
        if (known.has(id) || [...known].some((k) => k.endsWith(id))) return id;
        if (!fresh.has(id)) fresh.set(id, `new#${fresh.size + 1}`);
        return fresh.get(id)!;
      },
    ),
  );
}

const STANDINS_ONLY = [["source=user"]];

describe("the read loaders: the same answer from the shared, frozen cache, and one catalog read", () => {
  beforeAll(async () => {
    db = await freshRpcDb();
    await seedHotPaths(db);
  });
  afterAll(async () => {
    await db.close();
  });

  /**
   * Today's read, then the cache cold (its first load, frozen) and warm (served from memory, frozen): all three
   * answers equal. Then once more, warm, recording what it asks the catalog table.
   */
  async function sameAnswer<T>(run: (client: DbClient) => Promise<T>): Promise<void> {
    mode.uncached = true;
    session = pgliteClient(db);
    const before = await run(session);
    mode.uncached = false;
    clearCatalogCache();
    session = pgliteClient(db);
    const cold = await run(session);
    const warm = await run(session);
    expect(cold).toEqual(before);
    expect(warm).toEqual(before);
    const rec = recorded(pgliteClient(db));
    session = rec.db;
    await run(rec.db);
    expect(rec.catalogReads()).toEqual(STANDINS_ONLY);
  }

  it("the cache's rows are frozen here, each with its arrays, and her stand-in is in them", async () => {
    clearCatalogCache();
    const rows = await loadCatalogCached(pgliteClient(db));
    expect(Object.isFrozen(rows)).toBe(true);
    const mirror = rows.find((r) => r.tcgdex_id === HP.EMBERDRAKE)!;
    expect(Object.isFrozen(mirror)).toBe(true);
    expect(Object.isFrozen(mirror.dex_id)).toBe(true);
    expect(() => {
      (mirror as { name: string }).name = "Changed";
    }).toThrow(TypeError);
    expect(rows.map((r) => r.tcgdex_id)).toContain(HP.STAND_IN);
  });

  it("Lines (lib/line/load.ts: the line screen)", async () => {
    await sameAnswer((c) => loadLineScreen(c));
  });

  it("the line popup (lib/line/popup-load.ts: an Add, and a Start)", async () => {
    await sameAnswer((c) =>
      loadLinePopupModel(c, HP.HAUL_DRAKE, { kind: "add", lineId: HP.LINE, slotId: HP.SL1 }),
    );
    await sameAnswer((c) =>
      loadLinePopupModel(c, HP.FRONT_DRAKE, { kind: "start", binderId: HP.GEN, band: "red" }),
    );
  });

  it("Backfill's family list (lib/line/popup-load.ts: loadFamilyLines)", async () => {
    await sameAnswer((c) => loadFamilyLines(c, HP.EMBERDRAKE, { binderId: HP.GEN, band: "red" }));
  });

  it("Lines' Choose (lib/line/stages-load.ts)", async () => {
    await sameAnswer((c) => loadLineStagesModel(c, HP.LINE));
  });

  it("the Collections hub (app/(ui)/coll/actions.ts)", async () => {
    await sameAnswer(() => loadCollHub());
  });

  it("the search grid's set filter (app/(ui)/coll/actions.ts: listSetOptions)", async () => {
    await sameAnswer(() => listSetOptions());
  });

  it("Backfill's context (lib/backfill/context.ts)", async () => {
    await sameAnswer((c) => loadBackfillContext(c));
  });

  it("the Haul Plan's context (lib/plan/context.ts), and the plan run over it", async () => {
    await sameAnswer(async (c) => {
      const pc = await loadPlanContext(c, { excludeOwnedCopyIds: [HP.HAUL_DRAKE] });
      const { ctx, lookups, catalogById, ...rest } = pc;
      const { catalog } = ctx;
      // `now` is the clock, not the context.
      const engine = { ...ctx, catalog: undefined, now: undefined };
      return {
        // The one difference, and it is order: the cache lists her stand-ins after the mirror (the order the cascade
        // has always read), where a full-table read put hers among them by id. The same cards, as a set:
        catalog: [...catalog].sort((a, b) => a.tcgdexId.localeCompare(b.tcgdexId)),
        catalogById: [...catalogById.entries()].sort(([a], [b]) => a.localeCompare(b)),
        // ...and everything else, exactly: what the context holds, and what the cascade decides over it.
        engine,
        rest,
        lineName: lookups.lines?.lineName?.(HP.LINE),
        plan: planFromDraft(pc, [haulRow(HP.HAUL_DRAKE, HP.EMBERDRAKE)]),
      };
    });
  });

  it("the cache's order: the mirror by id, then her stand-ins (a full-table read interleaved them by id)", async () => {
    mode.uncached = true;
    const before = (await loadCatalogCached(pgliteClient(db))).map((r) => r.tcgdex_id);
    mode.uncached = false;
    clearCatalogCache();
    const cached = (await loadCatalogCached(pgliteClient(db))).map((r) => r.tcgdex_id);
    expect([...cached].sort()).toEqual([...before].sort());
    expect(cached.at(-1)).toBe(HP.STAND_IN);
    expect(before.indexOf(HP.STAND_IN)).toBeLessThan(before.indexOf(HP.EMBERDRAKE_XY));
  });
});

describe("the write paths: the same payload and the same rows from the shared, frozen cache, and one catalog read", () => {
  const names: MoveNameLookups = {
    binderName: () => "KB-001",
    collectionName: () => "Sparkmice",
    bandDisplay: (k) => k,
  };
  /** What a write leaves behind, without the ids and times the database makes up per run. */
  async function rowsAfter() {
    await asSuperuser(db);
    const read = async (sql: string) => (await db.query(sql)).rows;
    const out = {
      copies: await read(
        `select id, role, binder_id, binder_half, color_band, line_slot_id from copy order by id`,
      ),
      lines: await read(
        `select id, status, color_band, extra_pocket from evolution_line order by id`,
      ),
      slots: await read(
        `select id, state, copy_id, target_catalog_card_id, stage_choice from line_slot order by id`,
      ),
      wishes: await read(
        `select line_slot_id, chosen_catalog_card_id, resolved_at is null as open from wishlist_item order by line_slot_id`,
      ),
      decisions: await read(
        `select decision, reason, copy_id, line_slot_id from placement_decision order by decision, copy_id`,
      ),
    };
    await asOwner(db);
    return out;
  }

  /** The write on a fresh database, with the catalog read as it was, then with the cache warm and frozen. */
  async function sameWrite(run: (client: DbClient) => Promise<unknown>): Promise<void> {
    const runs: unknown[] = [];
    for (const uncached of [true, false]) {
      db = await freshRpcDb();
      await seedHotPaths(db);
      clearCatalogCache();
      mode.uncached = uncached;
      // Warm, as her second write of a sitting finds it: the loader is handed the cache's own frozen rows.
      if (!uncached) await loadCatalogCached(pgliteClient(db));
      const rec = recorded(pgliteClient(db));
      session = rec.db;
      const result = await run(rec.db);
      runs.push({ result, payloads: normalized(rec.rpcs), rows: await rowsAfter() });
      if (!uncached) expect(rec.catalogReads()).toEqual(STANDINS_ONLY);
      await db.close();
    }
    expect(runs[1]).toEqual(runs[0]);
  }

  it("a Move into her line (lib/line/write.ts: the line builder's state)", async () => {
    await sameWrite((c) =>
      applyMove(
        c,
        {
          copyId: HP.FRONT_DRAKE,
          destination: { kind: "shelf", binderId: HP.GEN, half: "back", band: "red" },
          lineChoice: { mode: "join", lineId: HP.LINE, slotId: HP.SL1 },
        },
        names,
      ),
    );
  });

  it("Lines' Choose, written (lib/line/write.ts: applyStageDecisions)", async () => {
    await sameWrite((c) =>
      applyStageDecisions(c, {
        lineId: HP.LINE,
        stages: { 1: { kind: "chase", catalogCardId: HP.EMBERDRAKE_XY } },
      }),
    );
  });

  it("Settings' type → band edit (app/(ui)/settings/actions.ts)", async () => {
    await sameWrite(() => setTypeBand("Fire", "orange"));
  });

  it("the Haul Plan's line confirm reads the catalog ONCE: its own context, never a second load", async () => {
    await sameWrite((c) =>
      commitCardPlacement(c, {
        card: haulRow(HP.HAUL_DRAKE, HP.EMBERDRAKE),
        lineChoice: { mode: "join", lineId: HP.LINE, slotId: HP.SL1 },
      }),
    );
  });
});
