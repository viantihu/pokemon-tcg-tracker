/** CatalogCard: a TCGdex printing mirrored into the DB (read-only to the app). system-design §4. */
import { parseCardQuery } from "@/lib/catalog/collector-number";
import { assertReadComplete, createRepo, type DbClient, type Insert, type Row } from "./base";

/**
 * Upper bound on how many exact `local_id` matches one candidate can produce — a number exists in at
 * most one card per set (~218 sets), so this only exists to keep an unbounded read from a bad filter
 * from becoming a full-table scan. Well above the real ceiling; not a display limit.
 */
const EXACT_MATCH_FETCH_CAP = 500;

/**
 * Float the exact matches whose set's official card count equals the typed denominator to the front,
 * STABLY — the input's order (recency, then set_id) is preserved within each partition. Denominator is
 * a ranking signal only (UIL-026): a non-matching row still appears, just after the matches. A missing
 * `setTotal`, or a row with a NULL `set_card_count_official`, simply gets no boost.
 */
function rankExactMatches(
  rows: Row<"catalog_card">[],
  setTotal: number | undefined,
): Row<"catalog_card">[] {
  if (setTotal === undefined) return rows;
  const matches: Row<"catalog_card">[] = [];
  const rest: Row<"catalog_card">[] = [];
  for (const r of rows) {
    (r.set_card_count_official === setTotal ? matches : rest).push(r);
  }
  return matches.length === 0 ? rows : [...matches, ...rest];
}

export const catalogCardRepo = {
  ...createRepo("catalog_card", "tcgdex_id"),

  /**
   * Idempotent bulk upsert keyed on `tcgdex_id` (the M2 mirror must re-run without duplicating
   * rows — dev-spec §5). Rows must be de-duplicated on `tcgdex_id` by the caller first: Postgres
   * rejects a single INSERT ... ON CONFLICT that touches the same conflict key twice
   * ("cannot affect row a second time"). `lib/catalog/mirror.ts` dedupes before calling.
   */
  async upsertMany(db: DbClient, rows: Insert<"catalog_card">[]): Promise<Row<"catalog_card">[]> {
    if (rows.length === 0) return [];
    const { data, error } = await db
      .from("catalog_card")
      .upsert(rows, { onConflict: "tcgdex_id" })
      .select();
    if (error) throw error;
    return data ?? [];
  },

  /** Single-row idempotent upsert on `tcgdex_id`. */
  async upsert(db: DbClient, row: Insert<"catalog_card">): Promise<Row<"catalog_card"> | null> {
    const [out] = await this.upsertMany(db, [row]);
    return out ?? null;
  },

  /**
   * The printings behind a known set of ids — used where the caller already holds `catalog_card_id`
   * references (e.g. the pending-placement queue) and must NOT pull the whole ~23.5k mirror to
   * resolve a handful of names. Chunked, because the ids ride on the request URL.
   */
  async listByIds(db: DbClient, ids: string[], chunkSize = 100): Promise<Row<"catalog_card">[]> {
    const out: Row<"catalog_card">[] = [];
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += chunkSize) {
      const { data, error } = await db
        .from("catalog_card")
        .select("*")
        .in("tcgdex_id", unique.slice(i, i + chunkSize));
      if (error) throw error;
      out.push(...(data ?? []));
    }
    return out;
  },

  /**
   * Every stand-in she has created (UIL-060: `source = 'user'`, ids in the `user:` namespace). Used to
   * refuse a twin before creating another; complete-read guarded like every "all of them" read.
   */
  async listStandIns(db: DbClient): Promise<Row<"catalog_card">[]> {
    const { data, error, count } = await db
      .from("catalog_card")
      .select("*", { count: "exact" })
      .eq("source", "user");
    if (error) throw error;
    const rows = data ?? [];
    assertReadComplete("catalog_card", rows, count);
    return rows;
  },

  /** Duplicate-key lookup half: cards sharing a (set_id, local_id). */
  async findBySetLocal(
    db: DbClient,
    setId: string,
    localId: string,
  ): Promise<Row<"catalog_card">[]> {
    const { data, error } = await db
      .from("catalog_card")
      .select("*")
      .eq("set_id", setId)
      .eq("local_id", localId);
    if (error) throw error;
    return data ?? [];
  },

  /**
   * Cards at any of `localIds` within ONE set — the batched form of `findBySetLocal`.
   *
   * The sync resolves ~685 rows and asked for each `(set, localId)` separately, which is one serial
   * round trip per candidate: the wait she sees on an import. Grouping by set collapses that to one
   * query per distinct set.
   *
   * `chunkSize` is bounded by TWO constraints, so raising it for speed is NOT safe (UIL-028):
   *  - the ids ride on the request URL, so a chunk has to fit in one;
   *  - each chunk is ONE unpaged PostgREST response, cut at the server's `max-rows` (1000 on Supabase).
   *    A 200-id chunk within one set returns ~200 rows, so today the cap is far away; a 2000-id chunk
   *    would come back as 1000 rows and — because `lib/sync/catalog-lookup.ts` marks every REQUESTED id
   *    as fetched — the cut cards would read as proven absences and park in the unresolved queue looking
   *    like a catalog gap. So every chunk asks for the true total and `assertReadComplete` throws by
   *    name the moment the cap cuts one: at 2000, or at the default should a set ever carry five-plus
   *    printings per collector number.
   */
  async findBySetLocalMany(
    db: DbClient,
    setId: string,
    localIds: string[],
    chunkSize = 200,
  ): Promise<Row<"catalog_card">[]> {
    const unique = [...new Set(localIds)];
    if (unique.length === 0) return [];
    const out: Row<"catalog_card">[] = [];
    for (let i = 0; i < unique.length; i += chunkSize) {
      const chunk = unique.slice(i, i + chunkSize);
      const { data, error, count } = await db
        .from("catalog_card")
        .select("*", { count: "exact" })
        .eq("set_id", setId)
        .in("local_id", chunk);
      if (error) throw error;
      const rows = data ?? [];
      assertReadComplete(
        "catalog_card",
        rows,
        count,
        `findBySetLocalMany(${setId}): a chunk of ${chunk.length} local ids was cut by the cap — ` +
          `lower chunkSize (never raise it); the sync must not mark these ids fetched.`,
      );
      out.push(...rows);
    }
    return out;
  },

  /** All printings of a species (dexId is the species key, never the name). */
  async findByDexId(db: DbClient, dexId: number): Promise<Row<"catalog_card">[]> {
    const { data, error } = await db.from("catalog_card").select("*").contains("dex_id", [dexId]);
    if (error) throw error;
    return data ?? [];
  },

  /**
   * Type-ahead against the LOCAL mirror for the intake / lookup surfaces (dev-spec §5 M6, §7B step 2).
   * Matches the free-text query against name, set name, collector number, or tcgdex id. Digital-only
   * cards are excluded (they can never be a physical placement). Server-side only — the client never
   * queries TCGdex live.
   */
  async search(db: DbClient, query: string, limit = 12): Promise<Row<"catalog_card">[]> {
    const parsed = parseCardQuery(query);
    // Strip PostgREST `or()` control characters so user input can't break out of the filter. The
    // slash goes too: it never appears in any column, so leaving it in was what made a printed
    // collector number match nothing at all (UIL-010).
    const q = parsed.text.replace(/[,()%*/]/g, " ").trim();
    if (q.length === 0 && parsed.localIds.length === 0) return [];

    const out: Row<"catalog_card">[] = [];
    const seen = new Set<string>();
    const take = (rows: Row<"catalog_card">[]) => {
      for (const r of rows) {
        if (seen.has(r.tcgdex_id)) continue;
        seen.add(r.tcgdex_id);
        out.push(r);
      }
    };

    // A printed collector number is the natural key when building a collection from a set checklist,
    // so an exact `local_id` hit ranks ABOVE any name match. Run as its own query rather than folded
    // into the `or` below: a shared `limit` would let a dozen name matches crowd out the exact one.
    // Equality, not `ilike` — `99` as a substring also matches `199`, `299` and `990`.
    //
    // ONE QUERY PER CANDIDATE, IN CANDIDATE ORDER (UIL-015). The previous version put every padding
    // variant into a single `.in("local_id", ["011", "11"])` ordered by `set_id`, which threw the
    // candidate order away — and `set_id` ordering is alphabetical, so DIGITS SORT BEFORE LETTERS.
    // Searching `011/217` for Wurmple (`me02.5-011`) matched the stripped form `11` in all twelve
    // numerically-named McDonald's sets (`2011bw` … `2024sv`), which sort ahead of `me02.5`, filled
    // the `limit`, and crowded the exact match out entirely. Invisible at 3 catalog rows, wrong at
    // 23.5k — the same "fine at small scale" shape as the progress strip in UIL-007.
    //
    // The precedence restored here is the form SHE TYPED first, not "padded first":
    // `localIdCandidates` yields the verbatim form ahead of its variants, so `011` → ["011", "11"]
    // and `11` → ["11", "011"]. Padded-first would be right for her query and wrong for the mirror
    // image of it. Querying one form at a time also means the `limit` cannot be consumed by the
    // lower-precedence form before the higher one is asked for.
    //
    // WITHIN one candidate, when the same number exists in several sets (UIL-026): the old
    // `.order("set_id")` was alphabetical, so `099/182` for Minior (`sv04-099`) buried the match
    // under five other 099s because `sv04` sorts late. Now ordered by RECENCY at the DB
    // (`set_release_date desc nulls last`, then `set_id` for a stable tie-break), and then the exact
    // matches whose set's official count equals the typed denominator are floated to the front in JS
    // (`rankExactMatches`). Denominator is a rank, never a filter — a `Shuckle 136/132` legitimately
    // exceeds its own total, so a non-matching row still appears, just lower.
    //
    // Fetch the WHOLE match set for the candidate (bounded by set count, capped defensively) BEFORE
    // ranking, not `limit - out.length` rows: a denominator match that sorts late by recency must not
    // be dropped by the row cap before it can be floated to the front.
    for (const localId of parsed.localIds) {
      if (out.length >= limit) break;
      const { data, error } = await db
        .from("catalog_card")
        .select("*")
        .eq("is_digital_only", false)
        .eq("local_id", localId)
        .order("set_release_date", { ascending: false, nullsFirst: false })
        .order("set_id", { ascending: true })
        .limit(EXACT_MATCH_FETCH_CAP);
      if (error) throw error;
      take(rankExactMatches(data ?? [], parsed.setTotal));
    }

    if (out.length < limit && q.length > 0) {
      const like = `%${q}%`;
      const { data, error } = await db
        .from("catalog_card")
        .select("*")
        .eq("is_digital_only", false)
        .or(
          `name.ilike.${like},set_name.ilike.${like},local_id.ilike.${like},tcgdex_id.ilike.${like}`,
        )
        .order("name", { ascending: true })
        .limit(limit);
      if (error) throw error;
      take(data ?? []);
    }

    return out.slice(0, limit);
  },

  /**
   * Filtered, paged listing for the card-search grid (UIL-039) — deliberately separate from
   * `search()`, which is a small type-ahead for the single-pick surfaces (Log a card, Backfill,
   * Lookup) and stays that way. `browse` is for a page meant to show dozens-to-hundreds of results
   * (an illustrator's whole output, a full set), so it pages rather than capping at 12.
   *
   * All filters AND together. `illustrator` and `text` are `ilike` substring matches — illustrator
   * credits and card names are not typed consistently enough for exact match to be usable here.
   */
  async browse(
    db: DbClient,
    filters: {
      text?: string;
      illustrator?: string;
      setId?: string;
      dexId?: number;
      /**
       * Raw TCGdex type strings to match, ANY of (not all) — a band like White covers several raw
       * types at once (Colorless, Metal, every Trainer/Energy card), so the caller expands one band
       * pick into this list via `type_color_map` before calling `browse`.
       */
      types?: string[];
    },
    opts: { limit: number; offset: number },
  ): Promise<Row<"catalog_card">[]> {
    // Deliberately no owned/unowned filter here: that set is hundreds of ids, and folding it into
    // a `.in()`/`.not.in()` filter puts all of them on the request URL, which is the "fine at a
    // handful, wrong at real scale" shape this app keeps finding elsewhere. The caller (browseCards
    // action) filters in memory against `copyRepo.ownedCatalogCardIdSet` and re-pages as needed to
    // keep pagination correct instead.
    let q = db.from("catalog_card").select("*").eq("is_digital_only", false);
    if (filters.illustrator) q = q.ilike("illustrator", `%${filters.illustrator}%`);
    if (filters.setId) q = q.eq("set_id", filters.setId);
    if (filters.dexId != null) q = q.contains("dex_id", [filters.dexId]);
    if (filters.types && filters.types.length > 0) q = q.overlaps("types", filters.types);
    if (filters.text) {
      const like = `%${filters.text.replace(/[,()%*/]/g, " ").trim()}%`;
      q = q.or(`name.ilike.${like},local_id.ilike.${like}`);
    }
    const { data, error } = await q
      .order("name", { ascending: true })
      .order("tcgdex_id", { ascending: true }) // total order: name alone ties within a set
      .range(opts.offset, opts.offset + opts.limit - 1);
    if (error) throw error;
    return data ?? [];
  },

  /**
   * Distinct TCGdex set ids whose `set_name` matches a human set name exactly. The sync's
   * set-code-miss fallback (sync-architecture §1.3) resolves an unknown Dex code by matching the
   * Dex `Set` column against the mirrored set names, then learns the alias. Returns every distinct
   * `set_id` seen; the caller treats a non-unique result as ambiguous rather than mis-learning.
   */
  async findSetIdsByName(db: DbClient, setName: string): Promise<string[]> {
    const { data, error } = await db
      .from("catalog_card")
      .select("set_id")
      .eq("set_name", setName)
      .not("set_id", "is", null);
    if (error) throw error;
    const ids = new Set<string>();
    for (const r of data ?? []) if (r.set_id) ids.add(r.set_id);
    return [...ids];
  },
};
