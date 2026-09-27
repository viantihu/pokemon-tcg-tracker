"use server";

/**
 * The line popup's server side for every screen (UIL-117): Lines, Lookup and Collections all open the same popup,
 * so they share this one action rather than three copies. Exports async functions only (tests/app/use-server-exports).
 */

import { getOwnerContext } from "@/lib/plan/session";
import { errorMessage } from "@/lib/errors";
import type { FillerCardOption, LinePopupModel, LineProposal, StageOption } from "@/lib/line/popup";
import { loadLinePopupModel } from "@/lib/line/popup-load";
import { loadBulkFillers, loadStageOptions } from "@/lib/line/stage-options-load";
import type { Locale } from "@/lib/sync/types";

/** The line popup's model for a card headed into a back half, built from fresh state. */
export async function lineModelAction(
  copyId: string,
  proposal: LineProposal,
  /** UIL-121: the haul copies the screen routes to this same line (the Haul Plan); they are shown as coming. */
  comingCopyIds?: string[],
): Promise<{ ok: true; model: LinePopupModel } | { ok: false; error: string }> {
  try {
    const { db } = await getOwnerContext();
    return { ok: true, model: await loadLinePopupModel(db, copyId, proposal, { comingCopyIds }) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** UIL-121: the printings she can chase for a stage, in the line's language, same colour first. */
export async function stageOptionsAction(
  dexId: number,
  locale: Locale,
  lineBandKey: string,
): Promise<{ ok: true; options: StageOption[] } | { ok: false; error: string }> {
  try {
    const { db } = await getOwnerContext();
    return { ok: true, options: await loadStageOptions(db, dexId, locale, lineBandKey) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** UIL-121: the spare copies in her bulk box that could fill a pocket. */
export async function bulkFillerAction(): Promise<
  { ok: true; options: FillerCardOption[] } | { ok: false; error: string }
> {
  try {
    const { db } = await getOwnerContext();
    return { ok: true, options: await loadBulkFillers(db) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
