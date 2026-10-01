/** Her bulk boxes (UIL-130, 0035): named like binders; capacity null = untracked, never full. */
import { createRepo, type DbClient, type Row } from "./base";

export const bulkUnitRepo = {
  ...createRepo("bulk_unit"),

  /** Her boxes, in her order (her default first among equals). */
  async listOrdered(db: DbClient): Promise<Row<"bulk_unit">[]> {
    const { data, error } = await db
      .from("bulk_unit")
      .select("*")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) throw error;
    return data ?? [];
  },
};
