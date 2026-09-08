/** BinderSection: a derived VIEW, one row per (binder, half). Read-only. system-design §4. */
import type { DbClient, ViewRow } from "./base";

export const binderSectionRepo = {
  async list(db: DbClient): Promise<ViewRow<"binder_section">[]> {
    const { data, error } = await db.from("binder_section").select("*");
    if (error) throw error;
    return data ?? [];
  },

  async byBinder(db: DbClient, binderId: string): Promise<ViewRow<"binder_section">[]> {
    const { data, error } = await db.from("binder_section").select("*").eq("binder_id", binderId);
    if (error) throw error;
    return data ?? [];
  },
};
