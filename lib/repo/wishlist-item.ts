/** WishlistItem: every open placeholder surfaces here. system-design §4, §6. */
import { createRepo, type DbClient, type Row } from "./base";

export const wishlistItemRepo = {
  ...createRepo("wishlist_item"),

  /** Still-open wishlist items (not yet resolved). */
  async listOpen(db: DbClient): Promise<Row<"wishlist_item">[]> {
    const { data, error } = await db.from("wishlist_item").select("*").is("resolved_at", null);
    if (error) throw error;
    return data ?? [];
  },
};
