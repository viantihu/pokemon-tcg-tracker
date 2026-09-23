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
 *   - owned nowhere: the caller inserts, as before.
 *
 * `role = 'block'` is excluded from "owned", and is the ONLY exclusion: it marks a slot no card can ever
 * fill, not a physical card she holds (system-design §4). It was not always the only one — the filter used
 * to name the roles that counted, which silently dropped the haul when UIL-088 added it, and that is the
 * regression UIL-093 fixes.
 *
 * ONE TRANSACTION (UIL-033). The write is a single `apply_write_ops` call — `insert_copy` +
 * `insert_decision` when she owns none, and the chase-list join as `union_collection_targets` (0007) —
 * the same op set the other three "join a collection" paths use (backfill, removal, the Line/Plan
 * move), instead of a fourth bespoke shape. The old shape was three awaited writes with a TypeScript
 * read-modify-write on `target_catalog_card_ids` in the middle, so two logs that interleaved lost one
 * tag, and a failure after the copy insert left a placed card on no list. The union happens server-side
 * in one statement, so concurrent logs compose; and a copy that cannot be inserted rolls the tag and
 * the audit row back with it.
 */

import { errorMessage } from "@/lib/errors";
import { isPlaced, type Role } from "@/lib/engine";
import { collectionTargetJoinOp } from "@/lib/line/move";
import {
  applyWriteOps,
  binderRepo,
  collectionRepo,
  colorBandRepo,
  copyRepo,
  type DbClient,
  type Row,
  type WriteOp,
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
  { ok: true; copyId: string; created: boolean } | { ok: false; error: string };

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
  let copyId: string;
  if (existing.kind === "here") {
    copyId = existing.copy.id;
  } else {
    // Client-generated id, so the audit row can reference the copy inside the same transaction.
    copyId = crypto.randomUUID();
    ops.push({
      op: "insert_copy",
      id: copyId,
      catalog_card_id: tcgdexId,
      variant: "normal",
      role: "shelved",
      binder_id: binderId,
      binder_half: null, // specialty binder is a single section
      color_band: null,
      acquired_at: new Date().toISOString(),
    });
    ops.push({
      op: "insert_decision",
      haul_id: null,
      copy_id: copyId,
      decision: "collection-log",
      reason: `Logged into ${col.name}`,
      resolved_by: "user",
    });
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
      error:
        "That collection changed under you, so the card was shelved in the binder but not added to " +
        "this list. Reload to see what changed, then move it from the binder view.",
    };
  }

  return { ok: true, copyId, created: existing.kind === "none" };
}
