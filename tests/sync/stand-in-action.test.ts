/**
 * UIL-060 Half 1 — the server action behind the form, on real Postgres: `createStandInAndMatch` derives
 * the set id from what the resolver already knows (never typed), creates the stand-in and matches the
 * entry in one RPC, and turns a twin into a structured refusal the screen can act on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { DbClient } from "@/lib/repo";
import { createStandInAndMatch, loadSyncState } from "@/app/(ui)/sync/actions";
import { asOwner, asSuperuser, freshRpcDb, OWNER } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

let db: PGlite;
vi.mock("@/lib/plan/session", () => ({
  getOwnerContext: async () => ({ db: pgliteClient(db) as DbClient, ownerId: OWNER }),
  SEEDED_OWNER_ID: "00000000-0000-0000-0000-000000000001",
}));

const KNOWN = "e0000000-0000-0000-0000-0000000000e1"; // UNKNOWN_CARD in a set the mirror has
const UNKNOWN = "e0000000-0000-0000-0000-0000000000e2"; // UNKNOWN_SET, no such set anywhere

beforeEach(async () => {
  db = await freshRpcDb();
  await db.exec(`
    insert into catalog_card (tcgdex_id, name, set_id, set_name, local_id, types)
      values ('sv03-027', 'Charmeleon', 'sv03', 'Obsidian Flames', '027', '{Fire}');
    insert into unresolved_entry (id, owner_id, dex_id, dex_set_name, dex_number, dex_name, dex_variant_raw, quantity, locale, reason, status) values
      ('${KNOWN}', '${OWNER}', 'sv03-999', 'Obsidian Flames', '999', 'Mystery Fossil', 'Normal', 2, 'English', 'UNKNOWN_CARD', 'WAITING'),
      ('${UNKNOWN}', '${OWNER}', 'zz9-1', 'A Set Nobody Has', '1', 'Ghost Card', '', 1, 'English', 'UNKNOWN_SET', 'WAITING');
  `);
  await asOwner(db);
});
afterEach(async () => {
  await db.close();
});

describe("UIL-060 · createStandInAndMatch", () => {
  it("derives the set id when the mirror knows the set, creates the stand-in and matches, one RPC", async () => {
    const r = await createStandInAndMatch(KNOWN, {
      name: "Mystery Fossil",
      setName: "Obsidian Flames",
      localId: "999",
      language: "en" as const,
      kind: { kind: "pokemon", type: "Fire", stage: "Basic", dexId: 4 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [card] = (
      await db.query<{ set_id: string; source: string; types: string[] }>(
        `select set_id, source, types from catalog_card where tcgdex_id = '${r.standInId}'`,
      )
    ).rows;
    expect(card).toEqual({ set_id: "sv03", source: "user", types: ["Fire"] });
    expect(
      (await db.query(`select status, manual_match_id from unresolved_entry where id = '${KNOWN}'`))
        .rows,
    ).toEqual([{ status: "RESOLVED", manual_match_id: r.standInId }]);
    expect((await db.query<{ n: number }>(`select count(*)::int as n from copy`)).rows).toEqual([
      { n: 2 },
    ]);
  });

  it("leaves the set id null for an UNKNOWN_SET entry — nothing is known, nothing is guessed", async () => {
    const r = await createStandInAndMatch(UNKNOWN, {
      name: "Ghost Card",
      setName: "A Set Nobody Has",
      localId: "1",
      language: "en" as const,
      kind: { kind: "trainer" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [card] = (
      await db.query<{ set_id: string | null; set_name: string; stage: string | null }>(
        `select set_id, set_name, stage from catalog_card where tcgdex_id = '${r.standInId}'`,
      )
    ).rows;
    expect(card).toEqual({ set_id: null, set_name: "A Set Nobody Has", stage: null });
  });

  it("a twin comes back structured — the existing stand-in to match instead — and nothing new is written", async () => {
    const input = {
      name: "Mystery Fossil",
      setName: "Obsidian Flames",
      localId: "999",
      language: "en" as const,
      kind: { kind: "trainer" as const },
    };
    const first = await createStandInAndMatch(KNOWN, input);
    expect(first.ok).toBe(true);
    // A second entry for the same physical card (another variant row).
    await asSuperuser(db);
    await db.exec(`
      insert into unresolved_entry (id, owner_id, dex_id, dex_set_name, dex_number, dex_name, dex_variant_raw, quantity, locale, reason, status)
        values ('e0000000-0000-0000-0000-0000000000e3', '${OWNER}', 'sv03-999', 'Obsidian Flames', '999', 'Mystery Fossil', 'Reverse Holo', 1, 'English', 'UNKNOWN_CARD', 'WAITING');
    `);
    await asOwner(db);
    const second = await createStandInAndMatch("e0000000-0000-0000-0000-0000000000e3", input);
    expect(second.ok).toBe(false);
    if (second.ok || !("twin" in second)) throw new Error("expected a twin refusal");
    expect(second.twin).toMatchObject({
      name: "Mystery Fossil",
      setName: "Obsidian Flames",
      localId: "999",
    });
    expect(second.twin.tcgdexId).toBe(first.ok ? first.standInId : "");
    expect(
      (
        await db.query<{ n: number }>(
          `select count(*)::int as n from catalog_card where source = 'user'`,
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
  });

  it("the sync state carries the card types for the form", async () => {
    const state = await loadSyncState();
    expect(state.cardTypes.length).toBeGreaterThan(5);
    expect(state.cardTypes).toContain("Fire");
    expect([...state.cardTypes].sort()).toEqual(state.cardTypes);
  });
});
