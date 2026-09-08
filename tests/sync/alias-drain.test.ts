import { describe, it, expect } from "vitest";
import { resolveAgainstCatalog, type CatalogPort } from "@/lib/sync/catalog-lookup";
import { parseDexId, resolveDexId, SET_ALIAS_SEED } from "@/lib/sync/resolve";

/**
 * "One manual set-match drains the whole set" (sync-ui-spec §A.8, §D). Manual-match records the
 * learned `(locale, dexCode) → tcgdexSetId` alias exactly as `manualMatch` does — `dexCode` from the
 * raw Dex id, `tcgdexSetId` from the matched card's set. This test proves the MECHANISM purely: once
 * that alias exists, a SIBLING WAITING entry from the same Dex set resolves on the next retry.
 *
 * Scenario: a not-yet-mirrored Dex set exported as code `me6` (two owned cards, #14 + #20) that
 * TCGdex actually mirrors under `me06`. Before the match neither resolves; after it, both do.
 */

// A tiny fake mirror: cards live under the real TCGdex set id `me06`; `me6` is the Dex export code.
const CARDS: Record<string, { tcgdexId: string }[]> = {
  "me06:014": [{ tcgdexId: "me06-014" }],
  "me06:020": [{ tcgdexId: "me06-020" }],
};

function fakePort(): CatalogPort {
  return {
    async findBySetLocal(setId, localId) {
      return CARDS[`${setId}:${localId}`] ?? [];
    },
    async findSetIdsByName() {
      // The set name is not yet in the mirror either — name resolution can't save it pre-match.
      return [];
    },
    async learnAlias() {
      /* persistence is exercised by exec.manualMatch; irrelevant to the resolve mechanism. */
    },
  };
}

describe("learned set alias drains the rest of the set", () => {
  it("misses before the match, hits after — for a sibling card in the same set", async () => {
    const port = fakePort();

    // BEFORE: no alias for me6. #14 misses (passthrough code me6 has no cards, no name match).
    const before = await resolveAgainstCatalog(
      port,
      { Set: "Mega Brave" },
      resolveDexId({ Id: "me6-14", Locale: "English" }, SET_ALIAS_SEED),
    );
    expect(before.catalogCardId).toBeNull();
    expect(before.reason).toBe("UNKNOWN_SET");

    // Manual-match on #14 → learn the alias in the exact shape exec.manualMatch writes.
    const { rawCode } = parseDexId("me6-14"); // "me6"
    const matchedCardSetId = "me06"; // = catalog_card.set_id of the card she pinned
    const learnedAliases: Record<string, string> = {
      ...SET_ALIAS_SEED,
      [`en:${rawCode}`]: matchedCardSetId,
    };

    // AFTER: the SIBLING #20 (never touched by hand) now resolves via the learned alias.
    const sibling = await resolveAgainstCatalog(
      port,
      { Set: "Mega Brave" },
      resolveDexId({ Id: "me6-20", Locale: "English" }, learnedAliases),
    );
    expect(sibling.catalogCardId).toBe("me06-020");

    // And so does the originally-matched card's key on the next retry.
    const original = await resolveAgainstCatalog(
      port,
      { Set: "Mega Brave" },
      resolveDexId({ Id: "me6-14", Locale: "English" }, learnedAliases),
    );
    expect(original.catalogCardId).toBe("me06-014");
  });
});
