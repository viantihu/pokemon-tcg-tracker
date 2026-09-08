/** PlacementDecision: the audit trail, one row per card per placement. system-design §4; dev-spec §4. */
import { createRepo, type DbClient, type Row } from "./base";

export const placementDecisionRepo = {
  ...createRepo("placement_decision"),

  /** The audit trail for one haul, oldest first. */
  async listByHaul(db: DbClient, haulId: string): Promise<Row<"placement_decision">[]> {
    const { data, error } = await db
      .from("placement_decision")
      .select("*")
      .eq("haul_id", haulId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return data ?? [];
  },
};
