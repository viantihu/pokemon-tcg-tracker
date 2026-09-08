"use server";

/**
 * Server actions for the line-detail screen (dev-spec §5 M7).
 *
 * Everything the screen needs from the server: (re)load the persisted lines + outstanding
 * decisions + move options, apply a manual move, and resolve a decision. All catalog/DB access is
 * server-side via `lib/line` (which calls `lib/repo`); the client never touches Supabase or TCGdex.
 * Owner/session is resolved through the auth seam (`await getOwnerContext()` — RLS-scoped client +
 * session owner id; see lib/plan/session.ts).
 */

import {
  applyDecision,
  applyMove,
  loadLineScreen,
  type DecisionChoiceId,
  type LineScreenData,
  type MoveDestination,
  type MoveNameLookups,
} from "@/lib/line";
import { getOwnerContext } from "@/lib/plan/session";

/** Reload the whole screen model (called after every mutation so the strip + queue stay truthful). */
export async function loadLine(): Promise<LineScreenData> {
  const { db } = await getOwnerContext();
  return loadLineScreen(db);
}

function nameLookups(data: LineScreenData): MoveNameLookups {
  const binderName = (id: string | null) =>
    (id && data.moveOptions.binders.find((b) => b.id === id)?.name) || "Binder";
  const collectionName = (id: string) => {
    for (const list of Object.values(data.moveOptions.collectionsByBinder)) {
      const hit = list.find((c) => c.id === id);
      if (hit) return hit.name;
    }
    return null;
  };
  const bandDisplay = (key: string) =>
    data.moveOptions.bands.find((b) => b.key === key)?.display ?? key;
  return { binderName, collectionName, bandDisplay };
}

export type MoveActionResult =
  { ok: true; label: string; data: LineScreenData } | { ok: false; error: string };

/** Move an owned/shelved card: rewrite placement + write the user audit row, then return fresh data. */
export async function moveCardAction(
  copyId: string,
  destination: MoveDestination,
): Promise<MoveActionResult> {
  try {
    const { db, ownerId } = await getOwnerContext();
    const before = await loadLineScreen(db);
    const res = await applyMove(db, ownerId, { copyId, destination }, nameLookups(before));
    const data = await loadLineScreen(db);
    return { ok: true, label: res.destinationLabel, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type DecisionActionResult =
  { ok: true; data: LineScreenData } | { ok: false; error: string };

/** Resolve a decision (confirm or override): apply writes + audit, then return fresh data. */
export async function resolveDecisionAction(
  decisionId: string,
  choiceId: DecisionChoiceId,
): Promise<DecisionActionResult> {
  try {
    const { db, ownerId } = await getOwnerContext();
    await applyDecision(db, ownerId, decisionId, choiceId);
    const data = await loadLineScreen(db);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
