/**
 * Karvi 2026-11-11 — one wrong match must not mis-file a whole set.
 *
 * Her Classic Collection Sneasel (Dex `me55cc-5`, "5/30") was matched to the Neo Genesis original (`neo1-25`). That
 * one match taught `me55cc → neo1`, and the next import filed her Mew VMAX (Dex `me55cc-28`, "28/30") as Neo Genesis
 * #28 — Bayleef — without a word. Two guards, each enough on its own:
 *   1. a match teaches its set only when it is a number-for-number step (same number, set size not contradicted);
 *   2. a card found through an alias she taught must carry the row's name, or the row waits for her.
 */
import { describe, expect, it } from "vitest";
import { namesAgree, resolveAgainstCatalog, type CatalogPort } from "@/lib/sync/catalog-lookup";
import { aliasInconsistency } from "@/lib/sync/exec";
import { resolveDexId } from "@/lib/sync/resolve";
import type { DexRow } from "@/lib/sync/types";

const SNEASEL_ROW = { dex_id: "me55cc-5", dex_number: "5/30" };

describe("a match teaches its set only when it is a number-for-number step", () => {
  it("refuses her Classic Collection Sneasel matched to the Neo Genesis original", () => {
    expect(aliasInconsistency(SNEASEL_ROW, { localId: "25", setCardCount: 111 })).toMatch(
      /set was not learned.*#25.*#5/,
    );
  });

  it("refuses a match whose number agrees but whose set size contradicts the row's", () => {
    expect(aliasInconsistency(SNEASEL_ROW, { localId: "005", setCardCount: 111 })).toMatch(
      /111-card set.*out of 30/,
    );
  });

  it("learns from a match that lines up: same number (padding aside), and a size that agrees or is unknown", () => {
    expect(aliasInconsistency(SNEASEL_ROW, { localId: "005", setCardCount: 30 })).toBeNull();
    expect(aliasInconsistency(SNEASEL_ROW, { localId: "5", setCardCount: null })).toBeNull();
    expect(
      aliasInconsistency(
        { dex_id: "sv3pt5-25", dex_number: "25" },
        { localId: "025", setCardCount: 165 },
      ),
    ).toBeNull();
  });
});

function row(fields: Partial<DexRow>): DexRow {
  return {
    Type: "collection",
    Category: "My Collection",
    Locale: "English",
    Series: "",
    Set: "",
    Id: "",
    Number: "",
    Name: "",
    Variant: "Holo",
    Rarity: "",
    Illustrator: "",
    Quantity: "1",
    Price: "",
    Notes: "",
    ...fields,
  };
}

const NEO = [
  { setId: "neo1", localId: "25", tcgdexId: "neo1-25", name: "Sneasel" },
  { setId: "neo1", localId: "28", tcgdexId: "neo1-28", name: "Bayleef" },
];
const port: CatalogPort = {
  async findBySetLocal(setId, localId) {
    return NEO.filter((c) => c.setId === setId && c.localId === localId);
  },
  async findSetIdsByName() {
    return [];
  },
  async findSetIdsFoldingCase() {
    return [];
  },
  async learnAlias() {},
};

describe("a card found through an alias she taught must carry the row's name", () => {
  const LEARNED = { "en:me55cc": "neo1" };

  it("parks her Mew VMAX instead of filing it as Bayleef", async () => {
    const mew = row({
      Id: "me55cc-28",
      Name: "Mew VMAX",
      Set: "30th Celebration: Classic Collection",
    });
    const resolved = resolveDexId(mew, LEARNED);
    expect(resolved.learned).toBe(true);
    expect(await resolveAgainstCatalog(port, mew, resolved)).toEqual({
      catalogCardId: null,
      reason: "UNKNOWN_CARD",
    });
  });

  it("still resolves a card whose name agrees", async () => {
    const neo = row({ Id: "me55cc-25", Name: "Sneasel" });
    expect(await resolveAgainstCatalog(port, neo, resolveDexId(neo, LEARNED))).toEqual({
      catalogCardId: "neo1-25",
    });
  });

  it("does not second-guess a passthrough code (TCGdex's own) or a Japanese row", async () => {
    const passthrough = row({ Id: "neo1-28", Name: "Mew VMAX" });
    expect(await resolveAgainstCatalog(port, passthrough, resolveDexId(passthrough, {}))).toEqual({
      catalogCardId: "neo1-28",
    });
  });

  it("reads names loosely: case, punctuation, and one name's words inside the other's", () => {
    expect(namesAgree("Basic Grass Energy", "Grass Energy")).toBe(true);
    expect(namesAgree("MEW VMAX", "Mew VMAX")).toBe(true);
    expect(namesAgree("Mr. Mime", "Mr Mime")).toBe(true);
    expect(namesAgree("Mew VMAX", "Bayleef")).toBe(false);
    expect(namesAgree("", "Bayleef")).toBe(true);
  });
});
