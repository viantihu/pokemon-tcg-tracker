/**
 * UIL-056 (successor's notes 2 + 3) — `loadLineScreen`'s `unlinedCards` must give her enough to pick
 * from without picking blind, and must explain a band with no open candidate rather than leave it
 * looking like a broken, empty list.
 *
 * Real Postgres via PGlite (real migrations, real seeded `color_band`/`type_color_map`) — this is
 * read-only I/O composition, not atomicity, but the chain rebuild (`buildChain` against the real
 * catalog) is exactly the kind of logic a hand-rolled fake would flatter (UIL-012's shape), so it
 * runs against the real thing rather than a fixture map.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { loadLineScreen } from "@/lib/line";
import { OWNER, freshRpcDb, seedBinders } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const GEN = "b0000000-0000-0000-0000-0000000000f1";
const LINE = "10000000-0000-0000-0000-0000000000f1";
const SLOT_ROOT = "50000000-0000-0000-0000-0000000000f1";
const SLOT_NEXT = "50000000-0000-0000-0000-0000000000f2";
const OWNED_EMBERLING = "c0000000-0000-0000-0000-0000000000f1"; // fills the line's root slot
const UNLINED_EMBERDRAKE = "c0000000-0000-0000-0000-0000000000f2"; // should get a candidate
const DUPLICATE_EMBERLING = "c0000000-0000-0000-0000-0000000000f3"; // should get existingLineByBand

const EMBERLING_DEX = 9301;
const EMBERDRAKE_DEX = 9302;

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
});
afterEach(async () => {
  await db.close();
});

async function seedCard(
  id: string,
  name: string,
  dexId: number,
  stage: string,
  evolveFrom: string | null,
) {
  await db.query(
    `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from, card_class)
       values ($1, $2, $3, '{Fire}', $4, $5, 'standard')`,
    [id, name, [dexId], stage, evolveFrom],
  );
}

async function seedShelvedFront(copyId: string, catalogId: string) {
  await db.query(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
       values ($1, $2, $3, 'shelved', $4, 'front', 'red')`,
    [copyId, OWNER, catalogId, GEN],
  );
}

describe("loadLineScreen's unlinedCards (UIL-056)", () => {
  it("gives a fill count per candidate and explains a band whose only line has this stage filled", async () => {
    await seedBinders(db, [{ id: GEN, type: "general", name: "Binder 1" }]);
    await seedCard("emberling", "Emberling", EMBERLING_DEX, "Basic", null);
    await seedCard("emberdrake", "Emberdrake", EMBERDRAKE_DEX, "Stage1", "Emberling");
    await seedShelvedFront(OWNED_EMBERLING, "emberling");
    await seedShelvedFront(UNLINED_EMBERDRAKE, "emberdrake");
    await seedShelvedFront(DUPLICATE_EMBERLING, "emberling"); // a SECOND Emberling, duplicate

    // One line: Emberling's own slot filled, Emberdrake's stage still an open placeholder.
    await db.exec(`
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
        values ('${LINE}', '${OWNER}', ${EMBERLING_DEX}, 'red', '${GEN}', 'back', 'open');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
        values ('${SLOT_ROOT}', '${OWNER}', '${LINE}', 0, 'Basic', 'filled', '${OWNED_EMBERLING}');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state)
        values ('${SLOT_NEXT}', '${OWNER}', '${LINE}', 1, 'Stage1', 'placeholder');
      update copy set line_slot_id = '${SLOT_ROOT}', binder_half = 'back' where id = '${OWNED_EMBERLING}';
    `);

    const data = await loadLineScreen(pgliteClient(db));
    const byId = new Map(data.unlinedCards.map((c) => [c.copyId, c]));

    // A card already filling a slot is NOT unlined — it already has a line. Removing the
    // `|| c.line_slot_id` guard in load.ts's filter would let this leak in with no candidates and no
    // explanation, since it fills the very slot this test uses to derive both.
    expect(byId.has(OWNED_EMBERLING)).toBe(false);

    const drake = byId.get(UNLINED_EMBERDRAKE);
    expect(drake).toBeDefined();
    // Flat across every band now (UIL-064 part 1) — this fixture only has one band, so the flat list
    // and the old red-only slice happen to be the same length.
    expect(drake!.joinCandidates).toHaveLength(1);
    // The disambiguating info note 2 asked for — not just a species label, but progress on the line
    // — plus the candidate's OWN binder (UIL-064: picking it derives the destination binder too).
    expect(drake!.joinCandidates[0]).toMatchObject({
      lineId: LINE,
      slotId: SLOT_NEXT,
      binderId: GEN,
      bandKey: "red",
      speciesLabel: "EMBERLING LINE",
      filledCount: 1,
      totalCount: 2,
    });
    expect(drake!.existingLineByBand.red).toBeUndefined(); // it HAS an open candidate — not blocked
    // Data fields UIL-064 added: CURRENT half (not parsed from the display label) and this card's
    // own type-derived band (the "start a new line" default).
    expect(drake!.binderHalf).toBe("front");
    expect(drake!.naturalBandKey).toBe("red");

    const dupe = byId.get(DUPLICATE_EMBERLING);
    expect(dupe).toBeDefined();
    // No open candidate for the duplicate — its own (Basic) stage is already filled by the FIRST copy.
    expect(dupe!.joinCandidates).toHaveLength(0);
    // But it's explained, not just silently empty (note 3).
    expect(dupe!.existingLineByBand.red).toMatchObject({
      speciesLabel: "EMBERLING LINE",
      filledCount: 1,
      totalCount: 2,
    });
  });
});
