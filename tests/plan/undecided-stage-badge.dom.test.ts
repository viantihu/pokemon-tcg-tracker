// @vitest-environment jsdom
/**
 * Her top blocker, on the REAL Haul Plan screen (the Senior BA's ask): with her Charmander line's Stage 1 undecided,
 * the Charmeleon in her haul wears "Adds to … line", not "Starts … line" (which, confirmed, made a second line). The
 * real page loads (pending draft, stamp), the real screen, and the real server actions over real Postgres (PGlite) as
 * the owner, the cascade included.
 */
import { createElement } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { PlanScreen } from "@/app/(ui)/plan/PlanScreen";
import { loadPendingPlacementDraft, planStateStamp } from "@/app/(ui)/plan/actions";
import { clearCatalogCache } from "@/lib/plan";
import { CHARMANDER_SV03_026, CHARMELEON_SV03_027 } from "../engine/fixtures";
import {
  asOwner,
  asSuperuser,
  freshRpcDb,
  OWNER,
  seedBinders,
  seedCatalogCardsFull,
  seedHaulCopies,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

vi.mock("@/lib/plan/session", () => ({
  getOwnerContext: async () => ({ db: pgliteClient(db), ownerId: OWNER }),
}));

const KB1 = "1c000000-0000-0000-0000-0000000000b1";
const LINE = "10000000-0000-0000-0000-0000000000a1";
const CML = "a0000000-0000-4000-8000-0000000000c1";

let db: PGlite;
beforeEach(async () => {
  window.sessionStorage.clear();
  db = await freshRpcDb();
  await seedCatalogCardsFull(db, [CHARMANDER_SV03_026, CHARMELEON_SV03_027]);
  await seedBinders(db, [{ id: KB1, type: "general", name: "KB-001" }]);
  await seedHaulCopies(db, [{ id: CML, catalogCardId: CHARMELEON_SV03_027.tcgdexId }]);
  await asSuperuser(db);
  await db.exec(`
    insert into copy (id, owner_id, catalog_card_id, variant, role, binder_id, binder_half, color_band) values
      ('c0000000-0000-0000-0000-0000000000a0', '${OWNER}', '${CHARMANDER_SV03_026.tcgdexId}', 'normal', 'shelved', '${KB1}', 'back', 'red');
    insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
      values ('${LINE}', '${OWNER}', 4, 'red', '${KB1}', 'back', 'open');
    insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id, target_catalog_card_id) values
      ('50000000-0000-0000-0000-0000000000a0', '${OWNER}', '${LINE}', 0, 'Basic', 'filled', 'c0000000-0000-0000-0000-0000000000a0', null),
      ('50000000-0000-0000-0000-0000000000a1', '${OWNER}', '${LINE}', 1, 'Stage1', 'placeholder', null, null);
    update copy set line_slot_id = '50000000-0000-0000-0000-0000000000a0' where id = 'c0000000-0000-0000-0000-0000000000a0';
  `);
  clearCatalogCache();
  await asOwner(db);
});
afterEach(async () => {
  cleanup();
  await db.close();
});

describe("the Haul Plan badges a card for her line's undecided stage as an ADD", () => {
  it("her Charmeleon wears 'Adds to … line', not 'Starts … line'", async () => {
    // As the page loads them.
    const initialPending = await loadPendingPlacementDraft();
    const stamp = await planStateStamp(initialPending.map((d) => d.id));
    render(createElement(PlanScreen, { initialPending, stateStamp: stamp }));
    await screen.findAllByText("Charmeleon", {}, { timeout: 10000 });
    const row = document.querySelector(`[id^="plan-row-"]`);
    expect(row).not.toBeNull();
    // PRE-FIX: "＋ Starts Charmeleon line".
    expect(
      await within(row as HTMLElement).findByRole("button", { name: /Adds to .* line/ }),
    ).toBeTruthy();
    expect(within(row as HTMLElement).queryByRole("button", { name: /Starts .* line/ })).toBeNull();
  });
});
