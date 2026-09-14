/** CatalogCard: a TCGdex printing mirrored into the DB (read-only to the app). system-design §4. */
import { parseCardQuery } from "@/lib/catalog/collector-number";
import { createRepo, type DbClient, type Insert, type Row } from "./base";

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
    if (parsed.localIds.length > 0) {
      const { data, error } = await db
        .from("catalog_card")
        .select("*")
        .eq("is_digital_only", false)
        .in("local_id", parsed.localIds)
        .order("set_id", { ascending: true })
        .order("local_id", { ascending: true })
        .limit(limit);
      if (error) throw error;
      take(data ?? []);
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
