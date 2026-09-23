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
  moveNameLookups,
  type DecisionChoiceId,
  type LineScreenData,
  type LineViewMode,
  type MoveDestination,
} from "@/lib/line";
import { getOwnerContext } from "@/lib/plan/session";
import { applyCopyRemoval } from "@/lib/copy";
import { errorMessage } from "@/lib/errors";

/** Reload the whole screen model (called after every mutation so the strip + queue stay truthful). */
export async function loadLine(view: LineViewMode = "color"): Promise<LineScreenData> {
  const { db } = await getOwnerContext();
  return loadLineScreen(db, { view });
}

export type MoveActionResult =
  { ok: true; label: string; data: LineScreenData } | { ok: false; error: string };

/**
 * Move an owned/shelved card: rewrite placement, join the destination collection's chase list when
 * there is one, write the user audit row — all in one transaction — then return fresh data.
 *
 * No `ownerId` is passed: the move now goes through the SECURITY INVOKER `apply_write_ops` RPC, where
 * `owner_id` defaults to `auth.uid()` and RLS enforces it rather than being carried in a payload.
 */
export async function moveCardAction(
  copyId: string,
  destination: MoveDestination,
  /** The strip order she is viewing (UIL-074), so the refreshed data comes back in it. */
  view: LineViewMode = "color",
): Promise<MoveActionResult> {
  try {
    const { db } = await getOwnerContext();
    const before = await loadLineScreen(db);
    const res = await applyMove(db, { copyId, destination }, moveNameLookups(before.moveOptions));
    const data = await loadLineScreen(db, { view });
    return { ok: true, label: res.destinationLabel, data };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * Remove the copy filling a slot (UIL-089), then hand back fresh data in the view she is looking at.
 *
 * The removal itself releases the slot and reopens the line in its own transaction (lib/copy/remove.ts);
 * this only re-reads, so the stage shows as wanted again instead of filled by a card she does not have.
 */
export async function removeSlotCopyAction(
  copyId: string,
  view: LineViewMode = "color",
): Promise<DecisionActionResult> {
  try {
    const { db } = await getOwnerContext();
    const res = await applyCopyRemoval(db, copyId);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, data: await loadLineScreen(db, { view }) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export type DecisionActionResult =
  { ok: true; data: LineScreenData } | { ok: false; error: string };

/** Resolve a decision (confirm or override): apply writes + audit, then return fresh data. */
export async function resolveDecisionAction(
  decisionId: string,
  choiceId: DecisionChoiceId,
  pickedCatalogCardId?: string,
  /** The strip order she is viewing (UIL-074), so the refreshed data comes back in it. */
  view: LineViewMode = "color",
): Promise<DecisionActionResult> {
  try {
    const { db, ownerId } = await getOwnerContext();
    await applyDecision(db, ownerId, decisionId, choiceId, pickedCatalogCardId);
    const data = await loadLineScreen(db, { view });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
