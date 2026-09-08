/** Binder: a configurable binder. system-design §4. */
import { createRepo, type DbClient, type Row } from "./base";

export const binderRepo = {
  ...createRepo("binder"),

  /** The single active binder (decision §3: new lines land here). */
  async getActive(db: DbClient): Promise<Row<"binder"> | null> {
    const { data, error } = await db.from("binder").select("*").eq("is_active", true).maybeSingle();
    if (error) throw error;
    return data ?? null;
  },
};
