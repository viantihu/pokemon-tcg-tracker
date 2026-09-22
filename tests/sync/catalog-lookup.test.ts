import { describe, it, expect } from "vitest";
import { resolveAgainstCatalog, type CatalogPort } from "@/lib/sync/catalog-lookup";
import { resolveDexId, SET_ALIAS_SEED } from "@/lib/sync/resolve";
import type { DexRow } from "@/lib/sync/types";

/**
 * Catalog-lookup integration over the deterministic resolver (dev-spec §5 M4 acceptance:
 * "set-code drift, localId padding, and jpn_ cases resolve").
 *
 * Every id, set name, and card below is VERIFIED against the live TCGdex API in
 * docs/sync-architecture.md Appendix — no fabricated numbers. The mirror is faked (a fixed
 * (setId, localId) → tcgdexId table + a set-name index) so the join logic is tested hermetically.
 */

interface FakeCard {
  setId: string;
  localId: string;
  tcgdexId: string;
}

function fakeCatalog(cards: FakeCard[], names: Record<string, string[]> = {}) {
  const learned: { locale: string; dexCode: string; tcgdexSetId: string }[] = [];
  const port: CatalogPort = {
    async findBySetLocal(setId, localId) {
      return cards
        .filter((c) => c.setId === setId && c.localId === localId)
        .map((c) => ({ tcgdexId: c.tcgdexId }));
    },
    async findSetIdsByName(setName) {
      return names[setName] ?? [];
    },
    async findSetIdsFoldingCase(setId) {
      // UIL-086: the stored ids that differ from `setId` only by case. Derived from the same fixture
      // cards, so a test cannot claim a folded set the fake catalog does not actually hold.
      const want = setId.toLowerCase();
      const ids = new Set<string>();
      for (const c of cards) if (c.setId.toLowerCase() === want) ids.add(c.setId);
      return [...ids];
    },
    async learnAlias(alias) {
      learned.push(alias);
    },
  };
  return { port, learned };
}

/** Minimal Dex row: only Id/Locale/Set/Variant matter to resolve + lookup. */
function dexRow(fields: Partial<DexRow>): DexRow {
  return {
    Type: "collection",
    Category: "My Collection",
    Locale: "English",
    Series: "",
    Set: "",
    Id: "",
    Number: "",
    Name: "",
    Variant: "Normal",
    Rarity: "",
    Illustrator: "",
    Quantity: "1",
    Price: "",
    Notes: "",
    ...fields,
  };
}

describe("resolveAgainstCatalog — seeded set-code drift", () => {
  it("resolves me2-112 → me02-112 via the seeded alias (no name match needed)", async () => {
    const { port, learned } = fakeCatalog([
      { setId: "me02", localId: "112", tcgdexId: "me02-112" },
    ]);
    const row = dexRow({ Id: "me2-112", Set: "Phantasmal Flames" });
    const resolved = resolveDexId(row, SET_ALIAS_SEED);

    const result = await resolveAgainstCatalog(port, row, resolved);

    expect(result.catalogCardId).toBe("me02-112");
    expect(learned).toHaveLength(0); // already known: nothing to learn
  });

  it("resolves the me25 → me02.5 decimal case", async () => {
    const { port } = fakeCatalog([{ setId: "me02.5", localId: "20", tcgdexId: "me02.5-20" }]);
    const row = dexRow({ Id: "me25-20", Set: "Ascended Heroes" });
    const resolved = resolveDexId(row, SET_ALIAS_SEED);

    const result = await resolveAgainstCatalog(port, row, resolved);
    expect(result.catalogCardId).toBe("me02.5-20");
  });
});

describe("resolveAgainstCatalog — localId padding drift", () => {
  it("resolves mep-87 → mep-087 via the padding-tolerant candidate retry", async () => {
    const { port } = fakeCatalog([{ setId: "mep", localId: "087", tcgdexId: "mep-087" }]);
    const row = dexRow({ Id: "mep-87", Set: "Mega Evolution Promos" });
    const resolved = resolveDexId(row, SET_ALIAS_SEED);

    const result = await resolveAgainstCatalog(port, row, resolved);
    expect(result.catalogCardId).toBe("mep-087");
  });
});

describe("resolveAgainstCatalog — jpn_ locale namespacing", () => {
  it("resolves jpn_sv11w-2 → ja:sv11w-002 (ja locale, padded localId) and NEVER the English sv11w-002", async () => {
    // UIL-047 / 0016: Japanese rows live in the `ja:` namespace. An English card with the very same
    // set code and number is a different card and must not be the answer.
    const { port } = fakeCatalog([
      { setId: "sv11w", localId: "002", tcgdexId: "sv11w-002" },
      { setId: "ja:sv11w", localId: "002", tcgdexId: "ja:sv11w-002" },
    ]);
    const row = dexRow({ Id: "jpn_sv11w-2", Locale: "Japanese", Set: "White Flare" });
    const resolved = resolveDexId(row, SET_ALIAS_SEED);

    expect(resolved.locale).toBe("ja");
    const result = await resolveAgainstCatalog(port, row, resolved);
    expect(result.catalogCardId).toBe("ja:sv11w-002");
  });

  it("a Japanese row whose set only exists in English is UNKNOWN_SET, not a confident English match", async () => {
    const { port } = fakeCatalog([{ setId: "sv11w", localId: "002", tcgdexId: "sv11w-002" }]);
    const row = dexRow({ Id: "jpn_sv11w-2", Locale: "Japanese", Set: "White Flare" });
    const result = await resolveAgainstCatalog(port, row, resolveDexId(row, SET_ALIAS_SEED));
    expect(result.catalogCardId).toBeNull();
    expect(result.reason).toBe("UNKNOWN_SET");
  });
});

describe("resolveAgainstCatalog — set-name fallback learns an alias", () => {
  it("learns (en, me2 → me02) by matching the set name when the code is unseeded, then resolves", async () => {
    // Simulate a drift NOT yet in the seed: pass an empty alias map so me2 passes through raw.
    const { port, learned } = fakeCatalog(
      [{ setId: "me02", localId: "112", tcgdexId: "me02-112" }],
      { "Phantasmal Flames": ["me02"] },
    );
    const row = dexRow({ Id: "me2-112", Set: "Phantasmal Flames" });
    const resolved = resolveDexId(row, {}); // no seed → me2 is a passthrough (aliased=false)

    const result = await resolveAgainstCatalog(port, row, resolved);

    expect(result.catalogCardId).toBe("me02-112");
    expect(result.learnedAlias).toEqual({ locale: "en", dexCode: "me2", tcgdexSetId: "me02" });
    expect(learned).toEqual([{ locale: "en", dexCode: "me2", tcgdexSetId: "me02" }]);
  });

  it("drains the rest of the set within the same pass via the session alias cache", async () => {
    const { port, learned } = fakeCatalog(
      [
        { setId: "me02", localId: "112", tcgdexId: "me02-112" },
        { setId: "me02", localId: "5", tcgdexId: "me02-5" },
      ],
      { "Phantasmal Flames": ["me02"] },
    );
    const session = new Map<string, string>();
    const first = dexRow({ Id: "me2-112", Set: "Phantasmal Flames" });
    const second = dexRow({ Id: "me2-5", Set: "Phantasmal Flames" });

    const r1 = await resolveAgainstCatalog(port, first, resolveDexId(first, {}), session);
    const r2 = await resolveAgainstCatalog(port, second, resolveDexId(second, {}), session);

    expect(r1.catalogCardId).toBe("me02-112");
    expect(r2.catalogCardId).toBe("me02-5");
    // Alias learned/persisted exactly once; the second row rode the session cache.
    expect(learned).toHaveLength(1);
  });
});

describe("resolveAgainstCatalog — unresolved reason codes", () => {
  it("returns UNKNOWN_SET when neither the code nor the set name matches", async () => {
    const { port, learned } = fakeCatalog([], {});
    const row = dexRow({ Id: "zz9-1", Set: "A Set The Mirror Lacks" });
    const result = await resolveAgainstCatalog(port, row, resolveDexId(row, {}));

    expect(result.catalogCardId).toBeNull();
    expect(result.reason).toBe("UNKNOWN_SET");
    expect(learned).toHaveLength(0);
  });

  it("returns UNKNOWN_CARD when the set is known but the localId is absent", async () => {
    const { port } = fakeCatalog([{ setId: "me02", localId: "112", tcgdexId: "me02-112" }]);
    const row = dexRow({ Id: "me2-999", Set: "Phantasmal Flames" });
    const result = await resolveAgainstCatalog(port, row, resolveDexId(row, SET_ALIAS_SEED));

    expect(result.catalogCardId).toBeNull();
    expect(result.reason).toBe("UNKNOWN_CARD");
  });

  it("does not mis-learn an alias from an ambiguous set name", async () => {
    const { port, learned } = fakeCatalog([], { "Shared Name": ["setA", "setB"] });
    const row = dexRow({ Id: "amb-1", Set: "Shared Name" });
    const result = await resolveAgainstCatalog(port, row, resolveDexId(row, {}));

    expect(result.catalogCardId).toBeNull();
    expect(result.reason).toBe("UNKNOWN_SET");
    expect(learned).toHaveLength(0);
  });
});
