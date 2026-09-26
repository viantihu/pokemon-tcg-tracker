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
 *
 * An unresolved `"__new"` pick's fallback depends on whether a real collection already exists: a
 * brand-new draft has no binder yet, so leaving `current_binder_ids` empty loses nothing; an EXISTING
 * collection already has a real one, and an unfinished "+ New binder" click sitting alongside some
 * unrelated passive edit (she typed a name before naming the binder) must not clear it. So `existing`
 * is loaded before the binder is resolved, and its current binder is the fallback, not null.
 */

import { errorMessage } from "@/lib/errors";
import {
  applyWriteOps,
  binderRepo,
  catalogCardRepo,
  collectionRepo,
  copyRepo,
  type DbClient,
  type WriteOp,
} from "@/lib/repo";
import type { CollectionMode } from "@/lib/surfaces";
import {
  blockedBinderRebind,
  blockedBinderRebindMessage,
  blockedTargetDrops,
  blockedTargetDropsMessage,
} from "./remove";
import { rebindRemedyFor, type RebindRemedy } from "./rebind";
import { collectionWishOp, openWishedCardIds } from "./wish";

export interface CollectionSaveInput {
  id?: string | null;
  name: string;
  mode: CollectionMode;
  binderId: string; // an existing specialty binder id, or "__new"
  newBinderName?: string;
  targetTcgdexIds: string[];
}

/**
 * `remedy` rides on exactly one refusal — the UIL-040 rebind guard — and is what lets the editor offer
 * "move them and rebind" on the same bar as the refusal (step 2) instead of a dead end. Every other
 * refusal is a bare message, as before.
 */
export type CollectionSaveOutcome =
  { ok: true; id: string } | { ok: false; error: string; remedy?: RebindRemedy };

export async function applyCollectionSave(
  db: DbClient,
  ownerId: string,
  input: CollectionSaveInput,
  opts: { draft?: boolean } = {},
): Promise<CollectionSaveOutcome> {
  const name = input.name.trim();
  if (!name && !opts.draft) return { ok: false, error: "A collection needs a name." };

  const existing = input.id ? await collectionRepo.getByPk(db, input.id) : null;
  if (input.id && !existing) return { ok: false, error: "That collection no longer exists." };

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
      // Nothing named yet. A brand-new draft has no binder to lose, so this is null; an existing
      // collection keeps whatever it already has rather than being cleared by an unfinished pick.
      binderId = existing?.current_binder_ids?.[0] ?? null;
    } else {
      return { ok: false, error: "Name the new binder." };
    }
  }

  if (existing) {
    const blocked = await blockedTargetDrops(db, existing, input.targetTcgdexIds);
    if (blocked.length > 0) return { ok: false, error: blockedTargetDropsMessage(blocked) };

    const blockedBinder = await blockedBinderRebind(db, existing, binderId ? [binderId] : []);
    if (blockedBinder.length > 0) {
      // Step 2 (UIL-040): the refusal stands, and names its remedy. `rebindRemedyFor` re-reads fresh
      // state rather than reshaping `blockedBinder`, because it also has to know which of those cards
      // another collection still in the old binder chases (those stay; the bar says so).
      const remedy = binderId ? await rebindRemedyFor(db, existing, binderId) : null;
      return {
        ok: false,
        error: blockedBinderRebindMessage(blockedBinder),
        ...(remedy ? { remedy } : {}),
      };
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

/** What a bulk add did, card by card, so the page can say where each one went (UIL-101). */
export interface BulkAddCounts {
  /** Newly on this collection's chase list (ones already listed are not counted again). */
  added: number;
  /** Of the cards she picked: not owned, and now on her wishlist. */
  wishlisted: number;
  /** Of the cards she picked: not owned, and already on her wishlist, so not wished for twice. */
  alreadyWished: number;
  /** Of the cards she picked: ones she already owns, which only join the chase list. */
  owned: number;
}

/**
 * Bulk-add from the search grid (UIL-039), with UIL-098 part 1's rule for a card she does not own (UIL-101).
 *
 * Every picked card joins the collection's chase list. A card she owns does nothing else. A card she does NOT
 * own also goes on her WISHLIST, in the same row shape a single add writes (`collectionWishOp`), unless it is
 * already there. It never creates a copy: Dex is the only source of what she owns (UIL-098).
 *
 * ONE TRANSACTION. The wishes and the chase-list join are a single `apply_write_ops` call, so either every
 * card lands or none does. The join is `union_collection_targets`, the op every other "into a collection"
 * path emits, unioned server-side and idempotent for ids already listed, so re-submitting a selection that
 * partially landed (a flaky request, a double click) is harmless. This path only ever grows the list and
 * never touches name, mode or binder, so it cannot strand a card (UIL-014, UIL-040) by construction.
 *
 * "Owned" is any copy that is not a binder block, the same question `findExistingCopy` asks (UIL-093): a
 * card in her haul or the bulk box is hers.
 */
export async function applyBulkAddTargets(
  db: DbClient,
  // Kept for the call signature; the RPC is SECURITY INVOKER and owner_id defaults to auth.uid().
  _ownerId: string,
  collectionId: string,
  tcgdexIds: string[],
): Promise<({ ok: true } & BulkAddCounts) | { ok: false; error: string }> {
  const existing = await collectionRepo.getByPk(db, collectionId);
  if (!existing) return { ok: false, error: "That collection no longer exists." };

  // A card picked twice is one card: one wish at most, counted once.
  const ids = [...new Set(tcgdexIds)];
  const listed = new Set(existing.target_catalog_card_ids ?? []);
  const counts: BulkAddCounts = {
    added: ids.filter((id) => !listed.has(id)).length,
    wishlisted: 0,
    alreadyWished: 0,
    owned: 0,
  };
  if (ids.length === 0) return { ok: true, ...counts };

  const [owned, wished, cards] = await Promise.all([
    copyRepo.ownedCatalogCardIdSet(db),
    openWishedCardIds(db),
    catalogCardRepo.listByIds(db, ids),
  ]);
  const byId = new Map(cards.map((c) => [c.tcgdex_id, c]));
  const binderId = existing.current_binder_ids?.[0] ?? null;

  const ops: WriteOp[] = [];
  for (const id of ids) {
    if (owned.has(id)) {
      counts.owned += 1;
      continue;
    }
    if (wished.has(id)) {
      counts.alreadyWished += 1;
      continue;
    }
    const card = byId.get(id);
    // The grid only offers catalog cards, so this is a card that left the catalog mid-session. All or
    // nothing: say so rather than listing it with no wish behind it.
    if (!card)
      return {
        ok: false,
        error: "One of those cards is no longer in the catalog. Reload the page.",
      };
    ops.push(collectionWishOp(card, binderId));
    counts.wishlisted += 1;
  }
  ops.push({ op: "union_collection_targets", collection_id: collectionId, catalog_card_ids: ids });

  try {
    await applyWriteOps(db, { ops });
  } catch (err) {
    return { ok: false, error: `Could not add these cards: ${errorMessage(err)}` };
  }

  // `union_collection_targets` matches no row for a collection that vanished (or stopped being hers)
  // between the read above and the write, and says nothing. Do not let that pass as success.
  const after = await collectionRepo.getByPk(db, collectionId);
  const nowListed = new Set(after?.target_catalog_card_ids ?? []);
  if (!after || !ids.every((id) => nowListed.has(id))) {
    return {
      ok: false,
      // A wish does not depend on the collection, so say what did land.
      error:
        counts.wishlisted > 0
          ? "That collection changed under you, so those cards are on your wishlist but were not added " +
            "to this list. Reload to see what changed."
          : "That collection changed under you, so those cards were not added to this list. Reload to " +
            "see what changed.",
    };
  }
  return { ok: true, ...counts };
}
