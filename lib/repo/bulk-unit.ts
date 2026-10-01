/** Her bulk boxes (UIL-130, 0035): named like binders; capacity null = untracked, never full. */
import { createRepo, type DbClient, type Row } from "./base";

/** One of her boxes as every screen reads it: its limit, whether it is her default, and how many cards it holds. */
export interface BulkUnitView {
  id: string;
  name: string;
  /** null: untracked, never full. */
  capacity: number | null;
  isDefault: boolean;
  /** The bulk copies in it now. */
  held: number;
}

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

  /** Her boxes in her order, each with how many cards it holds: one count per box (a handful), never every copy. */
  async views(db: DbClient): Promise<BulkUnitView[]> {
    const units = await bulkUnitRepo.listOrdered(db);
    const held = await Promise.all(
      units.map(async (u) => {
        const { count, error } = await db
          .from("copy")
          .select("id", { count: "exact", head: true })
          .eq("bulk_unit_id", u.id)
          .eq("role", "bulk");
        if (error) throw error;
        return count ?? 0;
      }),
    );
    return units.map((u, i) => ({
      id: u.id,
      name: u.name,
      capacity: u.capacity,
      isDefault: u.is_default,
      held: held[i],
    }));
  },
};
