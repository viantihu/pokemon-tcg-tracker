// @vitest-environment jsdom
/**
 * Karvi (2026-09-27): "A basic with no evolution should not be allowed to get put in the 'lines' area." Backfill's back
 * half starts a line from a species she picks, so its species picker must not offer one: before this, she could pick
 * it, walk its stage and only Save refused (the Senior BA's gate item on #422).
 *
 * The REAL screen, the REAL grid and the REAL `lookupLineSpecies` action (its catalog and its filter), over real
 * Postgres (PGlite) as the owner: she types "Char", and the single-stage "Charlone" is not listed while the Charmander
 * family is. The name search itself is stood in by a plain `ilike` over the same rows (the PGlite client does not
 * speak PostgREST's `or()`); it hands back all three, so the filter is what keeps Charlone out.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { BackfillScreen } from "@/app/(ui)/backfill/BackfillScreen";
import { clearCatalogCache } from "@/lib/plan";
import { catalogCardRepo, type Row } from "@/lib/repo";
import type { CatalogCard } from "@/lib/engine";
import { CHARMANDER_SV03_026, CHARMELEON_SV03_027 } from "../engine/fixtures";
import {
  asOwner,
  freshRpcDb,
  OWNER,
  seedBinders,
  seedCatalogCardsFull,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

// The actions' owner seam needs a real request; hand it the PGlite client instead (tests/plan/line-done).
vi.mock("@/lib/plan/session", () => ({
  getOwnerContext: async () => ({ db: pgliteClient(db), ownerId: OWNER }),
}));

/** A Basic nothing evolves from, and that evolves from nothing: a Tauros-type card, named to match "Char". */
const CHARLONE: CatalogCard = {
  ...CHARMANDER_SV03_026,
  tcgdexId: "sv03-128",
  name: "Charlone",
  dexId: [9128],
  localId: "128",
  stage: "Basic",
  evolveFrom: null,
  artworkGroupId: "art-charlone",
};

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedCatalogCardsFull(db, [CHARMANDER_SV03_026, CHARMELEON_SV03_027, CHARLONE]);
  await seedBinders(db, [
    { id: "1c000000-0000-0000-0000-0000000000b1", type: "general", name: "KB-001" },
  ]);
  clearCatalogCache();
  await asOwner(db);
  vi.spyOn(catalogCardRepo, "search").mockImplementation(async (_db, q) => {
    const r = await db.query<Row<"catalog_card">>(
      `select * from catalog_card where name ilike $1 order by name`,
      [`%${q}%`],
    );
    return r.rows;
  });
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await db.close();
});

describe("Backfill's back half offers only a species that forms a line", () => {
  it("a single-stage Basic is not listed; the Charmander family is", async () => {
    const user = userEvent.setup();
    render(createElement(BackfillScreen));
    await user.click(await screen.findByRole("button", { name: "Back half" }));
    await user.type(screen.getByLabelText("Card lookup"), "Char");
    const list = await screen.findByRole("listbox", { name: "Matching cards" }, { timeout: 5000 });
    await waitFor(() => expect(within(list).getAllByRole("option").length).toBeGreaterThan(0));
    const names = within(list)
      .getAllByRole("option")
      .map((o) => o.querySelector(".cn")?.textContent);
    expect(names).toEqual(expect.arrayContaining(["Charmander", "Charmeleon"]));
    expect(names).not.toContain("Charlone");
    // The search did hand it back: the filter is what kept it out.
    const searched = await vi.mocked(catalogCardRepo.search).mock.results[0].value;
    expect(searched.map((r: Row<"catalog_card">) => r.name)).toContain("Charlone");
  });
});
