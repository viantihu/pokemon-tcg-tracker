"use server";

/**
 * The line popup's server side for every screen (UIL-117): Lines, Lookup and Collections all open the same popup,
 * so they share this one action rather than three copies. Exports async functions only (tests/app/use-server-exports).
 */

import { getOwnerContext } from "@/lib/plan/session";
import { errorMessage } from "@/lib/errors";
import type { LinePopupModel, LineProposal } from "@/lib/line/popup";
import { loadLinePopupModel } from "@/lib/line/popup-load";

/** The line popup's model for a card headed into a back half, built from fresh state. */
export async function lineModelAction(
  copyId: string,
  proposal: LineProposal,
): Promise<{ ok: true; model: LinePopupModel } | { ok: false; error: string }> {
  try {
    const { db } = await getOwnerContext();
    return { ok: true, model: await loadLinePopupModel(db, copyId, proposal) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
