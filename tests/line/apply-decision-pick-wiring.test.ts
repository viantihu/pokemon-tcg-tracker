/**
 * UIL-057 follow-up — pins `applyDecision`'s `pickedCatalogCardId` wire END TO END against real
 * Postgres (PGlite), not just the pure `resolveDecisionWrites` unit tests in decisions.test.ts.
 *
 * PR #146 (`a108854`) threaded `pickedCatalogCardId` through
 * `app/(ui)/line/actions.ts` → `applyDecision` (`lib/line/write.ts`) → `resolveDecisionWrites`
 * (`lib/line/decisions.ts`) → `wishlistUpsertFor`. Every existing test of that pick logic calls
 * `resolveDecisionWrites` directly with a hand-built `DecisionResolution` — nothing calls the real
 * `applyDecision` and reads the `wishlist_item` row back. QA's own check proved the gap: manually
 * dropping `pickedCatalogCardId` from the `resolveDecisionWrites` call inside `applyDecision` still
 * passed 606/606. A broken wire there would silently always give her the server-computed cheapest
 * alternate no matter what she picked — exactly the bug UIL-057 was filed to fix.
 *
 * Seeds a real "ex-only-cap" decision the same way `manual-line-join.test.ts` seeds a line: real
 * 0001→0008 migrations, RLS on as `authenticated`, real `applyDecision` — not a hand-rolled fake. Two
 * catalog printings share the line's root dexId + band and are both `card_class = 'specialty'`, which
 * is exactly what `rankAlternates` (lib/engine/line.ts) requires to report `willLiveInSpecialty: true`
 * and trigger the ex-only-cap decision kind in `deriveDecisions` (lib/line/decisions.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyDecision } from "@/lib/line";
import { asOwner, asSuperuser, freshRpcDb, OWNER, seedBinders } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const GEN = "b0000000-0000-0000-0000-0000000000f1";
const LINE = "10000000-0000-0000-0000-0000000000f1";
const SLOT = "50000000-0000-0000-0000-0000000000f1";

// A fictional single-stage, ex-only Fire species — real dex accuracy is not the point (the same
// convention manual-line-join.test.ts uses). "Fire" resolves to the real seeded "red" band
// (migration 0003), so this exercises production config, not a fixture map.
const EMBEREX_DEX = 9401;
const CHEAP_ID = "emberex-cheap"; // price_market 5.00 — the server-computed default
const PRICEY_ID = "emberex-pricey"; // price_market 50.00 — the alternate she picks

const DECISION_ID = `${LINE}:ex-only-cap:0`; // see lib/line/decisions.ts ~line 213

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
});
afterEach(async () => {
  await db.close();
});

/** Seeds the two same-species, same-band, specialty-only printings the ex-only-cap decision needs. */
async function seedExOnlySpecies(): Promise<void> {
  await db.query(
    `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from, card_class, price_market)
       values ($1, 'Emberex', $2, $3, 'Basic', null, 'specialty', 5.00)`,
    [CHEAP_ID, [EMBEREX_DEX], ["Fire"]],
  );
  await db.query(
    `insert into catalog_card (tcgdex_id, name, dex_id, types, stage, evolve_from, card_class, price_market)
       values ($1, 'Emberex', $2, $3, 'Basic', null, 'specialty', 50.00)`,
    [PRICEY_ID, [EMBEREX_DEX], ["Fire"]],
  );
}

/** Seeds a real "ex-only-cap" decision: one open line, one placeholder root slot, no target yet. */
async function seedExOnlyCapDecision(): Promise<void> {
  await seedBinders(db, [{ id: GEN, type: "general", name: "Binder 1" }]);
  await seedExOnlySpecies();
  await db.query(
    `insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
       values ($1, $2, $3, 'red', $4, 'back', 'open')`,
    [LINE, OWNER, EMBEREX_DEX, GEN],
  );
  await db.query(
    `insert into line_slot (id, owner_id, line_id, stage_index, stage, state, target_catalog_card_id)
       values ($1, $2, $3, 0, 'Basic', 'placeholder', null)`,
    [SLOT, OWNER, LINE],
  );
}

async function wishlistRow(): Promise<{
  chosen_catalog_card_id: string | null;
  alternate_catalog_card_ids: string[];
} | null> {
  const r = await db.query<{
    chosen_catalog_card_id: string | null;
    alternate_catalog_card_ids: string[];
  }>(
    `select chosen_catalog_card_id, alternate_catalog_card_ids from wishlist_item where line_slot_id = $1`,
    [SLOT],
  );
  return r.rows[0] ?? null;
}

async function lineStatus(): Promise<string> {
  const r = await db.query<{ status: string }>(`select status from evolution_line where id = $1`, [
    LINE,
  ]);
  return r.rows[0].status;
}

describe("applyDecision honours pickedCatalogCardId end to end (UIL-057, real Postgres)", () => {
  it("picking the pricier printing wishlists THAT id, not the server-computed cheapest", async () => {
    await seedExOnlyCapDecision();
    await asOwner(db);

    await applyDecision(pgliteClient(db), OWNER, DECISION_ID, "confirm-cap", PRICEY_ID);

    await asSuperuser(db);
    // The assertion that actually pins the wire — it fails if pickedCatalogCardId is dropped
    // anywhere between the server action and wishlistUpsertFor.
    expect(await wishlistRow()).toEqual({
      chosen_catalog_card_id: PRICEY_ID,
      alternate_catalog_card_ids: [CHEAP_ID],
    });
    expect(await lineStatus()).toBe("capped");
  });

  it("with no pick at all, still defaults to the cheapest (regression guard)", async () => {
    await seedExOnlyCapDecision();
    await asOwner(db);

    await applyDecision(pgliteClient(db), OWNER, DECISION_ID, "confirm-cap");

    await asSuperuser(db);
    expect(await wishlistRow()).toEqual({
      chosen_catalog_card_id: CHEAP_ID,
      alternate_catalog_card_ids: [PRICEY_ID],
    });
  });

  it("REFUSES a catalog id that was never one of this decision's options, through the real wire too", async () => {
    await seedExOnlyCapDecision();
    await asOwner(db);

    await applyDecision(
      pgliteClient(db),
      OWNER,
      DECISION_ID,
      "confirm-cap",
      "some-other-unrelated-card",
    );

    await asSuperuser(db);
    // Falls back to the cheapest exactly as the unpicked path does — never trusts an arbitrary id.
    expect(await wishlistRow()).toEqual({
      chosen_catalog_card_id: CHEAP_ID,
      alternate_catalog_card_ids: [PRICEY_ID],
    });
  });
});
