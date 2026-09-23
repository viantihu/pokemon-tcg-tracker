/**
 * UIL-092 part 2 — committing one hand-added draft row twice writes ONE copy.
 *
 * Karvi typed a Meditite once and ended up with two copies of it. The per-card commit's `catch` leaves the
 * row actionable after a transport failure (PlanScreen: `done` is only set on a returned success), so a
 * write that succeeded server-side but lost its response gets re-pressed — and a typed row has no
 * `existingCopyId` to route, so every attempt used to mint a fresh uuid and insert again. The reset this
 * entry's part 1 fixes is the other way in: her typed row was discarded, she re-typed it, and committed a
 * second copy of a card already in a binder.
 *
 * The key is the DRAFT ROW, never the catalog card. She legitimately owns duplicates — two typed rows of
 * one printing must still become two copies — so the third case here is as load-bearing as the first.
 *
 * Against the REAL `apply_write_ops` RPC on real Postgres (PGlite) as the authenticated owner, the pattern
 * band-mismatch-ask.test.ts established: a hand-rolled applier would prove only that the ops match my
 * expectation, not that the function running in production accepts them.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { clearCatalogCache, commitCardPlacement, type DraftItem } from "@/lib/plan";
import { copyIdForTypedRow } from "@/lib/plan/commit";
import { CHARMANDER_SV03_026 } from "../engine/fixtures";
import {
  asOwner,
  asSuperuser,
  freshRpcDb,
  OWNER,
  seedBinders,
  seedCatalogCardsFull,
} from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

const B1 = "1c000000-0000-0000-0000-0000000000b1";

/** Her row, with the client-generated uuid the screen actually sends (UIL-092 made `newId` always one). */
const ROW_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const SECOND_ROW_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

const typedRow = (id: string): DraftItem => ({
  id,
  tcgdexId: CHARMANDER_SV03_026.tcgdexId,
  variant: "normal",
});

let db: PGlite;
beforeEach(async () => {
  db = await freshRpcDb();
  await seedCatalogCardsFull(db, [CHARMANDER_SV03_026]);
  await seedBinders(db, [{ id: B1, type: "general", name: "Binder 1" }]);
  clearCatalogCache();
});
afterEach(async () => {
  await db.close();
});

async function copies(): Promise<{ id: string; haul_id: string | null }[]> {
  await asSuperuser(db);
  const r = await db.query<{ id: string; haul_id: string | null }>(
    `select id, haul_id from copy where catalog_card_id = $1 order by id`,
    [CHARMANDER_SV03_026.tcgdexId],
  );
  return r.rows;
}
async function countOf(table: string): Promise<number> {
  await asSuperuser(db);
  const r = await db.query<{ n: number }>(`select count(*)::int n from ${table}`);
  return r.rows[0].n;
}

describe("UIL-092 · the per-card commit is idempotent per draft row", () => {
  it("a re-press after a lost response writes NO second copy", async () => {
    const client = pgliteClient(db);
    await asOwner(db);
    const first = await commitCardPlacement(client, { source: "bulk-bin", card: typedRow(ROW_ID) });
    expect(first.counts.copies).toBe(1);

    // Exactly what the screen does when the response never arrived: same row, pressed again.
    await asOwner(db);
    const second = await commitCardPlacement(client, {
      source: "bulk-bin",
      card: typedRow(ROW_ID),
    });

    // Pre-fix this was 2 rows — her two Meditites.
    expect(await copies()).toHaveLength(1);
    expect(second.alreadyCommitted).toBe(true);
    expect(second.counts.copies).toBe(0);
  });

  it("the copy is written AT the draft row's id — that is the whole key", async () => {
    const client = pgliteClient(db);
    await asOwner(db);
    await commitCardPlacement(client, { source: "bulk-bin", card: typedRow(ROW_ID) });
    expect((await copies())[0].id).toBe(ROW_ID);
    expect(copyIdForTypedRow(ROW_ID)).toBe(ROW_ID);
  });

  it("TWO typed rows of the SAME printing still write two copies — she owns duplicates", async () => {
    // The deduplication must never be by catalog card. Two rows, one printing, two physical cards.
    const client = pgliteClient(db);
    await asOwner(db);
    await commitCardPlacement(client, { source: "bulk-bin", card: typedRow(ROW_ID) });
    await asOwner(db);
    await commitCardPlacement(client, { source: "bulk-bin", card: typedRow(SECOND_ROW_ID) });

    expect((await copies()).map((c) => c.id)).toEqual([ROW_ID, SECOND_ROW_ID].sort());
  });

  it("the re-press opens no second haul and audits nothing twice", async () => {
    const client = pgliteClient(db);
    await asOwner(db);
    const first = await commitCardPlacement(client, { source: "bulk-bin", card: typedRow(ROW_ID) });
    const hauls = await countOf("haul");
    const decisions = await countOf("placement_decision");

    // The client whose response was lost has no haul id to send, so the second attempt cannot supply one.
    await asOwner(db);
    const second = await commitCardPlacement(client, {
      source: "bulk-bin",
      card: typedRow(ROW_ID),
    });

    expect(await countOf("haul")).toBe(hauls);
    expect(await countOf("placement_decision")).toBe(decisions);
    // And the haul id comes back from the EXISTING row, so the rest of the sitting stays one haul.
    expect(second.haulId).toBe(first.haulId);
    expect((await copies())[0].haul_id).toBe(first.haulId);
  });

  it("a non-uuid row id still commits, giving up only idempotency", async () => {
    // A draft parked by a pre-UIL-092 build carries `d-<random>`. Failing the whole transaction on a uuid
    // column would lose the card to save the retry, so that path mints an id and writes.
    const client = pgliteClient(db);
    await asOwner(db);
    await commitCardPlacement(client, { source: "bulk-bin", card: typedRow("d-legacy") });
    const rows = await copies();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).not.toBe("d-legacy");
    expect(copyIdForTypedRow("d-legacy")).not.toBe("d-legacy");
  });

  it("a ROUTED row is untouched by any of this — its copy already existed", async () => {
    // UIL-003's path: the copy exists, the commit patches its placement. Re-running the same patch is
    // idempotent by nature, and the row's id belongs to a copy that predates the draft.
    await asSuperuser(db);
    const existing = "c0000000-0000-0000-0000-00000000dddd";
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, role, binder_id, binder_half, color_band)
         values ($1, $2, $3, 'haul', null, null, null)`,
      [existing, OWNER, CHARMANDER_SV03_026.tcgdexId],
    );
    const client = pgliteClient(db);
    await asOwner(db);
    const res = await commitCardPlacement(client, {
      source: "bulk-bin",
      card: { ...typedRow(existing), existingCopyId: existing },
    });
    expect(res.alreadyCommitted).toBeUndefined();
    expect(res.counts.routed).toBe(1);
    expect(res.counts.copies).toBe(0);
    expect(await copies()).toHaveLength(1); // routed, not duplicated
  });
});
