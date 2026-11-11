/**
 * UIL-060 Half 2: her stand-ins, swapped for the real cards once TCGdex carries them.
 *
 * Karvi (2026-10-22): swap on its own only when the match is certain; anything less, ask her first. Which real card
 * a stand-in is, and how sure that is, is `standInMatch` (lib/catalog/stand-in.ts). The swap itself is one RPC
 * (0039 `swap_stand_in`): every reference repointed and the stand-in deleted, or nothing at all.
 *
 * Run when the Sync screen loads, after each catalog refresh has had the chance to bring the real card in. A swap
 * removes the stand-in, so the next load finds nothing to do for it: running this again is safe.
 */
import { standInMatch, type MatchableCard } from "@/lib/catalog/stand-in";
import {
  binderRepo,
  bulkUnitRepo,
  catalogCardRepo,
  colorBandRepo,
  copyRepo,
  type DbClient,
  type Row,
} from "@/lib/repo";
import { IN_THE_HAUL } from "@/lib/line/popup";

type CatalogRow = Readonly<Row<"catalog_card">>;

/** A card as the Sync screen names it. */
export interface StandInCardView {
  id: string;
  name: string;
  setName: string | null;
  localId: string | null;
  imageUrl: string | null;
}

/** A stand-in swapped for its real card on this load. */
export interface SwappedStandIn {
  standIn: StandInCardView;
  real: StandInCardView;
}

/**
 * What a decision about a stand-in touches: how many copies she holds under it, and where they are, in the words the
 * Line popup uses ("KB-001 · Front · Red", a bulk box, "Still in the haul"). Zero copies says the stand-in is not in
 * her collection at all.
 */
export interface StandInHeld {
  count: number;
  where: { label: string; count: number }[];
}

/** A stand-in that may now be in the catalog, waiting for her to say which card it is. */
export interface UnsureStandIn {
  standIn: StandInCardView;
  held: StandInHeld;
  candidates: StandInCardView[];
  /** Why a certain match was not swapped (the database refused it), in her words; absent when only unsure. */
  blocked?: string;
}

export interface StandInSwapReport {
  swapped: SwappedStandIn[];
  unsure: UnsureStandIn[];
  /** Stand-ins she chose to keep, not asked about again until a new candidate appears (0042). */
  kept: (StandInCardView & { held: StandInHeld })[];
}

function cardView(row: CatalogRow): StandInCardView {
  return {
    id: row.tcgdex_id,
    name: row.name,
    setName: row.set_name,
    localId: row.local_id,
    imageUrl: row.image_url,
  };
}

function matchable(row: CatalogRow): MatchableCard {
  return {
    tcgdexId: row.tcgdex_id,
    name: row.name,
    setId: row.set_id,
    setName: row.set_name,
    setCardCount: row.set_card_count_official,
    localId: row.local_id,
    locale: row.locale,
    isDigitalOnly: row.is_digital_only,
  };
}

function refusalMessage(err: unknown): string {
  const m = (err as { message?: unknown } | null)?.message;
  return typeof m === "string" && m ? m : "The swap failed. Reload and try again.";
}

/**
 * Look at every stand-in she has against `catalog` (the cached mirror plus her stand-ins, `loadCatalogCached`):
 * swap the certain ones, report the unsure ones. A real card she already holds under the same variant is merged, not
 * refused (0041). A certain swap the database still refuses is reported as unsure with the reason, never thrown: the
 * Sync screen still loads.
 */
export async function reconcileStandIns(
  db: DbClient,
  catalog: readonly CatalogRow[],
): Promise<StandInSwapReport> {
  const report: StandInSwapReport = { swapped: [], unsure: [], kept: [] };
  const standIns = catalog.filter((r) => r.source === "user");
  if (standIns.length === 0) return report;
  const heldOf = await heldReader(db);

  const mirrored = catalog.filter((r) => r.source !== "user");
  const byId = new Map(mirrored.map((r) => [r.tcgdex_id, r]));
  const pool = mirrored.map(matchable);

  for (const s of standIns) {
    const match = standInMatch(
      {
        tcgdexId: s.tcgdex_id,
        name: s.name,
        setId: s.set_id,
        setName: s.set_name,
        localId: s.local_id,
      },
      pool,
    );
    if (match.kind === "none") continue;
    if (match.kind === "unsure") {
      const keptIds = s.stand_in_kept_candidate_ids;
      // Kept: asked again only when a candidate she was not shown appears.
      if (keptIds && match.candidateIds.every((id) => keptIds.includes(id))) {
        report.kept.push({ ...cardView(s), held: await heldOf(s.tcgdex_id) });
        continue;
      }
      report.unsure.push({
        standIn: cardView(s),
        held: await heldOf(s.tcgdex_id),
        candidates: match.candidateIds.flatMap((id) => {
          const row = byId.get(id);
          return row ? [cardView(row)] : [];
        }),
      });
      continue;
    }
    const real = byId.get(match.realId);
    if (!real) continue;
    try {
      await catalogCardRepo.swapStandIn(db, s.tcgdex_id, real.tcgdex_id);
      report.swapped.push({ standIn: cardView(s), real: cardView(real) });
    } catch (err) {
      report.unsure.push({
        standIn: cardView(s),
        held: await heldOf(s.tcgdex_id),
        candidates: [cardView(real)],
        blocked: refusalMessage(err),
      });
    }
  }
  return report;
}

/** Her pick for an unsure stand-in: swap it for `realId`. Throws the database's refusal, in her words. */
export async function swapStandInFor(
  db: DbClient,
  standInId: string,
  realId: string,
): Promise<void> {
  try {
    await catalogCardRepo.swapStandIn(db, standInId, realId);
  } catch (err) {
    throw new Error(refusalMessage(err));
  }
}

/**
 * Where her copies of a card are, grouped. Reads the names once (binders, bands, boxes), then one query per stand-in
 * asked about: a handful, never her whole collection.
 */
async function heldReader(db: DbClient): Promise<(cardId: string) => Promise<StandInHeld>> {
  const [binders, bands, boxes] = await Promise.all([
    binderRepo.list(db),
    colorBandRepo.listOrdered(db),
    bulkUnitRepo.listOrdered(db),
  ]);
  const binderName = new Map(binders.map((b) => [b.id, b.name]));
  const bandName = new Map(bands.map((b) => [b.band, b.display_name]));
  const boxName = new Map(boxes.map((u) => [u.id, u.name]));
  const whereIs = (c: Row<"copy">): string => {
    if (c.role === "haul") return IN_THE_HAUL;
    if (c.role === "bulk" || !c.binder_id)
      return (c.bulk_unit_id && boxName.get(c.bulk_unit_id)) || "Bulk box";
    const half = c.binder_half === "back" ? "Back" : c.binder_half === "front" ? "Front" : null;
    return [
      binderName.get(c.binder_id) ?? "A binder",
      half,
      c.color_band ? (bandName.get(c.color_band) ?? c.color_band) : null,
    ]
      .filter(Boolean)
      .join(" · ");
  };
  return async (cardId) => {
    const copies = await copyRepo.listByCatalogCard(db, cardId);
    const byLabel = new Map<string, number>();
    for (const c of copies) byLabel.set(whereIs(c), (byLabel.get(whereIs(c)) ?? 0) + 1);
    return {
      count: copies.length,
      where: [...byLabel].map(([label, count]) => ({ label, count })),
    };
  };
}

/** Why fixing a stand-in is refused, in her words. */
export const FIX_STAND_IN_REFUSED = {
  empty: "A stand-in needs a name and a number.",
  twin: "You already have a stand-in with that name, set and number. Pick it from the list instead.",
} as const;

/**
 * Her correction of a stand-in she typed wrong: its name, set name and number. The set id is dropped when the set
 * name changes (it named the old set). A fixed stand-in is asked about afresh (its kept list is cleared), and the
 * Sync screen's next load matches it again — swapping it on its own if the fix makes the match certain.
 *
 * The stand-in's Pokémon data (species, type, stage) is unchanged: it decides which line the card belongs to, and a
 * name typo does not change the card in her hand.
 */
export async function fixStandIn(
  db: DbClient,
  standInId: string,
  fix: { name: string; setName: string; localId: string },
): Promise<void> {
  const name = fix.name.trim();
  const setName = fix.setName.trim();
  const localId = fix.localId.trim();
  if (!name || !localId) throw new Error(FIX_STAND_IN_REFUSED.empty);
  const current = (await catalogCardRepo.listStandIns(db)).find((r) => r.tcgdex_id === standInId);
  if (!current) {
    throw new Error("That stand-in is not in your catalog any more. Reload the Sync page.");
  }
  const sameSet = (current.set_name ?? "").trim() === setName;
  try {
    await catalogCardRepo.updateStandIn(db, standInId, {
      name,
      set_name: setName || null,
      local_id: localId,
      set_id: sameSet ? current.set_id : null,
      stand_in_kept_candidate_ids: null,
    });
  } catch (err) {
    // 0027's one-stand-in-per-card index.
    if ((err as { code?: string } | null)?.code === "23505")
      throw new Error(FIX_STAND_IN_REFUSED.twin);
    throw err;
  }
}

/** Keep a stand-in as it is: not asked about again until a candidate other than `candidateIds` appears (0042). */
export async function keepStandIn(
  db: DbClient,
  standInId: string,
  candidateIds: readonly string[],
): Promise<void> {
  await catalogCardRepo.updateStandIn(db, standInId, {
    stand_in_kept_candidate_ids: [...candidateIds],
  });
}

/** Ask about a kept stand-in again. */
export async function reviewStandInAgain(db: DbClient, standInId: string): Promise<void> {
  await catalogCardRepo.updateStandIn(db, standInId, { stand_in_kept_candidate_ids: null });
}
