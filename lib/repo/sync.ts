/** Sync-engine persistence: presence groups, unresolved queue, learned set aliases, undo snapshot.
 *  sync-ui-spec §C; sync-architecture §1.3–§1.7. */
import { assertReadComplete, createRepo, type DbClient, type Row } from "./base";

export const presenceGroupRepo = {
  ...createRepo("presence_group"),

  /** The reconciliation unit for one `(catalogCardId, dexVariantRaw)` key, or null if none yet. */
  async findByKey(
    db: DbClient,
    catalogCardId: string,
    dexVariantRaw: string,
  ): Promise<Row<"presence_group"> | null> {
    const { data, error } = await db
      .from("presence_group")
      .select("*")
      .eq("catalog_card_id", catalogCardId)
      .eq("dex_variant_raw", dexVariantRaw)
      .maybeSingle();
    if (error) throw error;
    return data ?? null;
  },
};

export const unresolvedEntryRepo = {
  ...createRepo("unresolved_entry"),

  /**
   * Entries auto-retried on every sync. Reconciliation (`lib/sync/pipeline.ts`) depends on this
   * being every WAITING row — a silent truncation past the server's row cap would leave entries past
   * the cap never archived and never dropped (UIL-031), so this throws rather than return a partial
   * queue.
   */
  async listWaiting(db: DbClient): Promise<Row<"unresolved_entry">[]> {
    const { data, error, count } = await db
      .from("unresolved_entry")
      .select("*", { count: "exact" })
      .eq("status", "WAITING");
    if (error) throw error;
    const rows = data ?? [];
    assertReadComplete("unresolved_entry", rows, count);
    return rows;
  },
};

export const lastSyncSnapshotRepo = createRepo("last_sync_snapshot");

/** SetAlias has a composite primary key (locale, dex_code), so it gets a bespoke repo. */
export const setAliasRepo = {
  async list(db: DbClient): Promise<Row<"set_alias">[]> {
    const { data, error } = await db.from("set_alias").select("*");
    if (error) throw error;
    return data ?? [];
  },

  async getByCode(db: DbClient, locale: string, dexCode: string): Promise<Row<"set_alias"> | null> {
    const { data, error } = await db
      .from("set_alias")
      .select("*")
      .eq("locale", locale)
      .eq("dex_code", dexCode)
      .maybeSingle();
    if (error) throw error;
    return data ?? null;
  },

  /** Learn (or overwrite) an alias — one manual match can drain a whole set (sync-ui-spec §A.8). */
  async upsert(
    db: DbClient,
    row: { locale: string; dex_code: string; tcgdex_set_id: string; source?: string },
  ): Promise<Row<"set_alias">> {
    const { data, error } = await db.from("set_alias").upsert(row).select().single();
    if (error) throw error;
    return data;
  },
};
