/**
 * PostgREST's 1,000-row cap on her hot paths, on real Postgres (PGlite, every migration) with the cap ON
 * (`pgliteClient(db, { maxRows: 1000 })`, which cuts a read exactly as Supabase does).
 *
 * THE BUG. `createRepo().list()` is ONE unpaged read that throws once its table passes the cap (UIL-031's
 * `assertReadComplete`), and `copyRepo.list` sat on seven paths. She has 695 copies, so one import of ~300 cards
 * broke Collections, every line popup, Lines' Replace and every line write: none of the tests could see it, because
 * the shim had no cap. Lines and slots were next, read the same way on the same paths, and `wishlistItemRepo.listOpen` read with no
 * count, so past the cap it came back SHORT, silently: wishes missing from Collections, no error anywhere.
 *
 * Each flow here ran against 1,001 more copies, lines (2,002 slots) and open wishes than the cap allows: each threw,
 * or (the wishlist) dropped rows, before this change, and each completes with every row now.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { loadCollHub } from "@/app/(ui)/coll/actions";
import { applyMove, type MoveNameLookups } from "@/lib/line";
import { loadFamilyLines, loadLinePopupModel } from "@/lib/line/popup-load";
import { listReplaceCandidates } from "@/lib/line/replace-candidates";
import { loadLineStagesModel } from "@/lib/line/stages-load";
import { applyStageDecisions } from "@/lib/line/write";
import { clearCatalogCache, commitCardPlacement } from "@/lib/plan";
import {
  copyRepo,
  evolutionLineRepo,
  lineSlotRepo,
  wishlistItemRepo,
  type DbClient,
} from "@/lib/repo";
import { asOwner, asSuperuser, freshRpcDb, haulRow, OWNER } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";
import { HP, seedHotPaths } from "../support/hot-path-fixture";

let db: PGlite;
/** The client every path gets: PostgREST's cap, as Supabase serves it. */
const capped = (): DbClient => pgliteClient(db, { maxRows: 1000 });
vi.mock("@/lib/plan/session", () => ({
  getOwnerContext: async () => ({ db: capped(), ownerId: OWNER }),
}));

const names: MoveNameLookups = {
  binderName: () => "KB-001",
  collectionName: () => "Sparkmice",
  bandDisplay: (k) => k,
};
const BACK = { kind: "shelf", binderId: HP.GEN, half: "back", band: "red" } as const;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  await asSuperuser(db);
  const rows = (await db.query<T>(sql, params)).rows;
  await asOwner(db);
  return rows;
}
const slot1 = () =>
  q<{ state: string; copy_id: string | null; stage_choice: string | null }>(
    `select state, copy_id, stage_choice from line_slot where id = $1`,
    [HP.SL1],
  ).then((r) => r[0]);

beforeEach(async () => {
  db = await freshRpcDb();
  await seedHotPaths(db, { big: true });
  clearCatalogCache();
});
afterEach(async () => {
  await db.close();
});

describe("the shim cuts a read the way PostgREST does (opt-in)", () => {
  it("an un-ranged read stops at the cap while count still says the true total; a range asking for more gets the cap", async () => {
    const all = 1 + HP.BIG + 3; // her haul Emberdrake, the 1,001, and three shelved copies
    const { data, count } = await capped().from("copy").select("*", { count: "exact" });
    expect(data).toHaveLength(1000);
    expect(count).toBe(all);
    const ranged = await capped().from("copy").select("*").order("id").range(0, 1999);
    expect(ranged.data).toHaveLength(1000);
    // Off by default: every other test reads uncut, as before.
    expect((await pgliteClient(db).from("copy").select("*")).data).toHaveLength(all);
  });

  it("so a single-page `list()` throws by name past the cap, and `listAll` pages past it", async () => {
    await expect(copyRepo.list(capped())).rejects.toThrow(/copy: read 1000 of 1005 row\(s\)/);
    await expect(evolutionLineRepo.list(capped())).rejects.toThrow(/evolution_line: read 1000 of/);
    await expect(lineSlotRepo.list(capped())).rejects.toThrow(/line_slot: read 1000 of/);
    expect(await copyRepo.listAll(capped())).toHaveLength(1005);
    expect(await lineSlotRepo.listAll(capped())).toHaveLength(3 + 2 * HP.BIG);
  });
});

describe("every hot path completes past the cap, with every row", () => {
  it("Collections: the hub loads, and lists EVERY open wish (it came back short at 1,000)", async () => {
    expect(await wishlistItemRepo.listOpen(capped())).toHaveLength(1 + HP.BIG);
    const hub = await loadCollHub();
    expect(hub.wishlist.entries).toHaveLength(1 + HP.BIG);
    const col = hub.collections.find((c) => c.id === HP.COL)!;
    expect(col.ownedCount).toBe(1);
    expect(col.totalCount).toBe(2);
  });

  it("the line popup loads (an Add into her line), and so does Backfill's family list", async () => {
    const model = await loadLinePopupModel(capped(), HP.HAUL_DRAKE, {
      kind: "add",
      lineId: HP.LINE,
      slotId: HP.SL1,
    });
    expect(model.mode).toBe("add");
    expect(model.stages.map((s) => s.state)).toEqual(["here", "incoming", "wanted"]);
    const family = await loadFamilyLines(capped(), HP.EMBERDRAKE, {
      binderId: HP.GEN,
      band: "red",
    });
    expect(family.map((l) => l.lineId)).toEqual([HP.LINE]);
  });

  it("a line write: a Move into her line lands the card in the slot", async () => {
    await applyMove(
      capped(),
      {
        copyId: HP.FRONT_DRAKE,
        destination: BACK,
        lineChoice: { mode: "join", lineId: HP.LINE, slotId: HP.SL1 },
      },
      names,
    );
    expect(await slot1()).toMatchObject({ state: "filled", copy_id: HP.FRONT_DRAKE });
  });

  it("Lines' Replace this card: the candidates load", async () => {
    const res = await listReplaceCandidates(capped(), HP.SL0);
    expect(res).toMatchObject({ ok: true, slotCardName: "Emberling" });
  });

  it("Lines' Choose: the popup loads, and her choice is written", async () => {
    const model = await loadLineStagesModel(capped(), HP.LINE);
    expect(model.stages).toHaveLength(3);
    await applyStageDecisions(capped(), { lineId: HP.LINE, stages: { 1: { kind: "empty" } } });
    expect(await slot1()).toMatchObject({ state: "placeholder", stage_choice: "empty" });
  });

  it("the Haul Plan's line confirm: her Emberdrake joins the line", async () => {
    const res = await commitCardPlacement(capped(), {
      card: haulRow(HP.HAUL_DRAKE, HP.EMBERDRAKE),
      lineChoice: { mode: "join", lineId: HP.LINE, slotId: HP.SL1 },
    });
    expect(await slot1()).toMatchObject({ state: "filled", copy_id: HP.HAUL_DRAKE });
    expect(res.line?.lineId).toBe(HP.LINE);
  });
});
