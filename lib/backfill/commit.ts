/**
 * Backfill commit executors (dev-spec §5 M5; system-design §4, §7A).
 *
 * Each executor builds a pure `BackfillWrites` (see `plan.ts`) and applies it in FK-safe order,
 * stamping the seeded owner (service-role bypasses the `auth.uid()` default — see
 * `lib/plan/session.ts`). Reuses the M6 commit pattern: no cross-statement transaction exists in
 * supabase-js and the migrations dir is frozen, so on ANY failure a compensating rollback unwinds
 * the inserts in reverse before rethrowing — a failed backfill step leaves no half-written rows.
 * FLAGGED as the same seam as `lib/plan/commit.ts` (a Postgres RPC would make it truly atomic).
 */

import {
  binderBlockRepo,
  collectionRepo,
  copyRepo,
  evolutionLineRepo,
  lineSlotRepo,
  placementDecisionRepo,
  wishlistItemRepo,
  type DbClient,
} from "@/lib/repo";
import { loadBackfillContext, planDeps } from "./context";
import { planBackLine, planFrontHalf, planSpecialty } from "./plan";
import {
  countWrites,
  type BackfillWrites,
  type BackLineCommit,
  type CommitCounts,
  type FrontHalfCommit,
  type SpecialtyCommit,
} from "./types";

/** Undo stack for the compensating rollback (see file header). Run in reverse on failure. */
class Rollback {
  private steps: Array<() => Promise<void>> = [];
  add(step: () => Promise<void>) {
    this.steps.push(step);
  }
  async run() {
    for (const step of this.steps.reverse()) {
      try {
        await step();
      } catch {
        // Best-effort: keep unwinding even if one compensation fails.
      }
    }
  }
}

/**
 * Apply a write set in FK-safe order with a compensating rollback. `copy.line_slot_id` is deferred
 * (the copy is inserted NULL, then patched after its slot exists) because copy ↔ line_slot is a
 * circular FK.
 */
export async function applyWrites(db: DbClient, writes: BackfillWrites): Promise<CommitCounts> {
  const rb = new Rollback();
  try {
    if (writes.lines.length > 0) {
      await evolutionLineRepo.insertMany(db, writes.lines);
      for (const l of writes.lines) rb.add(() => evolutionLineRepo.remove(db, l.id!));
    }
    if (writes.copies.length > 0) {
      await copyRepo.insertMany(db, writes.copies);
      for (const c of writes.copies) rb.add(() => copyRepo.remove(db, c.id!));
    }
    if (writes.slots.length > 0) {
      await lineSlotRepo.insertMany(db, writes.slots);
      for (const s of writes.slots) rb.add(() => lineSlotRepo.remove(db, s.id!));
    }
    for (const link of writes.copyLineSlotLinks) {
      await copyRepo.update(db, link.copyId, { line_slot_id: link.slotId });
    }
    if (writes.blocks.length > 0) {
      await binderBlockRepo.insertMany(db, writes.blocks);
      for (const b of writes.blocks) rb.add(() => binderBlockRepo.remove(db, b.id!));
    }
    if (writes.wishlist.length > 0) {
      await wishlistItemRepo.insertMany(db, writes.wishlist);
      for (const wl of writes.wishlist) rb.add(() => wishlistItemRepo.remove(db, wl.id!));
    }
    if (writes.decisions.length > 0) {
      await placementDecisionRepo.insertMany(db, writes.decisions);
      for (const d of writes.decisions) rb.add(() => placementDecisionRepo.remove(db, d.id!));
    }

    // Collection tagging: union the tagged catalog ids into each collection's target list.
    const byCollection = new Map<string, string[]>();
    for (const t of writes.collectionTags) {
      const list = byCollection.get(t.collectionId) ?? [];
      list.push(t.catalogCardId);
      byCollection.set(t.collectionId, list);
    }
    for (const [collectionId, ids] of byCollection) {
      const coll = await collectionRepo.getByPk(db, collectionId);
      if (!coll) continue;
      const current = coll.target_catalog_card_ids ?? [];
      const merged = Array.from(new Set([...current, ...ids]));
      if (merged.length !== current.length) {
        await collectionRepo.update(db, collectionId, { target_catalog_card_ids: merged });
        rb.add(() =>
          collectionRepo
            .update(db, collectionId, { target_catalog_card_ids: current })
            .then(() => undefined),
        );
      }
    }

    return countWrites(writes);
  } catch (err) {
    await rb.run();
    throw err;
  }
}

/** Commit a front-half flat entry. */
export async function commitFrontHalf(
  db: DbClient,
  ownerId: string,
  input: FrontHalfCommit,
): Promise<CommitCounts> {
  const ctx = await loadBackfillContext(db);
  return applyWrites(db, planFrontHalf(input, planDeps(ctx, ownerId)));
}

/** Commit a back-half line entry. */
export async function commitBackLine(
  db: DbClient,
  ownerId: string,
  input: BackLineCommit,
): Promise<CommitCounts> {
  const ctx = await loadBackfillContext(db);
  return applyWrites(db, planBackLine(input, planDeps(ctx, ownerId)));
}

/** Commit a specialty flat entry (with collection tags). */
export async function commitSpecialty(
  db: DbClient,
  ownerId: string,
  input: SpecialtyCommit,
): Promise<CommitCounts> {
  const ctx = await loadBackfillContext(db);
  return applyWrites(db, planSpecialty(input, planDeps(ctx, ownerId)));
}
