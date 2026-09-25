/** Copy: a physical card owned. system-design §4. */
import { createRepo, pageFiltered, type DbClient, type Row } from "./base";

export const copyRepo = {
  ...createRepo("copy"),

  /**
   * Shelved copies in one section of one binder — the duplicate check compares against shelved
   * only. `half: null` is a specialty binder's single section, which stores no half at all (see
   * migration 0002: `binder_half` is NULL for those rows, never a literal "single").
   */
  async listShelvedInSection(
    db: DbClient,
    binderId: string,
    half: "front" | "back" | null,
  ): Promise<Row<"copy">[]> {
    let q = db.from("copy").select("*").eq("role", "shelved").eq("binder_id", binderId);
    q = half === null ? q.is("binder_half", null) : q.eq("binder_half", half);
    const { data, error } = await q;
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
   * Every catalog card she holds ANYWHERE, at least once. Paged past the row cap: the search grid
   * (UIL-039) uses this both to badge "owned" on a page of results and, as an id list, to filter to
   * owned/unowned at the DB level so pagination stays correct (excluding after the fact would make a
   * page's count a lie).
   *
   * ASKED AS "NOT A BLOCK", not as a list of the roles that count (UIL-093). It was
   * `.in("role", ["shelved", "bulk"])`, which silently stopped meaning "anywhere" the moment UIL-088
   * added a third place a card can be: 545 cards sitting in her haul badged as NOT OWNED on the one
   * screen she uses to check. Dex is the source of truth for what she owns, and a card an import
   * created is owned — it simply has not been placed yet.
   *
   * `block` stays excluded, and it is the only exclusion, because it is the only role that is not a
   * card: it marks a pocket run no card can ever fill (system-design §4). Same exclusion as UIL-048's
   * `findExistingCopy`, and phrasing both as "not a block" is what keeps them from drifting apart
   * again the next time a role is added.
   */
  async ownedCatalogCardIdSet(db: DbClient): Promise<Set<string>> {
    const rows = await pageFiltered<{ catalog_card_id: string }>("copy", (from, to) =>
      db
        .from("copy")
        .select("catalog_card_id")
        .neq("role", "block")
        .order("id", { ascending: true })
        .range(from, to),
    );
    return new Set(rows.map((r) => r.catalog_card_id));
  },

  /**
   * Copies that hold NO placement: in the bulk box, in no binder, in no line slot. This is the raw
   * candidate set for the Haul Plan's pending-placement queue (UIL-003) — the shape sync's `creates`
   * and manual-match leave behind (`role: 'bulk'`, everything else null; lib/sync/exec.ts). It also
   * catches copies the cascade legitimately ROUTED to bulk, so the caller must still subtract the
   * ones that already have a `placement_decision`; `lib/plan/pending.ts` does that.
   *
   * Oldest first, so the queue is worked in the order the cards entered the collection —
   * `created_at` ties broken by `id` for a stable, gapless order across a page boundary.
   *
   * Paged rather than guarded-and-thrown (UIL-031): this repo used to detect truncation here and
   * throw, on the reasoning that a card past the cap silently never appearing is worse than an
   * error. Right against silent truncation, but wrong against the option it didn't weigh — paging
   * gives a COMPLETE queue, which beats both. It also avoids a deadlock a throw would create: this
   * IS the Haul Plan's queue, so throwing here means `/plan` cannot load, and placing the queue's
   * own cards down below the cap is the only in-app way out of a queue that's over it.
   */
  async listUnplaced(db: DbClient): Promise<Row<"copy">[]> {
    return pageFiltered<Row<"copy">>("copy", (from, to) =>
      db
        .from("copy")
        .select("*")
        /**
         * UIL-088: the ROLE is now the answer, where this was `role = 'bulk' AND binder_id IS NULL AND
         * line_slot_id IS NULL` — the same question asked as a conjunction that could drift from every
         * other asking of it.
         *
         * The two column checks STAY, as a guard rather than as the definition. A copy in the haul with a
         * binder or a line slot is a contradiction, and this project has shipped exactly that
         * contradiction before (UIL-087: three copies wired to a slot while not shelved). Dropping the
         * guards would put such a row into the queue she works from, which is worse than filtering a row
         * that should not exist. They cost nothing and they refuse a contradiction rather than restate a
         * definition.
         *
         * `loadPendingPlacements` applies the `placement_decision` check separately: a decision row is
         * what takes a card OUT of the queue (UIL-042), which is a different fact from where it sits.
         */
        .eq("role", "haul")
        .is("binder_id", null)
        .is("line_slot_id", null)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    );
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

/**
 * Copies she has REMOVED that her Dex export still lists (UIL-089, table added in 0020).
 *
 * Read once per import and subtracted from desired presence, so a card she traded away is not handed back
 * to her every time she syncs. Written only through `apply_write_ops` — the increment has to be computed
 * server-side from the column, or two removals of one printing racing each other would lose one (0007's
 * lesson from `union_collection_targets`), so there is deliberately no write method here.
 */
export const removedPresenceRepo = {
  /** Every memory she holds. Small by nature: one row per (card, variant) she has ever removed. */
  async listAll(db: DbClient): Promise<Row<"removed_presence">[]> {
    const { data, error } = await db.from("removed_presence").select("*");
    if (error) throw error;
    return data ?? [];
  },

  /** The memory for one presence key, or null (UIL-099 E2: what a manual match must not hand back). */
  async findByKey(
    db: DbClient,
    catalogCardId: string,
    dexVariantRaw: string,
  ): Promise<Row<"removed_presence"> | null> {
    const { data, error } = await db
      .from("removed_presence")
      .select("*")
      .eq("catalog_card_id", catalogCardId)
      .eq("dex_variant_raw", dexVariantRaw)
      .maybeSingle();
    if (error) throw error;
    return data ?? null;
  },
};
