/**
 * UIL-119 — an empty line stage goes on her wishlist ONLY when she adds it (Karvi's ruling). The Haul Plan's old
 * cascade writer wished every empty stage of a line it started; since UIL-117 the Haul Plan writes lines through the
 * line popup's builder, which wishes nothing, and the old writer's wish loop is gone too. Real cascade, real commit,
 * real `apply_write_ops` on PGlite, as the owner.
 *
 * Her Charmeleon starts a Charmander line: Charmander (Basic) is hers in the front half, Charizard (Stage 2) she has
 * not got, so the line has an empty stage the old writer would have wished.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { CatalogCard } from "@/lib/engine";
import {
  buildHaulCommitPayload,
  clearCatalogCache,
  commitCardPlacement,
  deriveSpotlightPlacement,
  existingCopyIds,
  loadPlanContext,
  planFromDraft,
  type DraftItem,
} from "@/lib/plan";
import { CHARMANDER_SV03_026, CHARMELEON_SV03_027 } from "../engine/fixtures";
import {
  asOwner,
  asSuperuser,
  freshRpcDb,
  haulRow,
  OWNER,
  seedBinders,
  seedCatalogCardsFull,
  seedHaulRows,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const KB1 = "1c000000-0000-0000-0000-0000000000b1";
const OWNED_CMD = "c0000000-0000-0000-0000-0000000000b0";
const CHARIZARD: CatalogCard = {
  ...CHARMELEON_SV03_027,
  tcgdexId: "sv03-028",
  name: "Charizard",
  dexId: [6],
  localId: "028",
  stage: "Stage2",
  evolveFrom: "Charmeleon",
  artworkGroupId: "art-sv03-028",
};
const CML: DraftItem = haulRow(
  "d0000000-0000-4000-8000-0000000000b1",
  CHARMELEON_SV03_027.tcgdexId,
);

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedCatalogCardsFull(db, [CHARMANDER_SV03_026, CHARMELEON_SV03_027, CHARIZARD]);
  await seedBinders(db, [{ id: KB1, type: "general", name: "KB-001" }]);
  await db.exec(`
    insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band) values
      ('${OWNED_CMD}', '${OWNER}', '${CHARMANDER_SV03_026.tcgdexId}', 'normal', 'shelved', '${KB1}', 'front', 'red');
  `);
  await seedHaulRows(db, [CML]);
  clearCatalogCache();
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

const wishes = async () => {
  await asSuperuser(db);
  const n = (await db.query<{ n: number }>(`select count(*)::int n from wishlist_item`)).rows[0].n;
  await asOwner(db);
  return n;
};

describe("UIL-119 · a Haul Plan line never wishes an empty stage", () => {
  it("the old cascade writer: no insert_wishlist, although the cascade proposed one", async () => {
    const pc = await loadPlanContext(pgliteClient(db), {
      excludeOwnedCopyIds: existingCopyIds([CML]),
    });
    const { planned } = planFromDraft(pc, [CML]);
    expect(planned[0].result.step).toBe("line-new");
    // The cascade still PROPOSES a wish for the empty Charizard stage; that is what used to be written.
    expect(planned[0].result.wishlist?.length ?? 0).toBeGreaterThan(0);
    const { payload, counts } = buildHaulCommitPayload(pc, planned, { draft: [CML] });
    // PRE-FIX: one insert_wishlist per empty stage.
    expect(payload.ops.filter((o) => o.op === "insert_wishlist")).toEqual([]);
    expect(counts.wishlist).toBe(0);
  });

  it("through the Haul Plan's commit: her started line leaves its empty stages empty, on no wishlist", async () => {
    const spot = await deriveSpotlightPlacement(pgliteClient(db), CML);
    const p = spot?.item.lineProposal;
    if (p?.kind !== "start") throw new Error(`expected a start proposal, got ${p?.kind}`);
    await commitCardPlacement(pgliteClient(db), {
      card: CML,
      lineChoice: {
        mode: "start",
        binderId: p.binderId ?? "",
        band: p.band,
        pulls: [],
        // UIL-121: she leaves every other stage empty (a choice for a stage the line does not have is not read).
        stages: { 0: { kind: "empty" }, 2: { kind: "empty" } },
      },
    });
    await asSuperuser(db);
    const states = (
      await db.query<{ state: string }>(`select state from line_slot order by stage_index`)
    ).rows.map((r) => r.state);
    await asOwner(db);
    expect(states).toContain("placeholder"); // the line has empty stages
    expect(await wishes()).toBe(0);
  });
});
