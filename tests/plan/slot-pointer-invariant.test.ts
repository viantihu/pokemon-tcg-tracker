/**
 * UIL-062 / UIL-063 — `line_slot.copy_id` and `copy.line_slot_id` are one fact stored twice, and the
 * app is only correct when they agree.
 *
 * Her Dragonair report is the visible half: she pressed Done, the card is physically in the binder, and
 * the Lines page still shows that stage HUNTING. The invisible half is 5 slots on Testing reading
 * `filled` while naming a copy that is somewhere else — the Lines page reads the SLOT, so those render
 * as occupied by a card that has moved and nothing on screen contradicts it.
 *
 * Two write paths broke the pair, and each gets its own test here:
 *
 *   1. THE OVERRIDE. `placementForMove` clears `line_slot_id` for every destination kind — correctly,
 *      since no `MoveDestination` can express "into a line slot" — but `writeOverriddenCard` emitted no
 *      slot op at all. Copy side written, slot side not. 4 of the 5 measured rows.
 *   2. THE EXISTING-SLOT FILL. Both pointer ops were inside `if (slot)` with no else, so an
 *      unresolvable slot committed a back-half placement with neither pointer set.
 *
 * The assertion that matters is the same in both directions and is stated as a WHOLE-TABLE invariant
 * rather than a single-row check: no slot names a copy that does not name it back, and no back-half
 * shelved copy is silently unlinked. A single-row assertion would have passed for the broken code in
 * the cases where the row happened to be the one that worked.
 *
 * Real `apply_write_ops` on real Postgres (PGlite), seeded with `seedCatalogCardsFull` — the id-only
 * seed leaves set/local/artwork ids null, which stops the cascade resolving a chain at all, so a
 * line-filling test on it would pass while exercising nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { EngineContext } from "@/lib/engine";
import { toEvolutionLine } from "@/lib/plan";
import {
  buildHaulCommitPayload,
  planFromDraft,
  type DraftItem,
  type PlanContext,
} from "@/lib/plan";
import type { Row } from "@/lib/repo";
import { CHARMANDER_SV03_026, CHARMELEON_SV03_027 } from "../engine/fixtures";
import {
  applyOps,
  asOwner,
  asSuperuser,
  freshRpcDb,
  OWNER,
  haulRow,
  seedBinders,
  seedCatalogCardsFull,
  seedHaulRows,
} from "../support/pglite-rpc";

const B1 = "1c000000-0000-0000-0000-0000000000b1";
const SPEC = "1c000000-0000-0000-0000-00000000c5ec";
const LINE = "11111111-0000-0000-0000-0000000000a1";
const SLOT0 = "22222222-0000-0000-0000-0000000000b0";
const SLOT1 = "22222222-0000-0000-0000-0000000000b1";
const COPY = "c0000000-0000-0000-0000-00000000aa01";

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
  Colorless: "white",
  Trainer: "white",
};
/** The incoming Charmeleon in the typed-intake-era cases, now a copy waiting in her haul. */
const INCOMING_COPY = "d0000000-0000-4000-8000-00000000c0a1";
const CATALOG = [CHARMANDER_SV03_026, CHARMELEON_SV03_027];

function ctxFor(
  owned: Row<"copy">[],
  slotRows: Row<"line_slot">[],
  lineStatus = "open",
): PlanContext {
  const catalogById = new Map(CATALOG.map((c) => [c.tcgdexId, c]));
  const ctx: EngineContext = {
    typeColorMap: TYPE_COLOR_MAP,
    catalog: CATALOG,
    owned: owned.map((r) => ({
      id: r.id,
      card: catalogById.get(r.catalog_card_id)!,
      variant: "normal",
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
    /**
     * Built with the PRODUCTION adapter, not by hand.
     *
     * The hand-rolled version set `dexId: null` on every slot, and `existingLineSlot` matches the
     * incoming card's species against exactly that field — so the cascade could never choose to fill an
     * existing slot, and a test claiming to exercise that branch silently exercised `line-new` instead.
     * `toEvolutionLine` with the same `dexIdForSlot` resolution `loadPlanContext` uses makes the fixture
     * unable to drift from production in that way again.
     */
    lines: slotRows.length
      ? [
          toEvolutionLine(
            {
              id: LINE,
              root_dex_id: 4,
              color_band: "red",
              binder_id: B1,
              status: lineStatus,
            } as unknown as Row<"evolution_line">,
            slotRows,
            (slot) => {
              const viaCopy = slot.copy_id && owned.find((c) => c.id === slot.copy_id);
              if (viaCopy) return catalogById.get(viaCopy.catalog_card_id)?.dexId[0] ?? null;
              if (slot.target_catalog_card_id) {
                return catalogById.get(slot.target_catalog_card_id)?.dexId[0] ?? null;
              }
              return null;
            },
          ),
        ]
      : [],
    collections: [],
    now: "2026-09-17T00:00:00.000Z",
  };
  const slotRowsByLine = new Map<string, Row<"line_slot">[]>();
  if (slotRows.length > 0) slotRowsByLine.set(LINE, slotRows);
  return {
    ctx,
    catalogById,
    copyRowById: new Map(owned.map((c) => [c.id, c])),
    slotRowsByLine,
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

/** THE invariant, checked over the whole table rather than one row. */
async function pointerViolations(db: PGlite) {
  const orphanSlots = await db.query<{ n: number }>(
    `select count(*)::int as n from line_slot s
     where s.state = 'filled' and s.copy_id is not null
       and not exists (select 1 from copy c where c.id = s.copy_id and c.line_slot_id = s.id)`,
  );
  const danglingCopies = await db.query<{ n: number }>(
    `select count(*)::int as n from copy c
     where c.line_slot_id is not null
       and not exists (select 1 from line_slot s where s.id = c.line_slot_id and s.copy_id = c.id)`,
  );
  return {
    slotsNamingACopyThatLeft: orphanSlots.rows[0].n,
    copiesNamingASlotThatIsNotHoldingThem: danglingCopies.rows[0].n,
  };
}

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedCatalogCardsFull(db, CATALOG);
  await seedBinders(db, [
    { id: B1, type: "general" },
    { id: SPEC, type: "specialty" },
  ]);
});
afterEach(async () => {
  await db.close();
});

/** A line whose stage 0 is FILLED by `COPY`, both pointers correctly set. */
async function seedFilledLine(lineStatus = "open") {
  await db.query(
    `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, status)
     values ($1,$2,4,'red',$3,$4)`,
    [LINE, OWNER, B1, lineStatus],
  );
  await db.query(
    `insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band, acquired_at)
     values ($1,$2,$3,'normal','shelved',$4,'back','red', now())`,
    [COPY, OWNER, CHARMANDER_SV03_026.tcgdexId, B1],
  );
  await db.query(
    `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
     values ($1,$2,$3,0,'Basic','filled',$4)`,
    [SLOT0, OWNER, LINE, COPY],
  );
  await db.query(`update copy set line_slot_id = $1 where id = $2`, [SLOT0, COPY]);
  const slots = await db.query<Row<"line_slot">>(`select * from line_slot where line_id = $1`, [
    LINE,
  ]);
  const copies = await db.query<Row<"copy">>(`select * from copy where id = $1`, [COPY]);
  return { slots: slots.rows, copies: copies.rows };
}

describe("UIL-062 · overriding a card OUT of a line releases the slot it leaves", () => {
  it("does not leave the slot filled naming a copy that moved", async () => {
    const { slots, copies } = await seedFilledLine();
    expect(await pointerViolations(db)).toEqual({
      slotsNamingACopyThatLeft: 0,
      copiesNamingASlotThatIsNotHoldingThem: 0,
    });

    // She overrides that same card to the bulk box — a destination that cannot name a line slot.
    const card: DraftItem = {
      id: COPY,
      tcgdexId: CHARMANDER_SV03_026.tcgdexId,
      variant: "normal",
      existingCopyId: COPY,
    };
    const pc = ctxFor(copies, slots);
    pc.ctx.owned = []; // withheld for a routing pass, as loadPlanContext does
    const { planned } = planFromDraft(pc, [card]);
    const built = buildHaulCommitPayload(pc, planned, {
      draft: [card],
      overrides: { [COPY]: { kind: "bulk" } },
    });

    await asOwner(db);
    await applyOps(db, built.payload);
    await asSuperuser(db);

    // The copy went to bulk, pointer cleared — that half was always right.
    const after = await db.query<{ role: string; line_slot_id: string | null }>(
      `select role, line_slot_id from copy where id = $1`,
      [COPY],
    );
    expect(after.rows[0].role).toBe("bulk");
    expect(after.rows[0].line_slot_id).toBeNull();

    // And the slot let go, instead of claiming to hold a card now in the bulk box.
    const slot = await db.query<{ state: string; copy_id: string | null }>(
      `select state, copy_id from line_slot where id = $1`,
      [SLOT0],
    );
    expect(slot.rows[0].state).toBe("placeholder");
    expect(slot.rows[0].copy_id).toBeNull();

    // Stated as the invariant, which is what actually matters.
    expect(await pointerViolations(db)).toEqual({
      slotsNamingACopyThatLeft: 0,
      copiesNamingASlotThatIsNotHoldingThem: 0,
    });
  });

  it("demotes a COMPLETE line to open, since a stage just emptied", async () => {
    const { slots, copies } = await seedFilledLine("complete");
    const card: DraftItem = {
      id: COPY,
      tcgdexId: CHARMANDER_SV03_026.tcgdexId,
      variant: "normal",
      existingCopyId: COPY,
    };
    const pc = ctxFor(copies, slots, "complete");
    pc.ctx.owned = [];
    const { planned } = planFromDraft(pc, [card]);
    const built = buildHaulCommitPayload(pc, planned, {
      draft: [card],
      overrides: { [COPY]: { kind: "bulk" } },
    });
    await asOwner(db);
    await applyOps(db, built.payload);
    await asSuperuser(db);

    const line = await db.query<{ status: string }>(
      `select status from evolution_line where id = $1`,
      [LINE],
    );
    // A line claiming completion it no longer has is the same class of lie as the stale slot.
    expect(line.rows[0].status).toBe("open");
  });

  it("leaves a slot alone when it names a DIFFERENT copy", async () => {
    // Guard against over-releasing: if the pointer was already stale, clearing the slot would take it
    // away from whoever legitimately holds it.
    const OTHER = "c0000000-0000-0000-0000-00000000aa99";
    await db.query(
      `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id)
       values ($1,$2,4,'red',$3)`,
      [LINE, OWNER, B1],
    );
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band, acquired_at)
       values ($1,$2,$3,'normal','shelved',$4,'back','red', now()),
              ($5,$2,$3,'normal','shelved',$4,'back','red', now())`,
      [COPY, OWNER, CHARMANDER_SV03_026.tcgdexId, B1, OTHER],
    );
    await db.query(
      `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
       values ($1,$2,$3,0,'Basic','filled',$4)`,
      [SLOT0, OWNER, LINE, OTHER],
    );
    await db.query(`update copy set line_slot_id = $1 where id = $2`, [SLOT0, OTHER]);
    // COPY *claims* the slot but the slot names OTHER — a pre-existing inconsistency.
    await db.query(`update copy set line_slot_id = $1 where id = $2`, [SLOT0, COPY]);

    const slots = (await db.query<Row<"line_slot">>(`select * from line_slot`)).rows;
    const copies = (await db.query<Row<"copy">>(`select * from copy where id = $1`, [COPY])).rows;

    const card: DraftItem = {
      id: COPY,
      tcgdexId: CHARMANDER_SV03_026.tcgdexId,
      variant: "normal",
      existingCopyId: COPY,
    };
    const pc = ctxFor(copies, slots);
    pc.ctx.owned = [];
    const { planned } = planFromDraft(pc, [card]);
    const built = buildHaulCommitPayload(pc, planned, {
      draft: [card],
      overrides: { [COPY]: { kind: "bulk" } },
    });
    await asOwner(db);
    await applyOps(db, built.payload);
    await asSuperuser(db);

    const slot = await db.query<{ state: string; copy_id: string | null }>(
      `select state, copy_id from line_slot where id = $1`,
      [SLOT0],
    );
    // Still OTHER's. Releasing it would have evicted a card that never moved.
    expect(slot.rows[0].state).toBe("filled");
    expect(slot.rows[0].copy_id).toBe(OTHER);
  });
});

describe("UIL-063 · the FIRST Done on a card joining an existing line sets both pointers", () => {
  it("fills the slot AND points the copy at it — never one without the other", async () => {
    // A line with stage 0 filled and stage 1 a placeholder wanting Charmeleon.
    await db.query(
      `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id)
       values ($1,$2,4,'red',$3)`,
      [LINE, OWNER, B1],
    );
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band, acquired_at)
       values ($1,$2,$3,'normal','shelved',$4,'back','red', now())`,
      [COPY, OWNER, CHARMANDER_SV03_026.tcgdexId, B1],
    );
    await db.query(
      `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
       values ($1,$2,$3,0,'Basic','filled',$4)`,
      [SLOT0, OWNER, LINE, COPY],
    );
    await db.query(`update copy set line_slot_id = $1 where id = $2`, [SLOT0, COPY]);
    await db.query(
      `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, target_catalog_card_id)
       values ($1,$2,$3,1,'Stage1','placeholder',$4)`,
      [SLOT1, OWNER, LINE, CHARMELEON_SV03_027.tcgdexId],
    );

    const slots = (
      await db.query<Row<"line_slot">>(
        `select * from line_slot where line_id = $1 order by stage_index`,
        [LINE],
      )
    ).rows;
    // Charmeleon arrives this haul and the cascade should fill stage 1: a copy her import made, waiting in
    // her haul (UIL-098 part 2), and withheld from `owned` as `loadPlanContext` withholds it.
    const incoming = haulRow(INCOMING_COPY, CHARMELEON_SV03_027.tcgdexId);
    await seedHaulRows(db, [incoming]);
    const copies = (
      await db.query<Row<"copy">>(`select * from copy where id <> $1`, [INCOMING_COPY])
    ).rows;
    const pc = ctxFor(copies, slots);
    const { planned } = planFromDraft(pc, [incoming]);
    const built = buildHaulCommitPayload(pc, planned, { draft: [incoming] });

    await asOwner(db);
    await applyOps(db, built.payload);
    await asSuperuser(db);

    // Her symptom was: card shelved, stage still HUNTING. Both halves must be true together.
    const v = await pointerViolations(db);
    expect(v).toEqual({
      slotsNamingACopyThatLeft: 0,
      copiesNamingASlotThatIsNotHoldingThem: 0,
    });

    // And specifically: no back-half shelved copy left silently unlinked.
    const unlinked = await db.query<{ n: number }>(
      `select count(*)::int as n from copy
       where role = 'shelved' and binder_half = 'back' and line_slot_id is null`,
    );
    expect(unlinked.rows[0].n).toBe(0);
  });
});

describe("UIL-063 · an unresolvable slot fails the commit instead of half-writing it", () => {
  /**
   * This is the test that actually distinguishes the fix. The one above passes either way, because
   * when the slot IS resolvable the old `if (slot)` branch did the right thing — so it pins the happy
   * path, not the repair.
   *
   * The failure mode needs the slot to be UNRESOLVABLE: the cascade decides "fill stage 1 of line L"
   * from `ctx.lines`, while `slotRowsByLine` has no rows for L. Pre-fix, neither pointer op was emitted
   * and the commit still succeeded — having written the back-half placement columns with
   * `line_slot_id: null` (`copyPlacementFromTarget` carries no slot id for any target kind). Net result:
   * a card physically shelved in the back half that the line still lists as wanting. Her Dragonair.
   */
  it("throws rather than shelving a card whose stage stays unfilled", async () => {
    await db.query(
      `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id)
       values ($1,$2,4,'red',$3)`,
      [LINE, OWNER, B1],
    );
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band, acquired_at)
       values ($1,$2,$3,'normal','shelved',$4,'back','red', now())`,
      [COPY, OWNER, CHARMANDER_SV03_026.tcgdexId, B1],
    );
    await db.query(
      `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
       values ($1,$2,$3,0,'Basic','filled',$4)`,
      [SLOT0, OWNER, LINE, COPY],
    );
    await db.query(`update copy set line_slot_id = $1 where id = $2`, [SLOT0, COPY]);
    await db.query(
      `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, target_catalog_card_id)
       values ($1,$2,$3,1,'Stage1','placeholder',$4)`,
      [SLOT1, OWNER, LINE, CHARMELEON_SV03_027.tcgdexId],
    );

    const slots = (
      await db.query<Row<"line_slot">>(
        `select * from line_slot where line_id = $1 order by stage_index`,
        [LINE],
      )
    ).rows;
    const copies = (await db.query<Row<"copy">>(`select * from copy`)).rows;

    // Throws before any write, so the haul copy needs no row — only the id that makes it one.
    const incoming = haulRow(INCOMING_COPY, CHARMELEON_SV03_027.tcgdexId);
    const pc = ctxFor(copies, slots);
    // The desync: the engine still sees the line and picks its open stage, but the commit's slot
    // snapshot has nothing for it. Exactly the state in which the old code wrote half a fact.
    pc.slotRowsByLine = new Map();

    const { planned } = planFromDraft(pc, [incoming]);
    expect(planned[0].result.filledExistingSlot).toBeTruthy(); // the branch under test is reached

    expect(() => buildHaulCommitPayload(pc, planned, { draft: [incoming] })).toThrow(
      /not in the loaded line state/,
    );
  });
});
