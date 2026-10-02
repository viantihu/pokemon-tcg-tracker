/**
 * UIL-117 PR 2 — removing a card from a collection INTO A BACK HALF, through her line popup choice. PR 1 refused a
 * back-half destination here outright (gap 3: the removal wrote no line, so the card landed on no line). Now the
 * popup's choice rides with the removal and the line is written in the SAME `apply_write_ops` call, so the card is
 * never off the list and on no line. A line slot holds one card, so it takes exactly one copy.
 *
 * Real modules, real Postgres (PGlite, every migration, 0028's slot check included), as the authenticated owner.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyCollectionRemoval } from "@/lib/coll";
import { clearCatalogCache } from "@/lib/plan";
import type { MoveNameLookups } from "@/lib/line";
import type { LineChoice } from "@/lib/line/popup";
import {
  asOwner,
  asSuperuser,
  freshRpcDb,
  orphanedCopies,
  OWNER,
  seedBinders,
  seedCollections,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const SPEC = "b0000000-0000-4000-8000-0000000117c1";
const GEN = "b0000000-0000-4000-8000-0000000117c2";
const COL = "a0000000-0000-4000-8000-0000000117c1";
const COPY = "c0000000-0000-4000-8000-0000000117c1";
const COPY2 = "c0000000-0000-4000-8000-0000000117c2";

const names: MoveNameLookups = {
  binderName: (id) => (id === GEN ? "KB-001" : "Specialty A"),
  collectionName: () => null,
  bandDisplay: (k) => k.toUpperCase(),
};
/** UIL-121: she leaves the new line's Stage 1 empty, her choice. */
const START: LineChoice = {
  mode: "start",
  binderId: GEN,
  band: "red",
  pulls: [],
  stages: { 1: { kind: "empty" } },
};

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await db.query(
    `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from, card_class, locale)
       values ('emberling', 'Emberling', '{9301}', '{Fire}', 'Basic', null, 'standard', 'en'),
              -- UIL-121: a line has two stages or more, so the Emberling's family has its Stage 1.
              ('emberdrake', 'Emberdrake', '{9302}', '{Fire}', 'Stage1', 'Emberling', 'standard', 'en')`,
  );
  await seedBinders(db, [
    { id: SPEC, type: "specialty", name: "Specialty A" },
    { id: GEN, type: "general", name: "KB-001" },
  ]);
  await seedCollections(db, [
    { id: COL, name: "Starters", targetCatalogCardIds: ["emberling"], currentBinderIds: [SPEC] },
  ]);
});
afterEach(async () => {
  await db.close();
});

async function shelveInCollection(id: string) {
  await asSuperuser(db);
  await db.query(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
       values ($1, $2, 'emberling', 'shelved', $3, 'front', 'red')`,
    [id, OWNER, SPEC],
  );
  await asOwner(db);
}
async function q<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  await asSuperuser(db);
  const rows = (await db.query<T>(sql, params)).rows;
  await asOwner(db);
  return rows;
}
const remove = (lineChoice?: LineChoice) =>
  applyCollectionRemoval(
    pgliteClient(db),
    {
      collectionId: COL,
      tcgdexId: "emberling",
      destination: { kind: "shelf", binderId: GEN, half: "back", band: "red" },
      lineChoice,
    },
    names,
  );
const targets = async () =>
  (
    await q<{ t: string[] }>(`select target_catalog_card_ids t from collection where id = $1`, [
      COL,
    ])
  )[0].t;

describe("UIL-117 PR 2 · Collections → a back half, through the line popup", () => {
  it("one copy, with her choice: off the list AND into a line, in one write", async () => {
    await shelveInCollection(COPY);
    await remove(START);
    expect(await targets()).toEqual([]);
    const [copy] = await q<{
      binder_id: string;
      binder_half: string;
      color_band: string;
      line_slot_id: string | null;
    }>(`select binder_id, binder_half, color_band, line_slot_id from copy where id = $1`, [COPY]);
    expect(copy).toMatchObject({ binder_id: GEN, binder_half: "back", color_band: "red" });
    expect(copy.line_slot_id).not.toBeNull();
    // The two-sided invariant (UIL-087): the slot the copy names names the copy back, filled.
    const [slot] = await q<{ state: string; copy_id: string }>(
      `select state, copy_id from line_slot where id = $1`,
      [copy.line_slot_id],
    );
    expect(slot).toEqual({ state: "filled", copy_id: COPY });
    expect(await orphanedCopies(db)).toEqual([]);
  });

  it("a choice for another colour band than the destination: refused, nothing written (QA on #385)", async () => {
    await shelveInCollection(COPY);
    await expect(remove({ ...START, band: "dark_blue" } as LineChoice)).rejects.toThrow(
      /another colour band than the one this card is moving to/,
    );
    expect(await targets()).toEqual(["emberling"]);
    expect(
      await q(`select binder_id, binder_half, color_band from copy where id = $1`, [COPY]),
    ).toEqual([{ binder_id: SPEC, binder_half: "front", color_band: "red" }]);
    expect(await q(`select id from evolution_line`)).toEqual([]);
  });

  it("with no choice: refused before any write, the card still on the list and where it was", async () => {
    await shelveInCollection(COPY);
    await expect(remove()).rejects.toThrow(/back half needs a line/);
    expect(await targets()).toEqual(["emberling"]);
    expect(await q(`select binder_id, binder_half from copy where id = $1`, [COPY])).toEqual([
      { binder_id: SPEC, binder_half: "front" },
    ]);
    expect(await q(`select id from evolution_line`)).toEqual([]);
  });

  it("two copies here: refused (a line holds one), pointing her to Lookup, and nothing is written", async () => {
    await shelveInCollection(COPY);
    await shelveInCollection(COPY2);
    await expect(remove(START)).rejects.toThrow(
      "There are 2 copies of this card here, and a line holds one. Move each one from Lookup.",
    );
    expect(await targets()).toEqual(["emberling"]);
    expect(await q(`select id from evolution_line`)).toEqual([]);
  });

  it("no copy here (a list-only target): refused, since there is nothing to put in a line", async () => {
    await asOwner(db);
    await expect(remove(START)).rejects.toThrow(/You hold no copy of this card/);
    expect(await targets()).toEqual(["emberling"]);
  });
});

describe("UIL-135 · Collections → a line of one card, with her “Put it here anyway”", () => {
  const COL2 = "a0000000-0000-4000-8000-0000000117c2";
  const LONER_COPY = "c0000000-0000-4000-8000-0000000117c3";
  beforeEach(async () => {
    await asSuperuser(db);
    // A Basic with no evolutions (a Tauros-type card), in a collection of its own.
    await db.query(
      `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from, card_class, locale)
         values ('loneling', 'Loneling', '{9401}', '{Fire}', 'Basic', null, 'standard', 'en')`,
    );
    await seedCollections(db, [
      { id: COL2, name: "Loners", targetCatalogCardIds: ["loneling"], currentBinderIds: [SPEC] },
    ]);
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
         values ($1, $2, 'loneling', 'shelved', $3, 'front', 'red')`,
      [LONER_COPY, OWNER, SPEC],
    );
    // Every catalog read goes through the shared cache (#461): this test's card is new to it.
    clearCatalogCache();
    await asOwner(db);
  });
  const removeLoner = (overrides?: ["line_min_stages"]) =>
    applyCollectionRemoval(
      pgliteClient(db),
      {
        collectionId: COL2,
        tcgdexId: "loneling",
        destination: { kind: "shelf", binderId: GEN, half: "back", band: "red" },
        lineChoice: {
          mode: "start",
          binderId: GEN,
          band: "red",
          pulls: [],
          stages: {},
          thirdPocket: { material: "empty" },
          ...(overrides ? { overrides } : {}),
        },
      },
      names,
    );

  it("refused without her say, nothing written; with it, a one-card line, recorded on the removal's decision", async () => {
    await expect(removeLoner()).rejects.toThrow(/can't start a line/);
    expect(await q(`select id from evolution_line`)).toEqual([]);
    await removeLoner(["line_min_stages"]);
    expect(
      await q(
        `select (select count(*)::int from line_slot s where s.line_id = l.id) n from evolution_line l`,
      ),
    ).toEqual([{ n: 1 }]);
    expect(
      await q(`select decision, overrides from placement_decision where overrides <> '{}'`),
    ).toEqual([{ decision: "collection-remove", overrides: ["line_min_stages"] }]);
  });
});
