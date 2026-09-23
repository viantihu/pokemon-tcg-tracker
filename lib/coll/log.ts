/**
 * Logging a card into a collection must never create a second physical copy for one she already
 * owns (UIL-048). The old `logCardIntoCollection` inserted a `copy` row unconditionally, so logging a
 * card that already had a shelved copy in the collection's own binder doubled it — her reported case,
 * a card she owns exactly one of showing "Remove 2".
 *
 * Three outcomes, by where an existing copy (if any) already sits:
 *   - shelved in one of the collection's OWN binders: the "log" is a no-op repeat. The caller unions
 *     the target tag (idempotent even if already there) and inserts no copy.
 *   - owned anywhere else — shelved elsewhere, sitting in the bulk box, or IN HER HAUL and not placed
 *     yet: refuse. Inserting here would create a second physical copy for a card she has exactly one of.
 *     Moving the existing one is her call, not this action's (UIL-043 is the designed follow-on: offering
 *     that move inline from the row). The haul case gets its own sentence, because the remedy is the Haul
 *     Plan rather than Move (UIL-093).
 *   - owned nowhere: goes on her WISHLIST and the collection's chase list — and creates NO copy (UIL-098).
 *     This used to insert a copy, i.e. inventory. Karvi: "Adding cards that I don't own to a collection should
 *     add them to the wishlist, not into inventory itself. This is a major data integrity issue." Dex is the
 *     source of truth for what she owns, and a copy made here belongs to no presence group, so the next
 *     import's reconcile cannot see it and creates a SECOND one when Dex lists the card — two records for
 *     one physical card, the duplicate UIL-089 had to learn to merge.
 *
 *     The wishlist row is the shape the Collections "Wishlist" button already writes
 *     (`wishlistCollectionCard`): no line slot, the collection's binder as `held_for_binder_id`, and
 *     `will_live_in_specialty`. A collection want is exactly what `wishlist_item.line_slot_id` was left
 *     nullable for, so no new table. It is what every "wishlisted?" reader already recognises — the hub's
 *     `wished` and Lookup's WISHLISTED fact both match an open row on `chosen_catalog_card_id`.
 *
 * `role = 'block'` is excluded from "owned", and is the ONLY exclusion: it marks a slot no card can ever
 * fill, not a physical card she holds (system-design §4). It was not always the only one — the filter used
 * to name the roles that counted, which silently dropped the haul when UIL-088 added it, and that is the
 * regression UIL-093 fixes.
 *
 * ONE TRANSACTION (UIL-033). The write is a single `apply_write_ops` call — the wishlist row when she owns
 * none, and the chase-list join as `union_collection_targets` (0007) —
 * the same op set the other three "join a collection" paths use (backfill, removal, the Line/Plan
 * move), instead of a fourth bespoke shape. The old shape was three awaited writes with a TypeScript
 * read-modify-write on `target_catalog_card_ids` in the middle, so two logs that interleaved lost one
 * tag, and a failure after the copy insert left a placed card on no list. The union happens server-side
 * in one statement, so concurrent logs compose, and a wishlist row that cannot be written takes the tag
 * back with it. (The copy insert and its audit row that used to ride in the same transaction are gone with
 * UIL-098: this path never creates a copy, and a wish is not a placement, so it writes no decision row.)
 */

import { errorMessage } from "@/lib/errors";
import { isPlaced, type Role } from "@/lib/engine";
import { collectionTargetJoinOp } from "@/lib/line/move";
import {
  applyWriteOps,
  binderRepo,
  catalogCardRepo,
  collectionRepo,
  colorBandRepo,
  copyRepo,
  type DbClient,
  type Row,
  type WriteOp,
  wishlistItemRepo,
} from "@/lib/repo";

export type ExistingCollectionCopy =
  { kind: "here"; copy: Row<"copy"> } | { kind: "elsewhere"; copy: Row<"copy"> } | { kind: "none" };

/**
 * Where, if anywhere, she already holds a physical copy of this catalog card.
 *
 * ASKED AS "NOT A BLOCK" (UIL-093). This filtered `role === "shelved" || role === "bulk"`, which stopped
 * meaning "anywhere" the moment UIL-088 gave an unplaced card its own role: a card sitting in her haul
 * came back as `kind: "none"`, so logging it into a collection INSERTED A SECOND COPY of a card she
 * already owned — the duplicate this function exists to refuse. `block` is the only role excluded, and
 * for the one reason that it is not a card at all (system-design §4).
 */
export async function findExistingCopy(
  db: DbClient,
  tcgdexId: string,
  collectionBinderIds: string[],
): Promise<ExistingCollectionCopy> {
  const owned = (await copyRepo.listByCatalogCard(db, tcgdexId)).filter((c) => c.role !== "block");
  if (owned.length === 0) return { kind: "none" };
  const here = owned.find((c) => c.binder_id !== null && collectionBinderIds.includes(c.binder_id));
  return here ? { kind: "here", copy: here } : { kind: "elsewhere", copy: owned[0] };
}

/** Human label for where an existing copy sits, for the refusal message. */
export async function describeExistingCopyLocation(
  db: DbClient,
  copy: Row<"copy">,
): Promise<string> {
  // A card in the haul is not in the bulk box (UIL-093): the box is somewhere she chose, and this card
  // has not been put anywhere. It reaches its own message below rather than this one, but the branch is
  // here too so no caller of this exported helper can name a placement she never made.
  if (!isPlaced(copy.role as Role)) return "your haul, waiting to be placed";
  if (copy.role === "bulk" || !copy.binder_id) return "the bulk box";
  const binder = await binderRepo.getByPk(db, copy.binder_id);
  const binderName = binder?.name ?? "a binder";
  if (!copy.color_band) return binderName; // a specialty binder has no half or band
  const half = copy.binder_half === "front" ? "Front" : "Back";
  const bands = await colorBandRepo.listOrdered(db);
  const bandDisplay =
    bands.find((b) => b.band === copy.color_band)?.display_name ?? copy.color_band;
  return `${binderName} · ${half} · ${bandDisplay}`;
}

/** The refusal shown when logging would create a second copy of a card she already owns elsewhere. */
export function alreadyOwnedElsewhereMessage(location: string): string {
  return `You already own this — it's in ${location}. Use Move to bring it here.`;
}

/**
 * The refusal for a card she owns but has NOT placed yet (UIL-093).
 *
 * Its own sentence, because the remedy is different. "Use Move to bring it here" answers "your card is
 * somewhere else"; this card is nowhere yet, and the place it gets put somewhere is the Haul Plan. Saying
 * Move would send her to the wrong screen for a card the app has never filed.
 */
export const ALREADY_OWNED_IN_HAUL_MESSAGE =
  "You already own this card; it is in your haul, waiting to be placed.";

export type LogCardOutcome =
  | {
      ok: true;
      /** The copy already in this collection's binder; null when the card went on her wishlist instead. */
      copyId: string | null;
      /** Always false since UIL-098 — this path never creates a copy. Kept so the outcome's shape holds. */
      created: false;
      /** True when she does not own the card, so it went on her wishlist (UIL-098). */
      wishlisted: boolean;
    }
  | { ok: false; error: string };

/**
 * The testable core of "log a card into a collection" — a PLACEMENT, not a tally. `created` is false
 * when the log was a no-op repeat onto a copy already shelved here (union the tag, insert nothing);
 * `actions.ts`'s `logCardIntoCollection` is a thin `getOwnerContext()` wrapper around this, same seam
 * as `applyCollectionRemoval`.
 */
export async function applyCollectionLog(
  db: DbClient,
  // Kept for the call signature; the RPC is SECURITY INVOKER and owner_id defaults to auth.uid().
  _ownerId: string,
  collectionId: string,
  tcgdexId: string,
): Promise<LogCardOutcome> {
  const col = await collectionRepo.getByPk(db, collectionId);
  if (!col) return { ok: false, error: "Collection not found." };
  const binderIds = col.current_binder_ids ?? [];
  const binderId = binderIds[0];
  if (!binderId) return { ok: false, error: "This collection has no binder yet." };

  const existing = await findExistingCopy(db, tcgdexId, binderIds);
  if (existing.kind === "elsewhere") {
    // Asked through `isPlaced`, the one bridge between her word SHELVED and the column's (UIL-088), so
    // "has this card been put anywhere" is answered in exactly one place.
    if (!isPlaced(existing.copy.role as Role)) {
      return { ok: false, error: ALREADY_OWNED_IN_HAUL_MESSAGE };
    }
    const where = await describeExistingCopyLocation(db, existing.copy);
    return { ok: false, error: alreadyOwnedElsewhereMessage(where) };
  }

  const ops: WriteOp[] = [];
  let copyId: string | null = null;
  if (existing.kind === "here") {
    // Already shelved in this collection's binder: a repeat that unions the tag and writes nothing else.
    copyId = existing.copy.id;
  } else {
    // Owned nowhere: a WISH, never inventory (UIL-098 — see the header). The row the Collections "Wishlist"
    // button already writes, so both ways of wanting a collection card are one shape.
    const card = await catalogCardRepo.getByPk(db, tcgdexId);
    if (!card) return { ok: false, error: "That card is not in the catalog." };
    // Idempotent: a card she is already chasing is not wished for twice. Read-then-write, not server-side —
    // the one open-row uniqueness the schema enforces (0021) is per line SLOT, and a collection want has none.
    // A race between two adds of the same card could leave two wish rows for it; both read as one "wished",
    // so the cost of that race is a duplicate row, never a wrong answer.
    const open = await wishlistItemRepo.listOpen(db);
    if (!open.some((w) => w.chosen_catalog_card_id === tcgdexId)) {
      ops.push({
        op: "insert_wishlist",
        line_slot_id: null,
        required_dex_id: card.dex_id?.[0] ?? null,
        required_type: card.types?.[0] ?? null,
        required_stage: card.stage,
        chosen_catalog_card_id: tcgdexId,
        alternate_catalog_card_ids: [],
        held_for_binder_id: binderId,
        will_live_in_specialty: true,
      });
    }
  }

  // The chase-list join, the same op every other "into a collection" path emits (UIL-022/UIL-033):
  // unioned server-side, idempotent when the id is already there.
  const join = collectionTargetJoinOp({ kind: "collection", binderId, collectionId }, tcgdexId);
  if (join) ops.push(join);

  try {
    await applyWriteOps(db, { ops });
  } catch (err) {
    return { ok: false, error: `Could not log the card: ${errorMessage(err)}` };
  }

  // `union_collection_targets` matches no row for a collection that vanished (or stopped being hers)
  // between the read above and the write — and says nothing. Do not let that pass as success: the copy
  // is now shelved in the binder, but on no collection's list, which is exactly the orphan UIL-014 is
  // about. Name it, so she can put it right, instead of returning ok with nothing tagged.
  const after = await collectionRepo.getByPk(db, collectionId);
  if (!after || !(after.target_catalog_card_ids ?? []).includes(tcgdexId)) {
    return {
      ok: false,
      // Said per case, because what did land differs: an owned card was already in the binder; a wished
      // one is on her wishlist (that row does not depend on the collection) but on no collection's list.
      error:
        existing.kind === "here"
          ? "That collection changed under you, so the card is in the binder but was not added to this " +
            "list. Reload to see what changed, then move it from the binder view."
          : "That collection changed under you, so the card is on your wishlist but was not added to " +
            "this list. Reload to see what changed.",
    };
  }

  return { ok: true, copyId, created: false, wishlisted: existing.kind === "none" };
}
