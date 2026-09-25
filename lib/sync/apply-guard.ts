/**
 * One preview, applied once (UIL-099 E5).
 *
 * The sync bundle round-trips through the browser: the preview hands it to the client, and "Apply" sends it
 * back. Nothing on the server checked that the state it was computed against was still the state it was
 * applied to, so two tabs, a double click, or a retry after a lost response applied the same `creates`
 * twice — every card in the import, doubled. Her first import after the Testing wipe is ~700 cards.
 *
 * THE FRESHNESS KEY IS THE UNDO SNAPSHOT. Every apply writes exactly one `last_sync_snapshot` and deletes
 * the ones before it, so the latest snapshot's id names "the sync state this collection is in". The preview
 * records it (`bundle.baseSnapshotId`), and the apply refuses unless it is still the latest. That catches a
 * stale bundle at any depth — a second tab, a retry, a bundle from two imports ago. Copy counts per presence
 * key would catch the same staleness, but only for the keys a plan happens to touch, and they would have to
 * be re-read and compared per key; one id says it for the whole collection.
 *
 * THE RACE IS CLOSED BY A PRIMARY KEY, not by that read. Two applies of one base that start at the same
 * moment both read "still the latest" before either writes. So the new snapshot's id is not random: it is
 * DERIVED from the base (and the owner). Both racing applies insert the SAME id, Postgres serialises the two
 * inserts on the primary key, and the second one fails inside its own transaction — nothing it wrote
 * survives. That is the in-transaction check the fix needed, and it needs no migration: the snapshot table's
 * primary key has always been there. (The loser may trip another unique key first — a presence group the
 * winner just created — which rolls it back just the same; `executeApply` then tells the two cases apart by
 * asking the database whether this base's snapshot now exists, not by parsing the error.)
 *
 * UNDO LEAVES A TOMBSTONE, NOT NOTHING (the Tech Lead's B1). Every apply deletes the snapshots before it, so
 * if Undo simply deleted the one left, the collection would have no snapshot at all — freshness key null,
 * the SAME value as "never synced". A stale tab holding a preview from before her first import would then
 * pass the check and apply on top of the import it was superseded by: import A, import B, undo B, stale A
 * lands again, ~700 cards doubled. So Undo replaces the snapshot it consumes with a tombstone whose id is
 * derived from it (`undo:<id>`). The tombstone is the new base: a fresh preview after an undo records it and
 * applies normally; a stale null-base preview is refused. The next apply deletes the tombstone like any
 * prior snapshot. A tombstone cannot itself be undone, and because its id is derived, a double-clicked Undo
 * collides on it the way a double-clicked Apply collides on a snapshot.
 *
 * "ALREADY APPLIED" IS CLAIMED ONLY WHEN IT IS TRUE (the Tech Lead's M1). Two different files previewed from
 * one base derive the same snapshot id, so the primary key alone cannot say WHICH landed. Each snapshot
 * stores a digest of the plan it applied; a refused bundle is told "already applied" only when its own
 * digest matches, and "stale — import the file again" otherwise. The key still decides the race; the digest
 * only chooses the sentence.
 */
import { createHash } from "node:crypto";

/** Thrown when this exact base has already been applied — nearly always this same preview, again. */
export class SyncAlreadyAppliedError extends Error {
  constructor() {
    super("This import has already been applied. Nothing was added twice.");
    this.name = "SyncAlreadyAppliedError";
  }
}

/** Thrown when the collection has moved on since the preview — another import or an undo landed. */
export class SyncStaleError extends Error {
  constructor() {
    super(
      "Your collection changed since this preview, so it was not applied. Import the file again to see " +
        "what it would do now.",
    );
    this.name = "SyncStaleError";
  }
}

/**
 * The snapshot id an apply of this base writes. Deterministic, so two applies of one base collide on the
 * primary key; a v5-shaped uuid, because the column is a uuid.
 *
 * The OWNER is part of the key only for the no-snapshot-yet case. A real base id is already unique across
 * owners, but "no snapshot" is not — without the owner, two different owners' first imports would derive the
 * same id and the second would be refused as a duplicate of the first.
 */
export function snapshotIdForBase(baseSnapshotId: string | null, ownerScope: string): string {
  return derivedUuid(baseSnapshotId ? `base:${baseSnapshotId}` : `none:${ownerScope}`);
}

/**
 * A v5-shaped uuid from a seed — deterministic, so two writers of one seed collide on a primary key. Also
 * the copy ids of a manual match and of its "add it back" (lib/sync/exec.ts), for the same reason.
 */
export function derivedUuid(seed: string): string {
  const h = createHash("sha1").update(`binderops.sync.apply:${seed}`).digest();
  h[6] = (h[6] & 0x0f) | 0x50; // version 5
  h[8] = (h[8] & 0x3f) | 0x80; // RFC 4122 variant
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** The snapshot row shape the guard reads. */
export interface SnapshotRow {
  id: string;
  created_at: string;
  snapshot: unknown;
}

/** The latest snapshot row, or null when she has never synced. */
export function latestSnapshot<T extends { created_at: string }>(rows: readonly T[]): T | null {
  if (rows.length === 0) return null;
  return [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
}

/** The latest snapshot's id, or null when she has never synced. A tombstone counts: it is a real base. */
export function latestSnapshotId(
  rows: readonly { id: string; created_at: string }[],
): string | null {
  return latestSnapshot(rows)?.id ?? null;
}

/** The payload Undo leaves in place of the snapshot it consumed. */
export interface SnapshotTombstone {
  version: 1;
  tombstone: true;
  /** The snapshot this undo consumed — kept so the tombstone says what it replaced. */
  undoneSnapshotId: string;
  createdAt: string;
}

export function isTombstone(snapshot: unknown): boolean {
  return !!snapshot && (snapshot as { tombstone?: unknown }).tombstone === true;
}

/**
 * The snapshot an Undo would consume, or null when there is nothing to undo — no sync yet, or the latest is a
 * tombstone (that sync was already undone). One definition, read by both `executeUndo` and the Sync screen's
 * "Undo available", so the button can never offer an undo the action would refuse.
 */
export function undoableSnapshot<T extends { created_at: string; snapshot: unknown }>(
  rows: readonly T[],
): T | null {
  const latest = latestSnapshot(rows);
  return latest && !isTombstone(latest.snapshot) ? latest : null;
}

/** The id of the tombstone Undo writes for `undoneSnapshotId` — derived, so a second Undo collides on it. */
export function tombstoneIdFor(undoneSnapshotId: string): string {
  return derivedUuid(`undo:${undoneSnapshotId}`);
}

/**
 * A digest of what a bundle would apply — the one fact that tells "this same preview, again" from "a
 * different file previewed from the same state". Hashes the plan and the queue as the pipeline built them,
 * which is deterministic for one file against one state, so two previews of one export digest the same.
 */
export function planDigest(bundle: {
  plan: { creates: unknown; retires: unknown; variantUpdates: unknown; flagFixes?: unknown[] };
  queue: { parks: unknown; archiveEntryIds: unknown; dropEntryIds: unknown };
}): string {
  const body = JSON.stringify([
    bundle.plan.creates,
    bundle.plan.retires,
    bundle.plan.variantUpdates,
    bundle.queue.parks,
    bundle.queue.archiveEntryIds,
    bundle.queue.dropEntryIds,
    // UIL-102's flag fixes, only when there are any: a plan without them digests exactly as it did before,
    // so a snapshot written before this change is still recognised as "this same preview".
    ...(bundle.plan.flagFixes?.length ? [bundle.plan.flagFixes] : []),
  ]);
  return createHash("sha256").update(body).digest("hex");
}

/**
 * The refusal for a bundle whose derived snapshot has ALREADY landed: "already applied" only if what landed
 * is this very plan. Otherwise the collection moved on under a different file, and saying it was applied
 * would tell her a newer export is in when it is not.
 */
function refusalForLanded(landed: SnapshotRow, digest: string): Error {
  const landedDigest = (landed.snapshot as { planDigest?: string } | null)?.planDigest;
  return landedDigest === digest ? new SyncAlreadyAppliedError() : new SyncStaleError();
}

/**
 * Refuse, before any write, a bundle whose base is no longer the collection's sync state.
 *
 * Order matters: a bundle whose derived snapshot is the latest is checked first, because a replay of the
 * apply that just landed is also, technically, stale — and "already applied" is the true answer there.
 */
export function assertFreshBase(
  bundleBaseSnapshotId: string | null,
  latest: SnapshotRow | null,
  ownerScope: string,
  digest: string,
): void {
  if (latest && latest.id === snapshotIdForBase(bundleBaseSnapshotId, ownerScope)) {
    throw refusalForLanded(latest, digest);
  }
  if ((latest?.id ?? null) !== bundleBaseSnapshotId) throw new SyncStaleError();
}

/**
 * After a failed write: did a racing apply of THIS base commit first? Asked of the database, because which
 * constraint the loser trips first depends on the plan. Returns the refusal to throw, or null to rethrow.
 */
export function refusalAfterRace(
  latest: SnapshotRow | null,
  derivedSnapshotId: string,
  digest: string,
): Error | null {
  return latest && latest.id === derivedSnapshotId ? refusalForLanded(latest, digest) : null;
}
