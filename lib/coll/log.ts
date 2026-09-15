/**
 * Logging a card into a collection must never create a second physical copy for one she already
 * owns (UIL-048). The old `logCardIntoCollection` inserted a `copy` row unconditionally, so logging a
 * card that already had a shelved copy in the collection's own binder doubled it — her reported case,
 * a card she owns exactly one of showing "Remove 2".
 *
 * Three outcomes, by where an existing copy (if any) already sits:
 *   - shelved in one of the collection's OWN binders: the "log" is a no-op repeat. The caller unions
 *     the target tag (idempotent even if already there) and inserts no copy.
 *   - owned anywhere else — shelved elsewhere, or sitting in the bulk box: refuse. Inserting here
 *     would create a second physical copy for a card she has exactly one of. Moving the existing one
 *     is her call, not this action's (UIL-043 is the designed follow-on: offering that move inline
 *     from the row).
 *   - owned nowhere: the caller inserts, as before.
 *
 * `role = 'block'` is excluded from "owned": it marks a slot no card can ever fill, not a physical
 * card she holds (system-design §4).
 */

import {
  binderRepo,
  collectionRepo,
  colorBandRepo,
  copyRepo,
  placementDecisionRepo,
  type DbClient,
  type Row,
} from "@/lib/repo";

export type ExistingCollectionCopy =
  { kind: "here"; copy: Row<"copy"> } | { kind: "elsewhere"; copy: Row<"copy"> } | { kind: "none" };

/** Where, if anywhere, she already holds a physical copy of this catalog card. */
export async function findExistingCopy(
  db: DbClient,
  tcgdexId: string,
  collectionBinderIds: string[],
): Promise<ExistingCollectionCopy> {
  const owned = (await copyRepo.listByCatalogCard(db, tcgdexId)).filter(
    (c) => c.role === "shelved" || c.role === "bulk",
  );
  if (owned.length === 0) return { kind: "none" };
  const here = owned.find((c) => c.binder_id !== null && collectionBinderIds.includes(c.binder_id));
  return here ? { kind: "here", copy: here } : { kind: "elsewhere", copy: owned[0] };
}

/** Human label for where an existing copy sits, for the refusal message. */
export async function describeExistingCopyLocation(
  db: DbClient,
  copy: Row<"copy">,
): Promise<string> {
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
  ownerId: string,
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
    const where = await describeExistingCopyLocation(db, existing.copy);
    return { ok: false, error: alreadyOwnedElsewhereMessage(where) };
  }

  let copyId: string;
  if (existing.kind === "here") {
    copyId = existing.copy.id;
  } else {
    const copy = await copyRepo.insert(db, {
      owner_id: ownerId,
      catalog_card_id: tcgdexId,
      variant: "normal",
      role: "shelved",
      binder_id: binderId,
      binder_half: null, // specialty binder is a single section
      color_band: null,
      acquired_at: new Date().toISOString(),
    });
    copyId = copy.id;
    await placementDecisionRepo.insert(db, {
      owner_id: ownerId,
      copy_id: copy.id,
      decision: "collection-log",
      reason: `Logged into ${col.name}`,
      resolved_by: "user",
    });
  }

  const targets = col.target_catalog_card_ids ?? [];
  if (!targets.includes(tcgdexId)) {
    await collectionRepo.update(db, collectionId, {
      target_catalog_card_ids: [...targets, tcgdexId],
    });
  }

  return { ok: true, copyId, created: existing.kind === "none" };
}
