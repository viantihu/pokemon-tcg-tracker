/** Copy: a physical card owned. system-design §4. */
import { createRepo, type DbClient, type Row } from "./base";

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
};
