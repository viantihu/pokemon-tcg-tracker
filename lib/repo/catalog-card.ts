/** CatalogCard: a TCGdex printing mirrored into the DB (read-only to the app). system-design §4. */
import { createRepo, type DbClient, type Row } from "./base";

export const catalogCardRepo = {
  ...createRepo("catalog_card", "tcgdex_id"),

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
};
