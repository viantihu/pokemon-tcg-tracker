/**
 * UIL-069 — a colour mismatch between a card's own band and the line it would join must be ASKED,
 * never decided silently. Karvi's ruling reverses UIL-065/#154's own "the line's band wins" default:
 * she is shown both options on the Haul Plan spotlight (a manually-created line, in a band she chose
 * herself, most likely) with neither pre-selected, and picks one every time.
 *
 * Since UIL-117 every card headed into a line waits for her explicit choice in the line popup, so the two
 * options arrive as:
 *   - "join the line": her `lineChoice` (join), written by the one line builder over fresh state. The older
 *     `bandChoice: "line"` + digest is superseded, and on its own no longer places anything;
 *   - "file by its own colour": `override`, reusing `writeOverriddenCard` verbatim, as before.
 *
 * Run against the REAL `apply_write_ops` RPC on real Postgres (PGlite), as the authenticated owner —
 * the pattern `spotlight-drift.test.ts`/`confirm-line-pulls.test.ts` already established for exactly
 * this reason: a hand-rolled applier proves the ops match the author's expectation and nothing about
 * the function that runs in production.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  clearCatalogCache,
  commitCardPlacement,
  LINE_CHOICE,
  deriveSpotlightPlacement,
  type DraftItem,
} from "@/lib/plan";
import { CHARMANDER_SV03_026, CHARMELEON_SV03_027 } from "../engine/fixtures";
import {
  asOwner,
  asSuperuser,
  freshRpcDb,
  OWNER,
  haulRow,
  seedBinders,
  seedCatalogCardsFull,
  seedHaulRows,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const B1 = "1c000000-0000-0000-0000-0000000000b1";
const LINE = "10000000-0000-0000-0000-0000000000e9";
const SLOT_BASIC = "50000000-0000-0000-0000-0000000000e1";
const SLOT_STAGE1 = "50000000-0000-0000-0000-0000000000e2";
const OWNED_CHARMANDER = "c0000000-0000-0000-0000-0000000000e1";

const CATALOG = [CHARMANDER_SV03_026, CHARMELEON_SV03_027];

/** The card in this haul: a Charmeleon, natural band "red" — a copy her import made (UIL-098). */
const INCOMING: DraftItem = haulRow(
  "d0000000-0000-4000-8000-0000000000c1",
  CHARMELEON_SV03_027.tcgdexId,
);

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedCatalogCardsFull(db, CATALOG);
  await seedBinders(db, [{ id: B1, type: "general", name: "Binder 1" }]);
  await seedHaulRows(db, [INCOMING]);
  clearCatalogCache();
});
afterEach(async () => {
  await db.close();
});

/**
 * A Charmander line she built herself in "green" — NOT Fire's natural "red" — Basic filled, Stage1
 * (the incoming Charmeleon's own stage) open. `target_catalog_card_id` is required on the placeholder:
 * `lib/plan/context.ts`'s `dexIdForSlot` resolves a slot's species from it (or a filled copy), never
 * by chain-walking `root_dex_id` the way `lib/line/load.ts` does — an unset target here would make the
 * slot unmatchable and every assertion below pass vacuously.
 */
async function seedMismatchedLine(): Promise<void> {
  await db.query(
    `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
       values ($1, $2, $3, 'shelved', $4, 'back', 'green')`,
    [OWNED_CHARMANDER, OWNER, CHARMANDER_SV03_026.tcgdexId, B1],
  );
  await db.exec(`
    insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
      values ('${LINE}', '${OWNER}', 4, 'green', '${B1}', 'back', 'open');
    insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
      values ('${SLOT_BASIC}', '${OWNER}', '${LINE}', 0, 'Basic', 'filled', '${OWNED_CHARMANDER}');
    insert into line_slot (id, owner_id, line_id, stage_index, stage, state, target_catalog_card_id)
      values ('${SLOT_STAGE1}', '${OWNER}', '${LINE}', 1, 'Stage1', 'placeholder', '${CHARMELEON_SV03_027.tcgdexId}');
    update copy set line_slot_id = '${SLOT_BASIC}' where id = '${OWNED_CHARMANDER}';
  `);
}

/** The incoming copy as the import left it: in her haul, placed nowhere. "Nothing written" reads as this. */
const UNPLACED = {
  role: "haul",
  binder_id: null,
  binder_half: null,
  color_band: null,
  line_slot_id: null,
};

async function chargedCopyRow(): Promise<{
  role: string;
  binder_id: string | null;
  binder_half: string | null;
  color_band: string | null;
  line_slot_id: string | null;
} | null> {
  const rows = (
    await db.query<{
      role: string;
      binder_id: string | null;
      binder_half: string | null;
      color_band: string | null;
      line_slot_id: string | null;
    }>(
      `select role, binder_id, binder_half, color_band, line_slot_id from copy where catalog_card_id = $1`,
      [CHARMELEON_SV03_027.tcgdexId],
    )
  ).rows;
  return rows[0] ?? null;
}

async function decisionRow(): Promise<{
  decision: string;
  reason: string;
  resolved_by: string;
} | null> {
  const rows = (
    await db.query<{ decision: string; reason: string; resolved_by: string }>(
      `select pd.decision, pd.reason, pd.resolved_by from placement_decision pd
         join copy c on c.id = pd.copy_id where c.catalog_card_id = $1`,
      [CHARMELEON_SV03_027.tcgdexId],
    )
  ).rows;
  return rows[0] ?? null;
}

describe("UIL-069 · the spotlight offers both options, neither pre-selected", () => {
  it("derives lineSpeciesLabel, both destinations, and a ready-to-send own-colour override", async () => {
    await seedMismatchedLine();
    const client = pgliteClient(db);
    await asOwner(db);

    const placement = await deriveSpotlightPlacement(client, INCOMING);

    expect(placement!.bandMismatch).toMatchObject({
      lineSpeciesLabel: "CHARMANDER LINE",
      // Display-cased band names (real seeded color_band.display_name), the DB-key band underneath.
      lineDestination: "Binder 1 · Back · Green",
      ownColorDestination: "Binder 1 · Front · Red",
      ownColorMoveDestination: { kind: "shelf", binderId: B1, half: "front", band: "red" },
    });
  });

  it("has no bandMismatch at all when the line's band matches the card's own (the common case)", async () => {
    // Same fixture, but the line lives in "red" — Charmeleon's own natural band.
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
         values ($1, $2, $3, 'shelved', $4, 'back', 'red')`,
      [OWNED_CHARMANDER, OWNER, CHARMANDER_SV03_026.tcgdexId, B1],
    );
    await db.exec(`
      insert into evolution_line (id, owner_id, root_dex_id, color_band, binder_id, half, status)
        values ('${LINE}', '${OWNER}', 4, 'red', '${B1}', 'back', 'open');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, copy_id)
        values ('${SLOT_BASIC}', '${OWNER}', '${LINE}', 0, 'Basic', 'filled', '${OWNED_CHARMANDER}');
      insert into line_slot (id, owner_id, line_id, stage_index, stage, state, target_catalog_card_id)
        values ('${SLOT_STAGE1}', '${OWNER}', '${LINE}', 1, 'Stage1', 'placeholder', '${CHARMELEON_SV03_027.tcgdexId}');
      update copy set line_slot_id = '${SLOT_BASIC}' where id = '${OWNED_CHARMANDER}';
    `);
    const client = pgliteClient(db);
    await asOwner(db);

    const placement = await deriveSpotlightPlacement(client, INCOMING);
    expect(placement!.bandMismatch).toBeNull();
  });
});

describe("UIL-069 · commitCardPlacement refuses an unresolved mismatch", () => {
  it("REFUSES with no override and no bandChoice — the exact silent default her ruling rejects", async () => {
    await seedMismatchedLine();
    const client = pgliteClient(db);
    await asOwner(db);

    // Refused by UIL-117's rule, which subsumes UIL-069's: no line card is placed without her choice.
    await expect(commitCardPlacement(client, { card: INCOMING })).rejects.toThrow(
      LINE_CHOICE.missing,
    );

    await asSuperuser(db);
    expect(await chargedCopyRow()).toMatchObject(UNPLACED); // nothing written: still in her haul
  });

  it("a digest ALONE — with no bandChoice — is NOT enough: it rides along on every card regardless", async () => {
    await seedMismatchedLine();
    const client = pgliteClient(db);
    await asOwner(db);
    const placement = await deriveSpotlightPlacement(client, INCOMING);

    await expect(
      commitCardPlacement(client, {
        card: INCOMING,
        expectedDigest: placement!.digest,
      }),
    ).rejects.toThrow(LINE_CHOICE.missing);

    await asSuperuser(db);
    expect(await chargedCopyRow()).toMatchObject(UNPLACED);
  });
});

describe('UIL-069 · picking "join the line"', () => {
  it("fills the placeholder, completes the line, and audits her CHOICE — not the generic auto reason", async () => {
    await seedMismatchedLine();
    const client = pgliteClient(db);
    await asOwner(db);
    const placement = await deriveSpotlightPlacement(client, INCOMING);

    await commitCardPlacement(client, {
      card: INCOMING,
      lineChoice: { mode: "join", lineId: LINE, slotId: SLOT_STAGE1 },
    });

    await asSuperuser(db);
    const copy = await chargedCopyRow();
    expect(copy).toMatchObject({
      binder_half: "back",
      color_band: "green",
      line_slot_id: SLOT_STAGE1,
    });
    const slot = (
      await db.query<{ state: string }>(`select state from line_slot where id = '${SLOT_STAGE1}'`)
    ).rows[0];
    expect(slot.state).toBe("filled");
    // The last open slot filled, so the line completes (UIL-117 gap 4). This used to pin "open": the Haul
    // Plan's slot fill never transitioned the line, the gap this comment flagged; it now shares the Move path's
    // builder.
    const line = (
      await db.query<{ status: string }>(`select status from evolution_line where id = '${LINE}'`)
    ).rows[0];
    expect(line.status).toBe("complete");

    const decision = await decisionRow();
    expect(decision?.resolved_by).toBe("user"); // her call, not "auto" — she was explicitly asked
    expect(decision?.reason).toMatch(/colour mismatch/i);
    expect(decision?.reason).not.toBe(placement!.item.reason); // not the generic "Fills the open…" text
  });

  it('REFUSES bandChoice "line" with no line choice — the old flag places nothing on its own now', async () => {
    await seedMismatchedLine();
    const client = pgliteClient(db);
    await asOwner(db);

    // A caller that sends the flag but skips the anti-drift digest could send "line" on every card
    // regardless of whether she was ever actually asked — the digest is what proves THIS derivation,
    // with THIS mismatch, is the one she looked at.
    await expect(
      commitCardPlacement(client, { card: INCOMING, bandChoice: "line" }),
    ).rejects.toThrow(LINE_CHOICE.missing);

    await asSuperuser(db);
    expect(await chargedCopyRow()).toMatchObject(UNPLACED);
  });
});

describe('UIL-069 · picking "file by its own colour"', () => {
  it("shelves to the front half in HER own band, leaves the line's placeholder untouched, and audits her choice", async () => {
    await seedMismatchedLine();
    const client = pgliteClient(db);
    await asOwner(db);
    const placement = await deriveSpotlightPlacement(client, INCOMING);

    await commitCardPlacement(client, {
      card: INCOMING,
      override: placement!.bandMismatch!.ownColorMoveDestination,
    });

    await asSuperuser(db);
    const copy = await chargedCopyRow();
    expect(copy).toMatchObject({
      binder_half: "front",
      color_band: "red",
      line_slot_id: null, // never joined the line
    });
    const slot = (
      await db.query<{ state: string }>(`select state from line_slot where id = '${SLOT_STAGE1}'`)
    ).rows[0];
    expect(slot.state).toBe("placeholder"); // untouched — she filed it elsewhere

    const decision = await decisionRow();
    expect(decision?.resolved_by).toBe("user");
    expect(decision?.reason).toMatch(/colour mismatch/i);
    // The bug the Senior BA flagged in review: reusing the generic override reason here would quote
    // `result.reason`, which describes the LINE option — the one she did NOT pick.
    expect(decision?.reason).not.toMatch(/existing green line/i);
  });
});

// No coverage for the whole-haul bulk path here, deliberately: `commitHaul`/`commitHaulAction` had
// zero callers and are now removed entirely (a separate commit in this PR, on Karvi's explicit
// instruction) — there is nothing left to guard or test.
// and is being deleted on Karvi's explicit instruction ("delete it, we're not going back to bulk
// commit" — docs/issue-log.md's UIL-027 update). A refusal guard there was considered and dropped as
// moot for the same reason.
