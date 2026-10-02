/** WishlistItem: every open placeholder surfaces here. system-design §4, §6. */
import { createRepo, pageFiltered, type DbClient, type Row } from "./base";

export const wishlistItemRepo = {
  ...createRepo("wishlist_item"),

  /**
   * Still-open wishlist items (not yet resolved), EVERY one: paged past the server's row cap. This was one unpaged
   * read with no count, so past 1,000 open wishes it came back short with no error, and Collections, Lookup and the
   * wish writer each worked from the first thousand. Ordered by id, a total order, so the pages tile; one request
   * while they fit in one page (the count ends the walk).
   */
  async listOpen(db: DbClient): Promise<Row<"wishlist_item">[]> {
    return pageFiltered<Row<"wishlist_item">>("wishlist_item", (from, to) =>
      db
        .from("wishlist_item")
        .select("*", { count: "exact" })
        .is("resolved_at", null)
        .order("id", { ascending: true })
        .range(from, to),
    );
  },
};
