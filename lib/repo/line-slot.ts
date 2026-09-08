/** LineSlot: the ordered stages of a line (filled / placeholder / block). system-design §6. */
import { createRepo, type DbClient, type Row } from "./base";

export const lineSlotRepo = {
  ...createRepo("line_slot"),

  /** All slots of a line, in evolution order. */
  async listByLine(db: DbClient, lineId: string): Promise<Row<"line_slot">[]> {
    const { data, error } = await db
      .from("line_slot")
      .select("*")
      .eq("line_id", lineId)
      .order("stage_index", { ascending: true });
    if (error) throw error;
    return data ?? [];
  },
};
