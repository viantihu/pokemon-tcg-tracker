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

/** The slot's own stored target — what every reader BUT the wishlist goes by (UIL-091). */
async function slotTarget(): Promise<string | null> {
  const r = await db.query<{ target_catalog_card_id: string | null }>(
    `select target_catalog_card_id from line_slot where id = $1`,
    [SLOT],
  );
  return r.rows[0]?.target_catalog_card_id ?? null;
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

  it("re-points the SLOT's stored target to her pick, so the screen stops showing the old card (UIL-091)", async () => {
    /**
     * PRE-FIX this stayed CHEAP_ID. `line_slot.target_catalog_card_id` was written once at insert time and
     * never again, and `lib/line/load.ts` resolves a placeholder as `targetCc ?? alt[0]` — the stored target
     * wins — so the Lines screen kept showing the printing she had just replaced.
     *
     * The slot is the thing that has to change, not the loader: `lib/plan/context.ts`'s `dexIdForSlot`
     * resolves a slot's species from this column, `lib/plan/fingerprint.ts` carries it in the plan stamp,
     * `toEvolutionLine` hands it to the engine, and migration 0019 read it to decide a line's locale.
     */
    await seedExOnlyCapDecision();
    await asOwner(db);
    await applyDecision(pgliteClient(db), OWNER, DECISION_ID, "confirm-cap", PRICEY_ID);

    await asSuperuser(db);
    expect(await slotTarget()).toBe(PRICEY_ID);
    // And nothing is lost: the option she moved away from is still on the wishlist row as an alternate.
    expect(await wishlistRow()).toEqual({
      chosen_catalog_card_id: PRICEY_ID,
      alternate_catalog_card_ids: [CHEAP_ID],
    });
  });

  it("leaves the stored target NULL when she picks nothing — the default stays live", async () => {
    /**
     * The other half of UIL-091, and the half that is easy to break while fixing the first. A placeholder
     * with no stored target displays `altOptions`' cheapest computed at LOAD, so it follows prices and new
     * printings. Stamping the engine's current answer here would freeze it: a live default silently becomes
     * a stale decision nobody made. Migration 0019 depends on the same reading — a null target means "ask
     * again at load", which is why it RELEASED foreign targets instead of re-pointing them.
     *
     * My first cut of this fix did stamp it, and this case is what caught it.
     */
    await seedExOnlyCapDecision();
    expect(await slotTarget()).toBeNull(); // the seed's own state: no target, decided at load
    await asOwner(db);
    await applyDecision(pgliteClient(db), OWNER, DECISION_ID, "confirm-cap");

    await asSuperuser(db);
    expect(await slotTarget()).toBeNull();
  });

  it("a REFUSED pick does not re-point the slot either", async () => {
    // The validation lives in one place (`chosenTargetFor`), so an id that was never an option cannot reach
    // the slot any more than it can reach the wishlist. Pinned because the slot is the higher-stakes one:
    // the engine plans against it.
    await seedExOnlyCapDecision();
    await asOwner(db);
    await applyDecision(pgliteClient(db), OWNER, DECISION_ID, "confirm-cap", "not-an-option");

    await asSuperuser(db);
    expect(await slotTarget()).toBeNull(); // refused, so nothing was her choice and nothing is stored
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
