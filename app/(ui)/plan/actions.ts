"use server";

/**
 * Server actions for the haul plan screen (dev-spec §5 M6; §7B).
 *
 * Everything the plan screen needs from the server: type-ahead against the LOCAL catalog mirror,
 * the cascade run over a draft, and the atomic commit. The client NEVER queries TCGdex — all
 * catalog access is server-side via `lib/repo`. Owner/session is resolved through the stubbed seam
 * (`getOwnerContext` — service role + seeded owner until magic-link auth lands; see session.ts).
 */

import { availableVariants, toCardVariants } from "@/lib/plan";
import {
  commitHaul,
  getOwnerContext,
  groupPlan,
  loadPlanContext,
  planFromDraft,
  type DraftItem,
} from "@/lib/plan";
import { loadMoveOptions, type MoveOptions } from "@/lib/line";
import { catalogCardRepo } from "@/lib/repo";
import type { CommitActionInput, CommitCounts, LookupCard, RunPlanResult } from "./plan-types";

/** Type-ahead against the local mirror. Returns [] on error so typing never breaks. */
export async function lookupCatalog(query: string): Promise<LookupCard[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  try {
    const { db } = getOwnerContext();
    const rows = await catalogCardRepo.search(db, q, 12);
    return rows.map((r) => ({
      tcgdexId: r.tcgdex_id,
      name: r.name,
      setId: r.set_id,
      setName: r.set_name,
      localId: r.local_id,
      stage: r.stage,
      types: r.types ?? [],
      cardClass: r.card_class === "specialty" ? "specialty" : "standard",
      imageUrl: r.image_url,
      variants: availableVariants(toCardVariants(r.variants)),
    }));
  } catch {
    return [];
  }
}

/** Run the cascade over the whole draft and return the grouped plan for rendering. */
export async function runHaulPlan(draft: DraftItem[]): Promise<RunPlanResult> {
  const { db } = getOwnerContext();
  const pc = await loadPlanContext(db);
  const { items } = planFromDraft(pc, draft);
  const groups = groupPlan(items, pc.orderedBandKeys);

  const byAction: Record<string, number> = {};
  for (const it of items) byAction[it.action] = (byAction[it.action] ?? 0) + 1;

  return {
    groups,
    bands: groups.map((g) => ({ key: g.bandKey, count: g.count })),
    summary: {
      total: items.length,
      decisions: items.filter((it) => it.needsDecision).length,
      byAction,
    },
  };
}

/** Commit the haul: write all records + audit trail atomically (compensating rollback on failure). */
export async function commitHaulAction(
  input: CommitActionInput,
): Promise<{ ok: true; haulId: string; counts: CommitCounts } | { ok: false; error: string }> {
  if (input.draft.length === 0) return { ok: false, error: "No cards in the haul." };
  try {
    const { db, ownerId } = getOwnerContext();
    const res = await commitHaul(db, ownerId, {
      source: input.source,
      notes: input.notes ?? null,
      draft: input.draft,
      overrides: input.overrides,
    });
    return { ok: true, haulId: res.haulId, counts: res.counts };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Move-panel options (binders, collections, bands) for the spotlight placement override (M7). */
export async function getMoveOptions(): Promise<MoveOptions> {
  const { db } = getOwnerContext();
  return loadMoveOptions(db);
}
