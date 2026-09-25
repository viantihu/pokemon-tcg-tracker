/**
 * UIL-070 part 1, write half — a back-half override from the Haul Plan now WRITES the line she picked.
 *
 * Before this, `writeOverriddenCard` dropped `lineJoin` on the floor (`placementForMove` nulls
 * `line_slot_id` for every kind), and `commitCardPlacement` never refused a bare back-half shelf the
 * way `applyMove` does — so a stale Plan client could write exactly UIL-056's strand: a back-half copy
 * with no line. Both are closed here, through the REAL `commitCardPlacement` against the REAL
 * `apply_write_ops` on real Postgres (PGlite), reusing `applyMove`'s builders and its exact refusal
 * wording so joining a line means one thing whichever screen she did it from.
 *
 * The pre-fix-failing case is "REFUSES a bare back-half shelf": develop writes the strand.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  buildHaulCommitPayload,
  clearCatalogCache,
  commitCardPlacement,
  loadPlanContext,
  planFromDraft,
  type DraftItem,
} from "@/lib/plan";
import type { MoveDestination } from "@/lib/line/types";
import {
  OWNER,
  applyOps,
  asOwner,
  asSuperuser,
  freshRpcDb,
  haulRow,
  seedBinders,
  seedHaulRows,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const GEN = "b0000000-0000-0000-0000-0000000000b1";
/** A SECOND general binder — the one she was filling by hand (UIL-084). */
const GEN2 = "b0000000-0000-0000-0000-0000000000b9";
const LINE = "10000000-0000-0000-0000-0000000000b1";
const SLOT_ROOT = "50000000-0000-0000-0000-0000000000b1";
const SLOT_NEXT = "50000000-0000-0000-0000-0000000000b2";
const OWNED_EMBERLING = "c0000000-0000-0000-0000-0000000000b1";
const OTHER_DRAKE = "c0000000-0000-0000-0000-0000000000b2";
const PENDING_DRAKE = "c0000000-0000-0000-0000-0000000000b3"; // a synced, unplaced copy to ROUTE

const EMBERLING_DEX = 9601;
const EMBERDRAKE_DEX = 9602;

/** The Emberdrake she is holding: a copy her import made, waiting in her haul (UIL-098 part 2). */
const DRAFT: DraftItem = haulRow("d0000000-0000-4000-8000-0000000000d1", "emberdrake");
const BACK_RED = { kind: "shelf", binderId: GEN, half: "back", band: "red" } as const;

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  clearCatalogCache();
  await seedBinders(db, [
    { id: GEN, type: "general", name: "Binder 1" },
    { id: GEN2, type: "general", name: "Binder 2" },
  ]);
  for (const [id, name, dex, stage, from] of [
    ["emberling", "Emberling", EMBERLING_DEX, "Basic", null],
    ["emberdrake", "Emberdrake", EMBERDRAKE_DEX, "Stage1", "Emberling"],
  ] as const) {
    await db.query(
      `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from, card_class)
         values ($1, $2, $3, '{Fire}', $4, $5, 'standard')`,
      [id, name, [dex], stage, from],
    );
  }
  await seedHaulRows(db, [DRAFT]);
});
afterEach(async () => {
  await db.close();
});

/** A red Emberling line: root filled, Emberdrake's stage open — the line the picker would offer. */
async function seedOpenLine(): Promise<void> {
  await db.query(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
       values ($1, $2, 'emberling', 'shelved', $3, 'back', 'red')`,
    [OWNED_EMBERLING, OWNER, GEN],
  );
  await db.exec(`
    insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
      values ('${LINE}', '${OWNER}', ${EMBERLING_DEX}, 'red', '${GEN}', 'back', 'open');
    insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
      values ('${SLOT_ROOT}', '${OWNER}', '${LINE}', 0, 'Basic', 'filled', '${OWNED_EMBERLING}');
    insert into line_slot (id, owner_id, line_id, stage_index, stage, state, target_catalog_card_id)
      values ('${SLOT_NEXT}', '${OWNER}', '${LINE}', 1, 'Stage1', 'placeholder', 'emberdrake');
    update copy set line_slot_id = '${SLOT_ROOT}' where id = '${OWNED_EMBERLING}';
  `);
}

/**
 * A red Emberling line in Binder 1 whose EVERY stage is filled — so a second Emberdrake has no slot to
 * join anywhere, which is the state that made her refusal unactionable (UIL-084).
 */
async function seedFilledLine(): Promise<void> {
  await db.query(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
       values ($1, $2, 'emberling', 'shelved', $3, 'back', 'red'),
              ($4, $2, 'emberdrake', 'shelved', $3, 'back', 'red')`,
    [OWNED_EMBERLING, OWNER, GEN, OTHER_DRAKE],
  );
  await db.exec(`
    insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
      values ('${LINE}', '${OWNER}', ${EMBERLING_DEX}, 'red', '${GEN}', 'back', 'complete');
    insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
      values ('${SLOT_ROOT}', '${OWNER}', '${LINE}', 0, 'Basic', 'filled', '${OWNED_EMBERLING}'),
             ('${SLOT_NEXT}', '${OWNER}', '${LINE}', 1, 'Stage1', 'filled', '${OTHER_DRAKE}');
    update copy set line_slot_id = '${SLOT_ROOT}' where id = '${OWNED_EMBERLING}';
    update copy set line_slot_id = '${SLOT_NEXT}' where id = '${OTHER_DRAKE}';
  `);
}

/** Lines with their binder, oldest first — the binder is the point now (UIL-084). */
async function linesWithBinder() {
  return (
    await db.query<{
      id: string;
      root_dex_id: number;
      color_band: string;
      binder_id: string | null;
    }>(`select id, root_dex_id, color_band, binder_id from evolution_line order by created_at`)
  ).rows;
}

/** The real loaded context, so the builder runs against production shapes rather than a hand-built map. */
/** The plan context a pass over `placing` reads, withholding those copies as `commitCardPlacement` does. */
async function planContext(placing: string[] = []) {
  await asOwner(db);
  try {
    return await loadPlanContext(pgliteClient(db), { excludeOwnedCopyIds: placing });
  } finally {
    await asSuperuser(db);
  }
}

async function commit(override: MoveDestination, card: DraftItem = DRAFT) {
  await asOwner(db);
  try {
    return await commitCardPlacement(pgliteClient(db), { card, override });
  } finally {
    await asSuperuser(db);
  }
}

/**
 * The Emberdrakes the commit has PLACED — every one not still waiting in her haul. The haul copies exist
 * before any commit (UIL-098: the Plan places, it never creates), so "nothing written" reads as none here.
 */
async function drakeCopies() {
  return (
    await db.query<{
      id: string;
      role: string;
      binder_id: string | null;
      binder_half: string | null;
      color_band: string | null;
      line_slot_id: string | null;
    }>(
      `select id, role, binder_id, binder_half, color_band, line_slot_id from copy
         where catalog_card_id = 'emberdrake' and role <> 'haul' order by created_at`,
    )
  ).rows;
}
async function slot(id: string) {
  return (
    await db.query<{ state: string; copy_id: string | null }>(
      `select state, copy_id from line_slot where id = $1`,
      [id],
    )
  ).rows[0];
}
async function lines() {
  return (
    await db.query<{ id: string; root_dex_id: number; color_band: string; status: string }>(
      `select id, root_dex_id, color_band, status from evolution_line order by created_at`,
    )
  ).rows;
}

describe("UIL-070 part 1 · joining an EXISTING line's open slot from the Haul Plan", () => {
  it("fills the picked slot with the new copy, points the copy at it, and completes the line", async () => {
    await seedOpenLine();
    await commit({ ...BACK_RED, lineJoin: { mode: "existing", lineId: LINE, slotId: SLOT_NEXT } });

    const [copy] = await drakeCopies();
    expect(copy).toMatchObject({
      role: "shelved",
      binder_id: GEN,
      binder_half: "back",
      color_band: "red",
      line_slot_id: SLOT_NEXT, // the assertion the write half is pinned on
    });
    expect(await slot(SLOT_NEXT)).toEqual({ state: "filled", copy_id: copy.id });
    // Stage1 was the last open stage, so the line is complete — buildExistingLineJoinOps' rule.
    expect((await lines())[0].status).toBe("complete");
    // The audit row still names it as her override.
    const decision = (
      await db.query<{ decision: string }>(
        `select decision from placement_decision where copy_id = $1`,
        [copy.id],
      )
    ).rows[0];
    expect(decision.decision).toBe("placement-override");
  });

  it("routes a synced, unplaced copy into the slot the same way (update_copy, not insert_copy)", async () => {
    await seedOpenLine();
    // A second copy in the haul, not the default one: the write must patch THE copy the row names.
    await seedHaulRows(db, [haulRow(PENDING_DRAKE, "emberdrake")]);
    await commit(
      { ...BACK_RED, lineJoin: { mode: "existing", lineId: LINE, slotId: SLOT_NEXT } },
      haulRow(PENDING_DRAKE, "emberdrake"),
    );
    const copies = await drakeCopies();
    expect(copies).toHaveLength(1); // routed, not duplicated (UIL-003)
    expect(copies[0]).toMatchObject({
      id: PENDING_DRAKE,
      binder_half: "back",
      line_slot_id: SLOT_NEXT,
    });
    expect(await slot(SLOT_NEXT)).toEqual({ state: "filled", copy_id: PENDING_DRAKE });
  });

  it("REFUSES a slot that has already been filled, in applyMove's words, and writes nothing", async () => {
    await seedOpenLine();
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band, line_slot_id)
         values ($1, $2, 'emberdrake', 'shelved', $3, 'back', 'red', $4)`,
      [OTHER_DRAKE, OWNER, GEN, SLOT_NEXT],
    );
    await db.query(`update line_slot set state = 'filled', copy_id = $1 where id = $2`, [
      OTHER_DRAKE,
      SLOT_NEXT,
    ]);
    await expect(
      commit({ ...BACK_RED, lineJoin: { mode: "existing", lineId: LINE, slotId: SLOT_NEXT } }),
    ).rejects.toThrow("That slot has already been filled — reload the screen and pick again.");
    expect(await drakeCopies()).toHaveLength(1); // only the pre-existing one
  });

  it("REFUSES a slot that is not in that line, in applyMove's words", async () => {
    await seedOpenLine();
    await expect(
      commit({
        ...BACK_RED,
        lineJoin: {
          mode: "existing",
          lineId: LINE,
          slotId: "50000000-0000-0000-0000-0000000000ff",
        },
      }),
    ).rejects.toThrow("That line slot no longer exists — reload the screen and pick again.");
    expect(await drakeCopies()).toHaveLength(0);
  });
});

describe("UIL-070 part 1 · starting a NEW line from the Haul Plan", () => {
  it("creates the line and its slots around the new copy, in the band she picked", async () => {
    await commit({ ...BACK_RED, lineJoin: { mode: "new" } });

    const [line] = await lines();
    expect(line).toMatchObject({ root_dex_id: EMBERLING_DEX, color_band: "red" });
    const slots = (
      await db.query<{ stage_index: number; stage: string; state: string; copy_id: string | null }>(
        `select stage_index, stage, state, copy_id from line_slot where line_id = $1 order by stage_index`,
        [line.id],
      )
    ).rows;
    const [copy] = await drakeCopies();
    // Emberling exists in red → its stage is a placeholder; the incoming Emberdrake fills its own.
    expect(slots).toEqual([
      { stage_index: 0, stage: "Basic", state: "placeholder", copy_id: null },
      { stage_index: 1, stage: "Stage1", state: "filled", copy_id: copy.id },
    ]);
    expect(copy).toMatchObject({ binder_half: "back", color_band: "red" });
    expect(copy.line_slot_id).not.toBeNull();
    expect(await slot(copy.line_slot_id!)).toEqual({ state: "filled", copy_id: copy.id });
  });

  it("a band that differs from the card's own is HER choice in the picker: no UIL-069 ask, line in green", async () => {
    await commit({ ...BACK_RED, band: "green", lineJoin: { mode: "new" } });
    const [line] = await lines();
    expect(line.color_band).toBe("green");
    const [copy] = await drakeCopies();
    expect(copy).toMatchObject({ binder_half: "back", color_band: "green" });
    expect(copy.line_slot_id).not.toBeNull();
  });

  it("STARTS a new line when she asks for one, even where a joinable line exists in the same binder (UIL-096)", async () => {
    // Was a refusal "in applyMove's words". Karvi overruled the rule: a new line is her call, and the
    // panel's warning — naming this very line and offering to join its open slot — is how she makes it
    // knowingly. The two write paths still agree, which is what this suite pins.
    await seedOpenLine(); // a red Emberling line exists in Binder 1, with Emberdrake's own slot OPEN
    await commit({ ...BACK_RED, lineJoin: { mode: "new" } });
    expect(await lines()).toHaveLength(2);
    const [copy] = await drakeCopies();
    expect(copy.line_slot_id).not.toBeNull();
  });
});

describe("UIL-084 · one line per species per band per BINDER, from the Haul Plan", () => {
  it("ALLOWS the same species and band in a DIFFERENT binder, and the card lands there", async () => {
    // Her case exactly: a line for this family already holds this band in Binder 1, and the copy she is
    // placing has no slot to join there because that line's matching stage is already filled. She
    // overrides into Binder 2's back half. Pre-fix the commit refused it and the card never landed —
    // with a remedy ("join it instead") naming a slot that does not exist.
    await seedFilledLine();
    await commit({ ...BACK_RED, binderId: GEN2, lineJoin: { mode: "new" } });

    const rows = await linesWithBinder();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      binder_id: GEN2,
      root_dex_id: EMBERLING_DEX,
      color_band: "red",
    });
    // The copy is in Binder 2's back half, pointing at a slot of the line it just started.
    const drakes = await drakeCopies();
    const placed = drakes.find((d) => d.id === DRAFT.id)!;
    expect(placed).toMatchObject({
      role: "shelved",
      binder_id: GEN2,
      binder_half: "back",
      color_band: "red",
    });
    expect(placed.line_slot_id).not.toBeNull();
    expect((await slot(placed.line_slot_id as string)).copy_id).toBe(placed.id);
  });

  it("a second line in the binder that already has one now LANDS — her Toedscruel shape (UIL-096)", async () => {
    // This pinned "the rule is per binder and not simply dropped". Karvi has since dropped it on purpose:
    // the line's matching stage is FILLED, so there is no slot to join, and the back half had nowhere to
    // take her card at all. That is the case she reported.
    await seedFilledLine();
    await commit({ ...BACK_RED, lineJoin: { mode: "new" } });
    const rows = await linesWithBinder();
    expect(rows).toHaveLength(2);
  });
});

/**
 * The IN-PASS key (UIL-084). `buildHaulCommitPayload` carries a `passLines` mirror so a later card in
 * the SAME payload joins a line an earlier card just created instead of duplicating it — and that key
 * has to be scoped to the binder for the same reason the DB lookup is, or two cards she sent to two
 * different binders would collapse into one line in whichever binder came first.
 *
 * `commitCardPlacement` sends one card per payload, so this is unreachable through it; the multi-card
 * contract belongs to the exported builder, which is what this drives. Written because the mutation
 * "drop the binder from the in-pass key" survived every other test in the suite.
 */
describe("UIL-084 · two cards, one payload, two binders — the in-pass key is per binder too", () => {
  /** Two Emberdrakes in her haul — DRAFT and a second one. */
  const TWO_DRAKES: DraftItem[] = [
    DRAFT,
    haulRow("d0000000-0000-4000-8000-0000000000d2", "emberdrake"),
  ];

  it("gives each binder its own new line instead of folding the second card into the first's line", async () => {
    await seedHaulRows(db, [TWO_DRAKES[1]]); // [0] is DRAFT, seeded in beforeEach
    const cards = TWO_DRAKES;
    const pc = await planContext(cards.map((c) => c.id));
    const { planned } = planFromDraft(pc, cards);
    const built = buildHaulCommitPayload(pc, planned, {
      draft: cards,
      // Each copy is sent to a DIFFERENT binder's back half, each starting a line there.
      overrides: {
        [cards[0].id]: { ...BACK_RED, lineJoin: { mode: "new" } },
        [cards[1].id]: { ...BACK_RED, binderId: GEN2, lineJoin: { mode: "new" } },
      },
    });

    const inserts = built.payload.ops.filter((o) => o.op === "insert_line");
    expect(inserts).toHaveLength(2);
    expect(inserts.map((o) => (o as { binder_id: string | null }).binder_id).sort()).toEqual(
      [GEN, GEN2].sort(),
    );

    // And it really applies: two lines, one per binder, each holding its own copy.
    await asOwner(db);
    await applyOps(db, built.payload);
    await asSuperuser(db);
    const rows = await linesWithBinder();
    expect(rows.map((r) => r.binder_id).sort()).toEqual([GEN, GEN2].sort());
    const drakes = await drakeCopies();
    expect(drakes).toHaveLength(2);
    expect(drakes.map((d) => d.binder_id).sort()).toEqual([GEN, GEN2].sort());
    for (const d of drakes) expect(d.line_slot_id).not.toBeNull();
    // Two DISTINCT slots: folding them together is exactly what the unscoped key did.
    expect(new Set(drakes.map((d) => d.line_slot_id)).size).toBe(2);
  });

  it("two explicit new lines in the SAME binder, in one payload, are TWO lines (UIL-096)", async () => {
    // This used to refuse the second ask. She asked twice for a new line in one binder; with the rule gone
    // each ask is honoured, and the in-pass mirror still keeps them as two distinct lines rather than
    // folding the second card into the first's.
    const cards = TWO_DRAKES;
    const pc = await planContext(cards.map((c) => c.id));
    const { planned } = planFromDraft(pc, cards);
    const { payload } = buildHaulCommitPayload(pc, planned, {
      draft: cards,
      overrides: {
        [cards[0].id]: { ...BACK_RED, lineJoin: { mode: "new" } },
        [cards[1].id]: { ...BACK_RED, lineJoin: { mode: "new" } },
      },
    });
    expect(payload.ops.filter((o) => o.op === "insert_line")).toHaveLength(2);
  });
});

describe("UIL-070 part 1 · the server refuses what the panel disables", () => {
  it("REFUSES a bare back-half shelf (no line picked) instead of writing UIL-056's strand", async () => {
    // PRE-FIX-FAILING: develop wrote a back-half copy with line_slot_id null here.
    await expect(commit(BACK_RED)).rejects.toThrow(
      "That destination is incomplete — reload the screen and pick again.",
    );
    expect(await drakeCopies()).toHaveLength(0);
    expect(await lines()).toHaveLength(0);
  });

  it("still writes a FRONT-half override exactly as before — no line, no refusal", async () => {
    await commit({ ...BACK_RED, half: "front" });
    const [copy] = await drakeCopies();
    expect(copy).toMatchObject({ binder_half: "front", color_band: "red", line_slot_id: null });
  });
});
