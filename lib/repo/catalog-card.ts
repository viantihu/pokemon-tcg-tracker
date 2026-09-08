/** CatalogCard: a TCGdex printing mirrored into the DB (read-only to the app). system-design §4. */
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
