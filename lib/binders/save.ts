/**
 * I/O side of the UIL-050 guard: what is actually shelved in a binder right now, by section.
 *
 * `strandedSections` (lib/surfaces/capacity.ts) is the pure comparison; this is the one query it
 * needs and can't do itself. `copyRepo.listShelvedInSection` covers front/back; a specialty binder's
 * one section stores no half at all (`binder_half is null`), which needs `.is()` rather than `.eq()`
 * — `.eq(col, null)` compiles to `= NULL`, which is never true in SQL — so that bucket is read
 * directly here rather than overloading the front/back finder for a third, differently-shaped case.
 */
import { copyRepo, type DbClient, type Row } from "@/lib/repo";

export interface ShelvedBySection {
  front: number;
  back: number;
  /** A specialty binder's one section, which stores no half at all. */
  single: number;
}

async function listShelvedWithNoHalf(db: DbClient, binderId: string): Promise<Row<"copy">[]> {
  const { data, error } = await db
    .from("copy")
    .select("*")
    .eq("role", "shelved")
    .eq("binder_id", binderId)
    .is("binder_half", null);
  if (error) throw error;
  return data ?? [];
}

export async function readShelvedBySection(
  db: DbClient,
  binderId: string,
): Promise<ShelvedBySection> {
  const [front, back, single] = await Promise.all([
    copyRepo.listShelvedInSection(db, binderId, "front"),
    copyRepo.listShelvedInSection(db, binderId, "back"),
    listShelvedWithNoHalf(db, binderId),
  ]);
  return { front: front.length, back: back.length, single: single.length };
}
