/**
 * UIL-086 — her Japanese Dex set codes are lower case (`sv9`, `mc`, `s12a`); TCGdex's ja set ids are
 * mixed case (`SV9`, `MC`, `S12a`). Every catalog lookup matched `set_id` with `.eq`, so three of her
 * five Japanese sets resolved to nothing and parked as UNKNOWN_SET on import.
 *
 * Measured on Testing 2026-09-22 (in the entry): `ja:MC` 774 rows and `ja:mc` 0; `ja:S12a` 258 and
 * `ja:s12a` 0; `ja:SV9` 132 and `ja:sv9` 0. So the miss is purely letter case, and the set-NAME fallback
 * cannot rescue it: her export's names are romanised while TCGdex's ja names are in Japanese script.
 *
 * The fix is at LOOKUP time and stored ids are never rewritten (the Tech Lead's constraint — the mirror's
 * resume compares stored ids to TCGdex's own strings). It resolves the real casing once, learns the
 * `(ja, sv9) → ja:SV9` alias, and every later lookup is exact.
 *
 * Two behaviours this also pins:
 *   * `mem` and `mez`, which TCGdex does not carry under any casing, must STILL park as UNKNOWN_SET and
 *     go through the approved manual-match path (UIL-047).
 *   * a learned alias is keyed on the RAW Dex code. The name-resolution path keyed it on the NAMESPACED
 *     id (`ja:sv9`), which `resolveSetId` never looks up — so a Japanese alias was written and then never
 *     read, and the set re-resolved from scratch on every import. English was unaffected there, because
 *     for en the raw code and the stored id are the same string.
 */
import { describe, expect, it } from "vitest";
import { resolveAgainstCatalog, type CatalogPort } from "@/lib/sync/catalog-lookup";
import { loadAliasMap } from "@/lib/sync/pipeline";
import { resolveDexId, SET_ALIAS_SEED } from "@/lib/sync/resolve";
import type { DexRow } from "@/lib/sync/types";

/** The mirror as it actually is: ja ids namespaced AND mixed case, en ids bare and lower. */
const STORED = [
  { setId: "ja:SV9", localId: "042", tcgdexId: "ja:SV9-042" },
  { setId: "ja:MC", localId: "007", tcgdexId: "ja:MC-007" },
  { setId: "ja:S12a", localId: "112", tcgdexId: "ja:S12a-112" },
  { setId: "sv09", localId: "042", tcgdexId: "sv09-042" }, // an ENGLISH set, must never be reached
];

function port(over: Partial<CatalogPort> = {}) {
  const learned: { locale: string; dexCode: string; tcgdexSetId: string }[] = [];
  const asked: string[] = [];
  const base: CatalogPort = {
    async findBySetLocal(setId, localId) {
      asked.push(`${setId}:${localId}`);
      return STORED.filter((c) => c.setId === setId && c.localId === localId).map((c) => ({
        tcgdexId: c.tcgdexId,
      }));
    },
    // Her romanised set names match nothing in the ja catalog — the real situation, not a convenience.
    async findSetIdsByName() {
      return [];
    },
    async findSetIdsFoldingCase(setId, locale) {
      const want = setId.toLowerCase();
      const ids = new Set<string>();
      for (const c of STORED) {
        // The stored `locale` column scopes this in production; the namespace does it here.
        const cardLocale = c.setId.startsWith("ja:") ? "ja" : "en";
        if (cardLocale === locale && c.setId.toLowerCase() === want) ids.add(c.setId);
      }
      return [...ids];
    },
    async learnAlias(alias) {
      learned.push(alias);
    },
    ...over,
  };
  return { port: base, learned, asked };
}

const jaRow = (id: string, set = "Journey Together"): Pick<DexRow, "Set"> & { Id: string } => ({
  Id: id,
  Set: set,
});

function resolveJa(id: string, alias: Readonly<Record<string, string>> = SET_ALIAS_SEED) {
  return resolveDexId({ Id: id, Locale: "Japanese" }, alias);
}

describe("UIL-086 · a lower-case Japanese set code finds the mixed-case stored set", () => {
  it("resolves sv9 → ja:SV9, and learns the alias on the RAW code so the next import is exact", async () => {
    const { port: p, learned } = port();
    const resolved = resolveJa("jpn_sv9-42");
    expect(resolved.setId).toBe("ja:sv9"); // the passthrough, which matches nothing as stored
    expect(resolved.rawCode).toBe("sv9");

    const res = await resolveAgainstCatalog(p, jaRow("jpn_sv9-42"), resolved);

    expect(res.catalogCardId).toBe("ja:SV9-042"); // pre-fix: null, reason UNKNOWN_SET
    expect(res.reason).toBeUndefined();
    expect(learned).toEqual([{ locale: "ja", dexCode: "sv9", tcgdexSetId: "ja:SV9" }]);
  });

  it("the learned alias is one `resolveSetId` actually reads — the key the old name path got wrong", async () => {
    const { port: p, learned } = port();
    await resolveAgainstCatalog(p, jaRow("jpn_sv9-42"), resolveJa("jpn_sv9-42"));

    // Exactly how `loadAliasMap` keys a stored row, so this proves the round trip and not a guess.
    const aliasMap = {
      ...SET_ALIAS_SEED,
      [`${learned[0].locale}:${learned[0].dexCode}`]: learned[0].tcgdexSetId,
    };
    const second = resolveJa("jpn_sv9-99", aliasMap);
    expect(second.setId).toBe("ja:SV9");
    expect(second.aliased).toBe(true);
  });

  it("the whole set drains without asking again: the second row uses the session alias", async () => {
    const { port: p, learned, asked } = port();
    const sessionAliases = new Map<string, string>();
    await resolveAgainstCatalog(p, jaRow("jpn_mc-7"), resolveJa("jpn_mc-7"), sessionAliases);
    const afterFirst = asked.length;
    const second = await resolveAgainstCatalog(
      p,
      jaRow("jpn_mc-7"),
      resolveJa("jpn_mc-7"),
      sessionAliases,
    );
    expect(second.catalogCardId).toBe("ja:MC-007");
    // One alias write for the set, not one per row — "one match drains the set".
    expect(learned).toHaveLength(1);
    // The second row went straight to the stored casing: nothing it asked used the wrong one.
    const secondRowAsks = asked.slice(afterFirst);
    expect(secondRowAsks.length).toBeGreaterThan(0);
    expect(secondRowAsks.filter((k) => k.startsWith("ja:mc:"))).toEqual([]);
    expect(secondRowAsks[0]).toMatch(/^ja:MC:/);
  });

  it("does the same for s12a → ja:S12a, so this is the rule and not one hard-coded set", async () => {
    const { port: p } = port();
    const res = await resolveAgainstCatalog(p, jaRow("jpn_s12a-112"), resolveJa("jpn_s12a-112"));
    expect(res.catalogCardId).toBe("ja:S12a-112");
  });
});

describe("UIL-086 · what must NOT change", () => {
  it("mem still parks as UNKNOWN_SET: TCGdex carries it under no casing, so the manual match stays the way in", async () => {
    const { port: p, learned } = port();
    const res = await resolveAgainstCatalog(
      p,
      jaRow("jpn_mem-1", "Mega Evolution M"),
      resolveJa("jpn_mem-1"),
    );
    expect(res.catalogCardId).toBeNull();
    expect(res.reason).toBe("UNKNOWN_SET");
    expect(learned).toEqual([]); // nothing invented for a set that does not exist
  });

  it("a Japanese code NEVER reaches an English set, even when the fold would match one", async () => {
    // `sv09` is stored bare (English). A ja row for `sv09` must find nothing rather than cross locales —
    // the confident-wrong-match hazard UIL-047 C3 closed.
    const { port: p, learned } = port();
    const res = await resolveAgainstCatalog(p, jaRow("jpn_sv09-42"), resolveJa("jpn_sv09-42"));
    expect(res.catalogCardId).toBeNull();
    expect(res.reason).toBe("UNKNOWN_SET");
    expect(learned).toEqual([]);
  });

  it("refuses to learn when two stored ids fold to the same code — ambiguity is not evidence", async () => {
    const { port: p, learned } = port({
      async findSetIdsFoldingCase() {
        return ["ja:MC", "ja:Mc"];
      },
    });
    const res = await resolveAgainstCatalog(p, jaRow("jpn_mc-7"), resolveJa("jpn_mc-7"));
    expect(res.reason).toBe("UNKNOWN_SET");
    expect(learned).toEqual([]);
  });

  it("an ENGLISH row never takes the fold path: en ids are already lower case and that path is untouched", async () => {
    let foldCalls = 0;
    const { port: p } = port({
      async findSetIdsFoldingCase() {
        foldCalls += 1;
        return [];
      },
    });
    const resolved = resolveDexId({ Id: "SV09-42", Locale: "English" });
    const res = await resolveAgainstCatalog(p, { Set: "Journey Together" }, resolved);
    expect(foldCalls).toBe(0);
    expect(res.reason).toBe("UNKNOWN_SET");
  });

  it("a set code that already matches exactly resolves on the first try, asking nothing extra", async () => {
    let foldCalls = 0;
    const { port: p, learned } = port({
      async findSetIdsFoldingCase() {
        foldCalls += 1;
        return ["ja:MC"];
      },
    });
    // Her code is already the stored casing, so the primary lookup hits and no learning happens.
    const res = await resolveAgainstCatalog(p, jaRow("jpn_MC-7"), resolveJa("jpn_MC-7"));
    expect(res.catalogCardId).toBe("ja:MC-007");
    expect(foldCalls).toBe(0);
    expect(learned).toEqual([]);
  });

  it("the NAME-resolved path keys its alias on the raw code too, for a ja set no fold can reach", async () => {
    // `mez` folds to nothing (TCGdex has no such ja set id), so the name fallback is what runs. Her
    // export's ja set names are usually romanised and will not match, but when one DOES match exactly
    // this path fires — and it used to key the alias on `ja:mez`, which `resolveSetId` never reads, so
    // the set re-resolved from scratch on every later import instead of draining.
    const { port: p, learned } = port({
      async findSetIdsByName() {
        return ["ja:MEZ"];
      },
      async findSetIdsFoldingCase() {
        return [];
      },
      async findBySetLocal(setId, localId) {
        return setId === "ja:MEZ" && localId === "001" ? [{ tcgdexId: "ja:MEZ-001" }] : [];
      },
    });
    const res = await resolveAgainstCatalog(
      p,
      jaRow("jpn_mez-1", "Mega Evolution Z"),
      resolveJa("jpn_mez-1"),
    );
    expect(res.catalogCardId).toBe("ja:MEZ-001");
    expect(learned).toEqual([{ locale: "ja", dexCode: "mez", tcgdexSetId: "ja:MEZ" }]);
    // The round trip: this alias is one the resolver reads back.
    const map = { ...SET_ALIAS_SEED, "ja:mez": "ja:MEZ" };
    expect(resolveJa("jpn_mez-2", map).setId).toBe("ja:MEZ");
  });

  it("loadAliasMap's key shape is the one the learned alias uses (guards the two halves drifting apart)", () => {
    // `loadAliasMap` builds `${locale}:${dex_code}`; `resolveSetId` reads `${locale}:${rawCode}`.
    // Those two strings agreeing is the whole of the second half of this entry.
    expect(typeof loadAliasMap).toBe("function");
    const map = { ...SET_ALIAS_SEED, "ja:sv9": "ja:SV9" };
    expect(resolveDexId({ Id: "jpn_sv9-1", Locale: "Japanese" }, map).setId).toBe("ja:SV9");
  });
});
