/**
 * Card search for building a collection (UIL-039) — the testable core `actions.ts`'s `browseCards`
 * wraps (`getOwnerContext()` only), same seam as `applyCollectionSave`/`applyCollectionLog`.
 *
 * Deliberately separate from `catalogCardRepo.search`, the small type-ahead used by the single-pick
 * surfaces (Log a card, Backfill, Lookup) — this is a browse page meant to show dozens-to-hundreds of
 * results (an illustrator's whole output, a full set), paged rather than capped at 12.
 *
 * `filters.type` is a color-BAND key (she thinks in the ten bands, not raw TCGdex types) and is
 * expanded to the raw type strings that band covers before querying — White alone covers Colorless,
 * Metal, and every Trainer/Energy card.
 *
 * Owned/unowned filters IN MEMORY against the full owned-id set, rather than as a query filter —
 * folding hundreds of ids into a `.in()`/`.not.in()` filter puts all of them on the request URL,
 * the "fine at a handful, wrong at real scale" shape this app keeps finding elsewhere. That means one
 * *raw* catalog page does not always fill one *result* page, so this pulls additional raw pages
 * (bounded by `maxRawPages`) until the result page is full or the catalog runs out.
 */

import { catalogCardRepo, copyRepo, typeColorMapRepo, type DbClient, type Row } from "@/lib/repo";

export interface BrowseCoreFilters {
  text?: string;
  illustrator?: string;
  setId?: string;
  dexId?: number;
  /** A color-band key, not a raw TCGdex type — resolved via `type_color_map` before querying. */
  type?: string;
  owned?: "any" | "owned" | "unowned";
}

export interface BrowseCoreCard {
  tcgdexId: string;
  name: string;
  setId: string | null;
  setName: string | null;
  localId: string | null;
  /** Printed set total, for the full "099/182" form (UIL-077). */
  setCardCountOfficial: number | null;
  illustrator: string | null;
  types: string[];
  imageUrl: string | null;
  owned: boolean;
}

export interface BrowseCorePage {
  cards: BrowseCoreCard[];
  hasMore: boolean;
  nextOffset: number;
}

const PAGE_SIZE = 60;
/** Bound on raw catalog pages pulled in ONE call — a filter matching almost nothing (e.g.
 * "unowned" against a nearly-complete set) must not turn one page load into an unbounded scan of
 * the 23.5k-row catalog. */
const MAX_RAW_PAGES = 15;

function toBrowseCard(row: Row<"catalog_card">, owned: Set<string>): BrowseCoreCard {
  return {
    tcgdexId: row.tcgdex_id,
    name: row.name,
    setId: row.set_id,
    setName: row.set_name,
    localId: row.local_id,
    setCardCountOfficial: row.set_card_count_official,
    illustrator: row.illustrator,
    types: row.types ?? [],
    imageUrl: row.image_url,
    owned: owned.has(row.tcgdex_id),
  };
}

export async function applyCardBrowse(
  db: DbClient,
  filters: BrowseCoreFilters,
  offset: number,
): Promise<BrowseCorePage> {
  let types: string[] | undefined;
  if (filters.type) {
    const typeMap = await typeColorMapRepo.list(db);
    types = typeMap.filter((r) => r.band === filters.type).map((r) => r.card_type);
  }
  const repoFilters = {
    text: filters.text,
    illustrator: filters.illustrator,
    setId: filters.setId,
    dexId: filters.dexId,
    types,
  };

  const ownedFilter = filters.owned && filters.owned !== "any" ? filters.owned : null;
  const owned = await copyRepo.ownedCatalogCardIdSet(db);

  if (!ownedFilter) {
    const rows = await catalogCardRepo.browse(db, repoFilters, { limit: PAGE_SIZE, offset });
    return {
      cards: rows.map((r) => toBrowseCard(r, owned)),
      hasMore: rows.length === PAGE_SIZE,
      nextOffset: offset + rows.length,
    };
  }

  const matches: Row<"catalog_card">[] = [];
  let rawOffset = offset;
  let hitEnd = false;
  for (let page = 0; page < MAX_RAW_PAGES && matches.length < PAGE_SIZE; page++) {
    const rows = await catalogCardRepo.browse(db, repoFilters, {
      limit: PAGE_SIZE,
      offset: rawOffset,
    });
    rawOffset += rows.length;
    for (const r of rows) {
      const isOwned = owned.has(r.tcgdex_id);
      if ((ownedFilter === "owned") === isOwned) matches.push(r);
    }
    if (rows.length < PAGE_SIZE) {
      hitEnd = true;
      break;
    }
  }
  const page = matches.slice(0, PAGE_SIZE);
  return {
    cards: page.map((r) => toBrowseCard(r, owned)),
    hasMore: !hitEnd,
    nextOffset: rawOffset,
  };
}
