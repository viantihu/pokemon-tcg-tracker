/**
 * I/O side of the UIL-050 guard: what is actually shelved in a binder right now, by section.
 *
 * `strandedSections` (lib/surfaces/capacity.ts) is the pure comparison; this is the one query it
 * needs and can't do itself. `copyRepo.listShelvedInSection` (UIL-055, #159) covers all three
 * buckets, including a specialty binder's one section (`half: null` — that binder stores no half at
 * all, read via `.is()` rather than `.eq()`, since `.eq(col, null)` compiles to `= NULL`, never true
 * in SQL). This used to carry its own local null-half query, duplicating that same read, from before
 * #159 had merged and made the shared one available; consolidated now that it has.
 */
import { copyRepo, type DbClient } from "@/lib/repo";

export interface ShelvedBySection {
  front: number;
  back: number;
  /** A specialty binder's one section, which stores no half at all. */
  single: number;
}

export async function readShelvedBySection(
  db: DbClient,
  binderId: string,
): Promise<ShelvedBySection> {
  const [front, back, single] = await Promise.all([
    copyRepo.listShelvedInSection(db, binderId, "front"),
    copyRepo.listShelvedInSection(db, binderId, "back"),
    copyRepo.listShelvedInSection(db, binderId, null),
  ]);
  return { front: front.length, back: back.length, single: single.length };
}
