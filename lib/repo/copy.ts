/** Copy: a physical card owned. system-design §4. */
import { assertReadComplete, createRepo, type DbClient, type Row } from "./base";

export const copyRepo = {
  ...createRepo("copy"),

  /** Shelved copies in a binder half — the duplicate check compares against shelved only. */
  async listShelvedInSection(
    db: DbClient,
    binderId: string,
    half: "front" | "back",
  ): Promise<Row<"copy">[]> {
    const { data, error } = await db
      .from("copy")
      .select("*")
      .eq("role", "shelved")
      .eq("binder_id", binderId)
      .eq("binder_half", half);
    if (error) throw error;
    return data ?? [];
  },

  /** All shelved copies (duplicate detection is against the whole collection, not one binder). */
  async listShelved(db: DbClient): Promise<Row<"copy">[]> {
    const { data, error } = await db.from("copy").select("*").eq("role", "shelved");
    if (error) throw error;
    return data ?? [];
  },

  /** Every physical copy of a printing (lookup "where is my card" — all roles, all binders). */
  async listByCatalogCard(db: DbClient, catalogCardId: string): Promise<Row<"copy">[]> {
    const { data, error } = await db.from("copy").select("*").eq("catalog_card_id", catalogCardId);
    if (error) throw error;
    return data ?? [];
  },

  /**
   * Copies that hold NO placement: in the bulk box, in no binder, in no line slot. This is the raw
   * candidate set for the Haul Plan's pending-placement queue (UIL-003) — the shape sync's `creates`
   * and manual-match leave behind (`role: 'bulk'`, everything else null; lib/sync/exec.ts). It also
   * catches copies the cascade legitimately ROUTED to bulk, so the caller must still subtract the
   * ones that already have a `placement_decision`; `lib/plan/pending.ts` does that.
   *
   * Oldest first, so the queue is worked in the order the cards entered the collection.
   *
   * A card past the server's row cap would never appear here and never get placed, with no error
   * anywhere (UIL-031) — worse than a slow-healing queue, an invisible one — so this throws rather
   * than return a partial queue.
   */
  async listUnplaced(db: DbClient): Promise<Row<"copy">[]> {
    const { data, error, count } = await db
      .from("copy")
      .select("*", { count: "exact" })
      .eq("role", "bulk")
      .is("binder_id", null)
      .is("line_slot_id", null)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });
    if (error) throw error;
    const rows = data ?? [];
    assertReadComplete("copy", rows, count);
    return rows;
  },

  /** Copies in one presence group — the reconciliation unit's ordered members (sync-arch §1.5). */
  async listByPresenceGroup(db: DbClient, presenceGroupId: string): Promise<Row<"copy">[]> {
    const { data, error } = await db
      .from("copy")
      .select("*")
      .eq("presence_group_id", presenceGroupId);
    if (error) throw error;
    return data ?? [];
  },
};
