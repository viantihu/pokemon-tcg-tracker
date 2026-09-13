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

  /**
   * Which of `copyIds` already have a decision row — i.e. which copies the cascade has already ruled
   * on. A decision IS the record that a copy went through placement, so this is how the pending queue
   * tells "sync dropped this here, unrouted" from "the cascade deliberately sent this to bulk"
   * (UIL-003; see lib/plan/pending.ts).
   *
   * Chunked: the ids go into a PostgREST `in.(...)` filter on the URL, so a few hundred uuids in one
   * call would blow the request-line length.
   */
  async listDecidedCopyIds(db: DbClient, copyIds: string[], chunkSize = 100): Promise<Set<string>> {
    const decided = new Set<string>();
    for (let i = 0; i < copyIds.length; i += chunkSize) {
      const chunk = copyIds.slice(i, i + chunkSize);
      const { data, error } = await db
        .from("placement_decision")
        .select("copy_id")
        .in("copy_id", chunk);
      if (error) throw error;
      for (const r of data ?? []) if (r.copy_id) decided.add(r.copy_id);
    }
    return decided;
  },
};
