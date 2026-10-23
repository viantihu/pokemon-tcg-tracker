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
import { catalogCardRepo, type DbClient, type Row } from "@/lib/repo";

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

/** A stand-in that may now be in the catalog, waiting for her to say which card it is. */
export interface UnsureStandIn {
  standIn: StandInCardView;
  candidates: StandInCardView[];
  /** Why a certain match was not swapped (the database refused it), in her words; absent when only unsure. */
  blocked?: string;
}

export interface StandInSwapReport {
  swapped: SwappedStandIn[];
  unsure: UnsureStandIn[];
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
 * swap the certain ones, report the unsure ones. A certain swap the database refuses (she already holds the real
 * card under the same variant) is reported as unsure with the reason, never thrown: the Sync screen still loads.
 */
export async function reconcileStandIns(
  db: DbClient,
  catalog: readonly CatalogRow[],
): Promise<StandInSwapReport> {
  const report: StandInSwapReport = { swapped: [], unsure: [] };
  const standIns = catalog.filter((r) => r.source === "user");
  if (standIns.length === 0) return report;

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
      report.unsure.push({
        standIn: cardView(s),
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
