// @vitest-environment jsdom
/**
 * UIL-122: the Haul Plan says "Needs a decision" only when the Lines screen will really show one for the card. Since
 * UIL-121 A2c (#432) Lines shows one decision card only, collection-vs-line; every other proposal's card retired. The
 * banner and the row's "Decide" chip showed for ANY proposal, and sent her to a Lines screen with nothing for the card:
 * a Scizor that cannot form a line (the TL's case) was the clearest.
 *
 * The REAL page loads, the REAL screen and the REAL server actions (the cascade included) over real Postgres (PGlite),
 * as the owner.
 */
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { PlanScreen } from "@/app/(ui)/plan/PlanScreen";
import { loadPendingPlacementDraft, planStateStamp } from "@/app/(ui)/plan/actions";
import { clearCatalogCache } from "@/lib/plan";
import {
  CHARMANDER_SV03_026,
  CHARMELEON_SV03_027,
  SCIZOR_SV03_141,
  SCYTHER_SV035_123,
} from "../engine/fixtures";
import {
  asOwner,
  asSuperuser,
  freshRpcDb,
  OWNER,
  seedBinders,
  seedCatalogCardsFull,
  seedCollections,
  seedHaulCopies,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

vi.mock("@/lib/plan/session", () => ({
  getOwnerContext: async () => ({ db: pgliteClient(db), ownerId: OWNER }),
}));

const KB1 = "1c000000-0000-0000-0000-0000000000b1";
const SPEC = "1c000000-0000-0000-0000-00000000c5ec";
const HAUL = "a0000000-0000-4000-8000-0000000000c1";

let db: PGlite;
beforeEach(async () => {
  window.sessionStorage.clear();
  db = await freshRpcDb();
  await seedBinders(db, [
    { id: KB1, type: "general", name: "KB-001" },
    { id: SPEC, type: "specialty", name: "Specialty A" },
  ]);
});
afterEach(async () => {
  cleanup();
  await db.close();
});

async function openPlan(name: string) {
  clearCatalogCache();
  await asOwner(db);
  const initialPending = await loadPendingPlacementDraft();
  const stamp = await planStateStamp(initialPending.map((d) => d.id));
  render(createElement(PlanScreen, { initialPending, stateStamp: stamp }));
  await screen.findAllByText(name, {}, { timeout: 10000 });
}

describe("UIL-122 · 'Needs a decision' only when the Lines screen has one for the card", () => {
  it("a Scizor that cannot form a line (its Scyther has no Metal printing) shows no banner and no 'Decide'", async () => {
    await seedCatalogCardsFull(db, [SCYTHER_SV035_123, SCIZOR_SV03_141]);
    await seedHaulCopies(db, [{ id: HAUL, catalogCardId: SCIZOR_SV03_141.tcgdexId }]);
    await openPlan("Scizor");
    // The cascade does propose something for it (a termination), which is what used to raise the banner.
    expect(document.body.textContent).toMatch(/Not enough same-colour cards yet/);
    // PRE-FIX: "Needs a decision · Confirm or override it on the Lines screen…" and a "Decide" chip.
    expect(screen.queryByText(/Needs a decision/)).toBeNull();
    expect(screen.queryByText("Decide")).toBeNull();
  });

  it("a card her collection claims while a line still needs it shows the banner, named as the Lines card names it", async () => {
    await seedCatalogCardsFull(db, [CHARMANDER_SV03_026, CHARMELEON_SV03_027]);
    await seedHaulCopies(db, [{ id: HAUL, catalogCardId: CHARMELEON_SV03_027.tcgdexId }]);
    await asSuperuser(db);
    await seedCollections(db, [
      {
        id: "c0110000-0000-0000-0000-0000000000c1",
        name: "Starters",
        targetCatalogCardIds: [CHARMELEON_SV03_027.tcgdexId],
        currentBinderIds: [SPEC],
      },
    ]);
    // Her Charmander line, its Stage 1 still to fill.
    await db.exec(`
      insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band) values
        ('c0000000-0000-0000-0000-0000000000a0', '${OWNER}', '${CHARMANDER_SV03_026.tcgdexId}', 'normal', 'shelved', '${KB1}', 'back', 'red');
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
        values ('10000000-0000-0000-0000-0000000000a1', '${OWNER}', 4, 'red', '${KB1}', 'back', 'open');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id) values
        ('50000000-0000-0000-0000-0000000000a0', '${OWNER}', '10000000-0000-0000-0000-0000000000a1', 0, 'Basic', 'filled', 'c0000000-0000-0000-0000-0000000000a0'),
        ('50000000-0000-0000-0000-0000000000a1', '${OWNER}', '10000000-0000-0000-0000-0000000000a1', 1, 'Stage1', 'placeholder', null);
      update copy set line_slot_id = '50000000-0000-0000-0000-0000000000a0' where id = 'c0000000-0000-0000-0000-0000000000a0';
    `);
    await openPlan("Charmeleon");
    expect(await screen.findByText("Needs a decision: collection claim vs line slot")).toBeTruthy();
    expect(screen.getByText(/decide whether the collection still wins/)).toBeTruthy();
    expect(screen.getAllByText("Decide").length).toBeGreaterThan(0);
  });
});
