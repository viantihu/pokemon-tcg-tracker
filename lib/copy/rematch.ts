/**
 * "This is the wrong card" — rematch a waiting copy, or give it a stand-in (Karvi, 2026-10-26).
 *
 * The sync matches a Dex row to a catalog card by set and number, and sometimes the card it picks is not the card she
 * holds. The Sync page lets her fix a row that parked; this is the same fix for a row that matched WRONG, offered where
 * she finds out: on the card in the Haul Plan's spotlight, before it is shelved.
 *
 * ONE COPY, NOT THE ROW. Only the card in her hand moves (her ruling). The database function (0040 `rematch_copy`)
 * moves that copy's count between the two Dex keys, joins her existing group for the new card when she has one, and
 * refuses a copy that is already shelved, all in one transaction, so the Count check still adds up afterwards.
 *
 * A STAND-IN is the same move with a card she makes first, for a printing the catalog does not carry: the Sync page's
 * form, the same twin rule (`findStandInTwin`), and the same marking so it is swapped for the real card later (0039).
 * The stand-in and the rematch are two transactions, so a rematch the database then refuses (the copy was shelved in
 * another tab) takes the new stand-in back rather than leaving a card nobody holds.
 */

import { errorMessage } from "@/lib/errors";
import { applyWriteOps, catalogCardRepo, copyRepo, type DbClient } from "@/lib/repo";
import { isLanguage } from "@/lib/catalog/locale";
import { findStandInTwin, newStandInId, StandInTwinError, type StandInInput } from "@/lib/sync";

/** What the stand-in form sends for a rematch: the sync form's input, minus the set id (a rematch has no Dex row to derive it from). */
export type RematchStandInInput = Omit<StandInInput, "setId">;

/** Point one waiting copy at `cardId`. Throws the database's refusal, which is already in her words. */
export async function rematchCopy(db: DbClient, copyId: string, cardId: string): Promise<void> {
  try {
    await copyRepo.rematch(db, copyId, cardId);
  } catch (err) {
    const m = (err as { message?: unknown } | null)?.message;
    throw new Error(typeof m === "string" && m ? m : "The rematch failed. Reload and try again.");
  }
}

/**
 * Make her stand-in and point the copy at it. Throws `StandInTwinError` instead of making a second stand-in for the
 * same card (the caller offers "rematch to the existing one"). Returns the stand-in's id.
 */
export async function rematchCopyToStandIn(
  db: DbClient,
  copyId: string,
  input: RematchStandInInput,
): Promise<string> {
  const name = input.name.trim();
  if (!name) throw new Error("A stand-in needs a name.");
  if (!isLanguage(input.language)) throw new Error("Pick the language the card is printed in.");

  const twin = await findStandInTwin(db, input);
  if (twin) throw new StandInTwinError(twin);

  const standInId = newStandInId(input.language);
  const k = input.kind;
  await applyWriteOps(db, {
    ops: [
      {
        op: "insert_catalog_stand_in",
        tcgdex_id: standInId,
        name,
        set_id: null,
        set_name: input.setName?.trim() || null,
        local_id: input.localId?.trim() || null,
        dex_id: k.kind === "pokemon" && k.dexId ? [k.dexId] : [],
        types: k.kind === "pokemon" ? [k.type] : [],
        stage: k.kind === "pokemon" ? k.stage : null,
        card_class: input.cardClass ?? "standard",
      },
    ],
    resyncGroupIds: [],
  });
  try {
    await rematchCopy(db, copyId, standInId);
  } catch (err) {
    // Best effort: a stand-in left behind is harmless (the twin rule would offer it next time), so a failed clean-up
    // never hides the refusal she needs to read.
    await catalogCardRepo.deleteStandIn(db, standInId).catch(() => undefined);
    throw new Error(errorMessage(err));
  }
  return standInId;
}
