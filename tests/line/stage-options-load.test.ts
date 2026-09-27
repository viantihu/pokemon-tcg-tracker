/**
 * UIL-121 — the line popup's two pickers, read from a real database: the printings she can chase for a stage (the
 * species, the line's language, coloured by her colour map), and the spare copies in her bulk box.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { loadBulkFillers, loadStageOptions } from "@/lib/line/stage-options-load";
import { OWNER, freshRpcDb } from "../support/pglite-rpc";
import { pgliteClient } from "../support/pglite-client";

let db: PGlite;
afterEach(async () => {
  if (db && !db.closed) await db.close();
});

beforeEach(async () => {
  db = await freshRpcDb();
  const cards: [string, string, number[], string[], string, number | null][] = [
    ["sv03-027", "Charmeleon", [5], ["Fire"], "standard", 0.1],
    ["sv03-228", "Charmeleon", [5], ["Fire"], "specialty", 30],
    ["sv08-012", "Charmeleon", [5], ["Darkness"], "standard", 0.2],
    ["ja:sv2a-005", "Charmeleon", [5], ["Fire"], "standard", 0.05],
    ["sv01-001", "Sprigatito", [906], ["Grass"], "standard", 0.01],
  ];
  for (const [id, name, dex, types, cls, price] of cards) {
    await db.query(
      `insert into catalog_card (tcgdex_id, name, dex_id, types, card_class, price_market, locale)
         values ($1, $2, $3, $4, $5, $6, $7)`,
      [id, name, dex, types, cls, price, id.startsWith("ja:") ? "ja" : "en"],
    );
  }
  for (const [id, cardId, role] of [
    ["c0000000-0000-4000-8000-000000000001", "sv01-001", "bulk"],
    ["c0000000-0000-4000-8000-000000000002", "sv03-027", "haul"],
  ]) {
    await db.query(
      `insert into copy (id, owner_id, catalog_card_id, role) values ($1, $2, $3, $4)`,
      [id, OWNER, cardId, role],
    );
  }
});

describe("loadStageOptions", () => {
  it("the species in the line's language, coloured by her map: same colour first, the special one after", async () => {
    const out = await loadStageOptions(pgliteClient(db), 5, "en", "red");
    expect(out.map((o) => [o.card.tcgdexId, o.sameColour, o.special])).toEqual([
      ["sv03-027", true, false],
      ["sv03-228", true, true],
      ["sv08-012", false, false],
    ]);
    expect(out[2].card.bandKey).toBe("dark_blue");
  });

  it("a Japanese line gets the Japanese printing only", async () => {
    const out = await loadStageOptions(pgliteClient(db), 5, "ja", "red");
    expect(out.map((o) => o.card.tcgdexId)).toEqual(["ja:sv2a-005"]);
  });
});

describe("loadBulkFillers", () => {
  it("her bulk box only (a card still in the haul is not a spare)", async () => {
    const out = await loadBulkFillers(pgliteClient(db));
    expect(out).toEqual([
      expect.objectContaining({
        copyId: "c0000000-0000-4000-8000-000000000001",
        where: "Bulk box",
        card: expect.objectContaining({ tcgdexId: "sv01-001", name: "Sprigatito" }),
      }),
    ]);
  });
});
