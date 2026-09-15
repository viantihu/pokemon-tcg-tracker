/**
 * Creating and editing a collection — the testable core `actions.ts`'s `saveCollection` wraps
 * (`getOwnerContext()` only), same seam as `applyCollectionRemoval`/`applyCollectionLog`.
 *
 * UIL-038: a new collection used to live only in client state until an explicit "Save collection"
 * click created it — any interruption before that click (a crash, a closed tab, forgetting about it
 * for a week) lost everything typed with nothing server-side to resume. `draft: true` relaxes the two
 * checks that only matter before she has committed to a name and a home — a still-being-built draft
 * needs to persist with an empty name or an unpicked binder, since autosave fires on every field
 * change rather than waiting for a final submit:
 *   - the name-must-be-non-empty check is skipped (an empty name just saves as an empty string).
 *   - an unresolved `"__new"` binder pick (chosen, but not yet named) leaves `current_binder_ids`
 *     empty rather than erroring, instead of requiring a binder name to exist yet.
 *
 * Every safety guard stays ON regardless of `draft` — `blockedTargetDrops` (UIL-014) and
 * `blockedBinderRebind` (UIL-040) run unconditionally, because a draft that already has real shelved
 * copies (editing an existing, already-active collection) can strand them exactly the same way a
 * fully "saved" edit could. `draft` only ever widens what an EMPTY field is allowed to look like; it
 * never narrows what a WRITE is allowed to do.
 */

import { binderRepo, collectionRepo, type DbClient } from "@/lib/repo";
import type { CollectionMode } from "@/lib/surfaces";
import {
  blockedBinderRebind,
  blockedBinderRebindMessage,
  blockedTargetDrops,
  blockedTargetDropsMessage,
} from "./remove";

export interface CollectionSaveInput {
  id?: string | null;
  name: string;
  mode: CollectionMode;
  binderId: string; // an existing specialty binder id, or "__new"
  newBinderName?: string;
  targetTcgdexIds: string[];
}

export type CollectionSaveOutcome = { ok: true; id: string } | { ok: false; error: string };

export async function applyCollectionSave(
  db: DbClient,
  ownerId: string,
  input: CollectionSaveInput,
  opts: { draft?: boolean } = {},
): Promise<CollectionSaveOutcome> {
  const name = input.name.trim();
  if (!name && !opts.draft) return { ok: false, error: "A collection needs a name." };

  let binderId: string | null = input.binderId;
  if (binderId === "__new") {
    const bn = (input.newBinderName ?? "").trim();
    if (bn) {
      const created = await binderRepo.insert(db, {
        owner_id: ownerId,
        name: bn,
        type: "specialty",
        pages: 20,
        pockets_per_page: 9,
        is_active: false,
      });
      binderId = created.id;
    } else if (opts.draft) {
      binderId = null; // nothing chosen yet — tolerated only while still a draft
    } else {
      return { ok: false, error: "Name the new binder." };
    }
  }

  if (input.id) {
    const existing = await collectionRepo.getByPk(db, input.id);
    if (!existing) return { ok: false, error: "That collection no longer exists." };

    const blocked = await blockedTargetDrops(db, existing, input.targetTcgdexIds);
    if (blocked.length > 0) return { ok: false, error: blockedTargetDropsMessage(blocked) };

    const blockedBinder = await blockedBinderRebind(db, existing, binderId ? [binderId] : []);
    if (blockedBinder.length > 0) {
      return { ok: false, error: blockedBinderRebindMessage(blockedBinder) };
    }
  }

  const patch = {
    name,
    mode: input.mode,
    current_binder_ids: binderId ? [binderId] : [],
    target_catalog_card_ids: input.targetTcgdexIds,
  };

  if (input.id) {
    await collectionRepo.update(db, input.id, patch);
    return { ok: true, id: input.id };
  }
  const created = await collectionRepo.insert(db, {
    owner_id: ownerId,
    definition_type: "curated",
    ...patch,
  });
  return { ok: true, id: created.id };
}
