/**
 * UIL-098, Backfill half — Backfill places the copies her Dex import left waiting, and creates none.
 *
 * Karvi: "If adding cards in the haul plan will cause data integrity issues, that option should not
 * exist" — applied by function to all three hand creators; this is the last. Backfill transcribes a binder
 * she already has, and it made a new copy for every card she named, in no presence group, so her next Dex
 * import created a second copy of every one. Now each card she names is a (printing, Dex variant) waiting
 * in her haul; the server places the oldest waiting copies of that key and refuses, before writing
 * anything, a save that asks for a card that is not waiting.
 *
 * The Senior BA's rulings (2026-09-25), each pinned below:
 *   - a LINE naming a card that is not waiting is refused, and only that line: the front half, specialty
 *     and other lines still save (the screen keeps her entries; tests/backfill/haul-picker.dom.test.ts);
 *   - "waiting" is ONE definition, the Haul Plan's queue (`loadPendingPlacements`), not a second copy;
 *   - the refusal names each card and its variant.
 *
 * The REAL executors (`commitFrontHalf` / `commitBackLine` / `commitSpecialty`) against real Postgres
 * (PGlite) and the real `apply_write_ops`, as the authenticated owner.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { commitBackLine, commitFrontHalf, commitSpecialty } from "@/lib/backfill";
import { clearCatalogCache, loadPendingPlacements } from "@/lib/plan";
import {
  ARVEN_SV03_186,
  CHARMANDER_SV03_026,
  CHARMELEON_SV03_027,
  SCIZOR_SV03_141,
} from "../engine/fixtures";
import {
  asOwner,
  asSuperuser,
  count,
  freshRpcDb,
  OWNER,
  seedBinders,
  seedCatalogCardsFull,
  seedCollections,
  seedHaulCopies,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const B1 = "1c000000-0000-0000-0000-0000000000b1";
const SPEC = "1c000000-0000-0000-0000-00000000c5ec";
const COLL = "c0111111-0000-0000-0000-0000000000c1";

// Ids chosen so the OLDER copy has the LARGER id: "oldest first" must come from created_at, not id order.
const OLD_CHARMANDER = "f0000000-0000-4000-8000-00000000000f";
const NEW_CHARMANDER = "10000000-0000-4000-8000-000000000001";
const REVERSE_CHARMANDER = "20000000-0000-4000-8000-000000000002";
const SCIZOR = "30000000-0000-4000-8000-000000000003";

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedCatalogCardsFull(db, [
    CHARMANDER_SV03_026,
    CHARMELEON_SV03_027,
    SCIZOR_SV03_141,
    ARVEN_SV03_186,
  ]);
  await seedBinders(db, [
    { id: B1, type: "general", name: "Binder 1" },
    { id: SPEC, type: "specialty", name: "Specialty A" },
  ]);
  await seedCollections(db, [{ id: COLL, name: "Fire starters" }]);
  await seedHaulCopies(db, [
    { id: OLD_CHARMANDER, catalogCardId: CHARMANDER_SV03_026.tcgdexId, dexVariantRaw: "Normal" },
    { id: NEW_CHARMANDER, catalogCardId: CHARMANDER_SV03_026.tcgdexId, dexVariantRaw: "Normal" },
    {
      id: REVERSE_CHARMANDER,
      catalogCardId: CHARMANDER_SV03_026.tcgdexId,
      variant: "reverse",
      dexVariantRaw: "Reverse Holo",
    },
    { id: SCIZOR, catalogCardId: SCIZOR_SV03_141.tcgdexId, variant: "holo", dexVariantRaw: "Holo" },
  ]);
  await db.query(
    `update copy set created_at = case id
       when $1::uuid then timestamptz '2026-09-01' when $2::uuid then timestamptz '2026-09-02'
       else timestamptz '2026-09-03' end`,
    [OLD_CHARMANDER, NEW_CHARMANDER],
  );
  clearCatalogCache();
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

interface CopyState {
  id: string;
  role: string;
  binder_id: string | null;
  binder_half: string | null;
  grouped: boolean;
}
async function copies(): Promise<CopyState[]> {
  await asSuperuser(db);
  const r = await db.query<CopyState>(
    `select id, role, binder_id, binder_half, presence_group_id is not null as grouped
       from copy order by id`,
  );
  await asOwner(db);
  return r.rows;
}
const roleOf = async (id: string) => (await copies()).find((c) => c.id === id)?.role;
async function tally(table: string): Promise<number> {
  await asSuperuser(db);
  const n = await count(db, table);
  await asOwner(db);
  return n;
}

const client = () => pgliteClient(db);
const charmander = (dexVariantRaw = "Normal") => ({
  tcgdexId: CHARMANDER_SV03_026.tcgdexId,
  dexVariantRaw,
});

/** A Charmander line whose Basic is FILLED — the card that has to be waiting. */
const charmanderLine = (filled = charmander()) => ({
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
      decision: "filled" as const,
      filledTcgdexId: filled.tcgdexId,
      filledDexVariantRaw: filled.dexVariantRaw,
    },
    {
      stageIndex: 1,
      stage: "Stage1",
      dexId: 5,
      decision: "placeholder" as const,
      targetCatalogCardId: CHARMELEON_SV03_027.tcgdexId,
      alternateCatalogCardIds: [],
      specialtyOnly: false,
    },
  ],
});

describe("UIL-098 · Backfill places waiting copies and creates none", () => {
  it("places the OLDEST waiting copy of the key, keeps its presence group, and creates no copy", async () => {
    const res = await commitFrontHalf(client(), OWNER, {
      binderId: B1,
      half: "front",
      cards: [charmander()],
    });

    expect(res.placed).toBe(1);
    // PRE-FIX: 5 — a fifth, ungrouped copy that the next import would twin.
    expect(await tally("copy")).toBe(4);
    const placed = (await copies()).find((c) => c.id === OLD_CHARMANDER)!;
    expect(placed).toMatchObject({ role: "shelved", binder_id: B1, binder_half: "front" });
    expect(placed.grouped).toBe(true);
    expect(await roleOf(NEW_CHARMANDER)).toBe("haul");
  });

  it("writes its decision, so the card leaves the Haul Plan's queue", async () => {
    await commitFrontHalf(client(), OWNER, { binderId: B1, half: "front", cards: [charmander()] });
    const queue = (await loadPendingPlacements(client())).map((p) => p.copyId).sort();
    expect(queue).toEqual([NEW_CHARMANDER, REVERSE_CHARMANDER, SCIZOR].sort());
    expect(await tally("placement_decision")).toBe(1);
  });

  it("keys by Dex variant: a Reverse Holo is never placed for a Normal, or the other way round", async () => {
    await commitFrontHalf(client(), OWNER, {
      binderId: B1,
      half: "front",
      cards: [charmander("Reverse Holo")],
    });
    expect(await roleOf(REVERSE_CHARMANDER)).toBe("shelved");
    expect(await roleOf(OLD_CHARMANDER)).toBe("haul");
  });

  it("places a repurposed duplicate as the block's copy", async () => {
    const line = charmanderLine();
    await commitBackLine(client(), OWNER, {
      ...line,
      stages: [
        line.stages[0],
        {
          stageIndex: 1,
          stage: "Stage1",
          dexId: 5,
          decision: "block",
          blockMaterial: "repurposedDuplicate",
          blockCopyTcgdexId: SCIZOR_SV03_141.tcgdexId,
          blockCopyDexVariantRaw: "Holo",
          pocketCount: 1,
        },
      ],
    });
    expect(await roleOf(SCIZOR)).toBe("block");
    await asSuperuser(db);
    const block = await db.query<{ copy_id: string }>("select copy_id from binder_block");
    expect(block.rows).toEqual([{ copy_id: SCIZOR }]);
    expect(await count(db, "copy")).toBe(4);
  });

  it("specialty places the copy and tags the collection", async () => {
    await commitSpecialty(client(), OWNER, {
      binderId: SPEC,
      cards: [{ tcgdexId: SCIZOR_SV03_141.tcgdexId, dexVariantRaw: "Holo", collectionIds: [COLL] }],
    });
    expect(await roleOf(SCIZOR)).toBe("shelved");
    await asSuperuser(db);
    const coll = await db.query<{ ids: string[] }>(
      "select target_catalog_card_ids as ids from collection where id = $1",
      [COLL],
    );
    expect(coll.rows[0].ids).toEqual([SCIZOR_SV03_141.tcgdexId]);
    expect(await count(db, "copy")).toBe(4);
  });
});

describe("UIL-098 · a save that asks for a card not waiting is refused, naming it", () => {
  it("an over-ask names the card, its variant, and how many are waiting — and writes nothing", async () => {
    await expect(
      commitFrontHalf(client(), OWNER, {
        binderId: B1,
        half: "front",
        cards: [charmander(), charmander(), charmander()],
      }),
    ).rejects.toThrow(
      "You placed 3 Charmander (Normal), but only 2 are waiting in your haul. Add it in Dex, import it " +
        "on the Sync page, then save again.",
    );
    expect(await tally("placement_decision")).toBe(0);
    expect((await copies()).every((c) => c.role === "haul")).toBe(true);
  });

  it("a card with nothing waiting is named too, alongside any other short card", async () => {
    await expect(
      commitSpecialty(client(), OWNER, {
        binderId: SPEC,
        cards: [
          { tcgdexId: ARVEN_SV03_186.tcgdexId, dexVariantRaw: "Normal", collectionIds: [] },
          { tcgdexId: SCIZOR_SV03_141.tcgdexId, dexVariantRaw: "Normal", collectionIds: [] },
        ],
      }),
    ).rejects.toThrow(
      "Arven (Normal) is not waiting in your haul. Scizor (Normal) is not waiting in your haul. Add them " +
        "in Dex, import them on the Sync page, then save again.",
    );
    expect(await roleOf(SCIZOR)).toBe("haul");
  });

  it("a LINE naming a card not waiting is refused with the line's remedy, and nothing of it is written", async () => {
    await expect(
      commitBackLine(client(), OWNER, charmanderLine(charmander("Holo"))),
    ).rejects.toThrow(
      "Charmander (Holo) is not waiting in your haul. Add it in Dex, import it on the Sync page, then " +
        "save this line.",
    );
    for (const t of ["evolution_line", "line_slot", "wishlist_item", "placement_decision"]) {
      expect(await tally(t)).toBe(0);
    }
  });

  it("a repurposed duplicate that is not waiting refuses the line the same way", async () => {
    // A block's sacrificed card is a card she owns too. Only the Holo Scizor is waiting.
    const line = charmanderLine();
    await expect(
      commitBackLine(client(), OWNER, {
        ...line,
        stages: [
          line.stages[0],
          {
            stageIndex: 1,
            stage: "Stage1",
            dexId: 5,
            decision: "block",
            blockMaterial: "repurposedDuplicate",
            blockCopyTcgdexId: SCIZOR_SV03_141.tcgdexId,
            blockCopyDexVariantRaw: "Normal",
            pocketCount: 1,
          },
        ],
      }),
    ).rejects.toThrow(
      "Scizor (Normal) is not waiting in your haul. Add it in Dex, import it on the Sync page, then save " +
        "this line.",
    );
    expect(await tally("binder_block")).toBe(0);
    expect(await roleOf(OLD_CHARMANDER)).toBe("haul");
  });

  it("…and ONLY that line: the front half and another line still save afterwards", async () => {
    await expect(
      commitBackLine(client(), OWNER, charmanderLine(charmander("Holo"))),
    ).rejects.toThrow();

    await commitFrontHalf(client(), OWNER, { binderId: B1, half: "front", cards: [charmander()] });
    await commitBackLine(client(), OWNER, charmanderLine(charmander()));

    expect(await roleOf(OLD_CHARMANDER)).toBe("shelved");
    expect(await roleOf(NEW_CHARMANDER)).toBe("shelved");
    expect(await tally("evolution_line")).toBe(1);
  });

  it("a copy the Haul Plan already placed is not waiting, so it cannot be placed twice", async () => {
    // The Haul Plan's queue is the definition: a copy with a decision has left it, whatever its role.
    await asSuperuser(db);
    await db.query(
      `insert into placement_decision (owner_id, copy_id, decision, reason, resolved_by)
         values ($1, $2, 'placed', 'placed from the Haul Plan', 'user'),
                ($1, $3, 'placed', 'placed from the Haul Plan', 'user')`,
      [OWNER, OLD_CHARMANDER, NEW_CHARMANDER],
    );
    await asOwner(db);
    await expect(
      commitFrontHalf(client(), OWNER, { binderId: B1, half: "front", cards: [charmander()] }),
    ).rejects.toThrow("Charmander (Normal) is not waiting in your haul.");
  });
});
