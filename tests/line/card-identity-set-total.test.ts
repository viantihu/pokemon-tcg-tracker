/**
 * UIL-077, the remaining sites — `CardIdentity` carries the printed set total, so the Line screen (its
 * Move sheet and its slot strip) and Lookup can show "099/182" like every other surface. Pinned at the
 * loader against real Postgres: `buildScreenModel`'s `identity()` is the ONE place a CardIdentity is
 * built for the Line screen, so if the total is dropped there, every Line consumer goes bare at once.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { loadLineScreen } from "@/lib/line";
import { OWNER, freshRpcDb, seedBinders } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const GEN = "b0000000-0000-0000-0000-0000000000c1";
const LINE = "10000000-0000-0000-0000-0000000000c1";
const SLOT_ROOT = "50000000-0000-0000-0000-0000000000c1";
const SLOT_NEXT = "50000000-0000-0000-0000-0000000000c2";
const IN_LINE = "c0000000-0000-0000-0000-0000000000c1";
const UNLINED = "c0000000-0000-0000-0000-0000000000c2";
const UNLINED_KIT = "c0000000-0000-0000-0000-0000000000c3";
const EMBERLING_DEX = 9701;
const EMBERDRAKE_DEX = 9702;
const EMBERKIT_DEX = 9704;

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedBinders(db, [{ id: GEN, type: "general", name: "Binder 1" }]);
  // Two sets with printed totals (different, so a dropped or crossed value shows), and one unrelated
  // Basic whose set reports none — TCGdex has no total for some sets, and that must read as null.
  await db.query(
    `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from, card_class, local_id, set_card_count_official)
       values ('emberling', 'Emberling', $1, '{Fire}', 'Basic', null, 'standard', '099', 182),
              ('emberdrake', 'Emberdrake', $2, '{Fire}', 'Stage1', 'Emberling', 'standard', '100', 210),
              ('emberkit', 'Emberkit', $3, '{Fire}', 'Basic', null, 'standard', '007', null)`,
    [[EMBERLING_DEX], [EMBERDRAKE_DEX], [EMBERKIT_DEX]],
  );
  for (const [copyId, catalogId] of [
    [IN_LINE, "emberling"],
    [UNLINED, "emberdrake"],
    [UNLINED_KIT, "emberkit"],
  ]) {
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
         values ($1, $2, $3, 'shelved', $4, 'front', 'red')`,
      [copyId, OWNER, catalogId, GEN],
    );
  }
  await db.exec(`
    insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
      values ('${LINE}', '${OWNER}', ${EMBERLING_DEX}, 'red', '${GEN}', 'back', 'open');
    insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
      values ('${SLOT_ROOT}', '${OWNER}', '${LINE}', 0, 'Basic', 'filled', '${IN_LINE}');
    insert into line_slot (id, owner_id, line_id, stage_index, stage, state, target_catalog_card_id)
      values ('${SLOT_NEXT}', '${OWNER}', '${LINE}', 1, 'Stage1', 'placeholder', 'emberdrake');
    update copy set line_slot_id = '${SLOT_ROOT}', binder_half = 'back' where id = '${IN_LINE}';
  `);
});
afterEach(async () => {
  await db.close();
});

describe("UIL-077 · CardIdentity carries the printed set total off the loader", () => {
  it("every CardIdentity and alternate the Line screen builds carries its own set's total", async () => {
    const data = await loadLineScreen(pgliteClient(db));
    const line = data.lines.find((l) => l.lineId === LINE)!;
    const filled = line.slots.find((s) => s.slotId === SLOT_ROOT)!;
    expect(filled.card).toMatchObject({ localId: "099", setCardCountOfficial: 182 });
    // The placeholder's identity is its target printing, from a DIFFERENT set: 210, not 182.
    const open = line.slots.find((s) => s.slotId === SLOT_NEXT)!;
    expect(open.card).toMatchObject({ localId: "100", setCardCountOfficial: 210 });
    // Its ranked alternates carry it too (DecisionCard's wishlist tiles and the Line screen's
    // alternates text read from these). A real total here, so an `altOptions()` that dropped the
    // field could not hide behind the LineView mapping's `?? null`.
    expect(open.alternates[0]).toMatchObject({ localId: "100", setCardCountOfficial: 210 });
    const unlined = data.unlinedCards.find((c) => c.copyId === UNLINED)!;
    expect(unlined.card).toMatchObject({ localId: "100", setCardCountOfficial: 210 });
  });

  it("a set TCGdex reports no total for reads as null — present, so the fallback is the bare number", async () => {
    const data = await loadLineScreen(pgliteClient(db));
    const kit = data.unlinedCards.find((c) => c.copyId === UNLINED_KIT)!;
    expect(kit.card).toMatchObject({ localId: "007", setCardCountOfficial: null });
  });
});
