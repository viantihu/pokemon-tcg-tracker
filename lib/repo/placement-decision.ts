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
  /**
   * The LATEST decision on each of `copyIds` (by `created_at`), for the copies that have one. The pending queue
   * needs the latest, not just "any": a bulk copy pulled back into her haul (Karvi, 2026-11-11) carries the
   * decision that once sent it to bulk AND the newer one that pulled it out, and only the newer says where it
   * stands. Chunked like `listDecidedCopyIds`.
   */
  async listLatestByCopy(
    db: DbClient,
    copyIds: string[],
    chunkSize = 100,
  ): Promise<Map<string, { decision: string; reason: string }>> {
    const latest = new Map<string, { decision: string; reason: string; at: string }>();
    for (let i = 0; i < copyIds.length; i += chunkSize) {
      const chunk = copyIds.slice(i, i + chunkSize);
      const { data, error } = await db
        .from("placement_decision")
        .select("copy_id, decision, reason, created_at")
        .in("copy_id", chunk);
      if (error) throw error;
      for (const r of data ?? []) {
        if (!r.copy_id) continue;
        const prior = latest.get(r.copy_id);
        if (!prior || r.created_at > prior.at) {
          latest.set(r.copy_id, { decision: r.decision, reason: r.reason, at: r.created_at });
        }
      }
    }
    return new Map([...latest].map(([id, v]) => [id, { decision: v.decision, reason: v.reason }]));
  },
};
