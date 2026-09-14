/**
 * Catalog mirror (docs/dev-spec.md §5 M2; docs/system-design.md §9).
 *
 * Paginated fetch of the TCGdex catalog → idempotent upsert into `catalog_card`. Safe to re-run:
 * the upsert keys on `tcgdex_id` and rows are de-duplicated per batch (Postgres rejects touching a
 * conflict key twice in one statement). ids/localIds are stored EXACTLY as returned. Meant to run
 * on a schedule and on a new set release (sync one set via `syncSet`).
 *
 * Writes land as the SERVICE ROLE (catalog_card is read-only to the app under RLS) — the caller
 * passes the admin client (lib/supabase/admin.ts). This module itself is pure of that concern.
 *
 * cardClass is derived here (classify.ts); `is_digital_only` is set from the set's series
 * (`tcgp` == Pokémon TCG Pocket), which downstream excludes. Artwork hashing/grouping is a
 * separate, heavier pass (`regroupArtwork`) so the metadata mirror stays fast.
 */
import type { DbClient, Insert } from "@/lib/repo";
import { catalogCardRepo } from "@/lib/repo";
import type { Locale } from "@/lib/sync/types";
import { classifyCard } from "./classify";
import { clusterArtwork, hashArtworkPng, type ArtworkEntry } from "./artwork";
import type { TcgdexCardFull, TcgdexClient } from "./tcgdex";

/** The TCGdex series id for the digital-only Pokémon TCG Pocket cards. */
const TCG_POCKET_SERIE_ID = "tcgp";

type CatalogInsert = Insert<"catalog_card">;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Best-effort price extraction from a TCGdex card's nested pricing. Prices are volatile, so this is
 * a snapshot for the alternates ranking (system-design §6), never asserted exactly in tests.
 *   priceLow    — lowest TCGplayer `lowPrice` across variants, else Cardmarket `low`.
 *   priceMarket — a representative TCGplayer `marketPrice` (prefer normal → holofoil → reverse),
 *                 else Cardmarket `trend` / `avg`.
 */
export function extractPrices(pricing: TcgdexCardFull["pricing"]): {
  priceLow: number | null;
  priceMarket: number | null;
} {
  if (!pricing) return { priceLow: null, priceMarket: null };

  let priceLow: number | null = null;
  let priceMarket: number | null = null;

  const tp = pricing.tcgplayer as Record<string, unknown> | null | undefined;
  if (tp) {
    const order = ["normal", "holofoil", "reverse-holofoil"];
    const keys = [
      ...order.filter((k) => k in tp),
      ...Object.keys(tp).filter((k) => k !== "unit" && k !== "updated" && !order.includes(k)),
    ];
    for (const k of keys) {
      const sub = tp[k] as Record<string, unknown> | undefined;
      if (!sub || typeof sub !== "object") continue;
      const low = num(sub.lowPrice);
      if (low != null) priceLow = priceLow == null ? low : Math.min(priceLow, low);
      if (priceMarket == null) priceMarket = num(sub.marketPrice);
    }
  }

  const cm = pricing.cardmarket as Record<string, unknown> | null | undefined;
  if (cm) {
    if (priceLow == null) priceLow = num(cm.low);
    if (priceMarket == null) priceMarket = num(cm.trend) ?? num(cm.avg);
  }

  return { priceLow, priceMarket };
}

/**
 * Map one full TCGdex card to a `catalog_card` insert row. ids/localId stored verbatim;
 * `evolveFrom` "None" → null (basics); series comes from the set resource (the card's embedded
 * `set` has no `serie`). Does NOT set artwork fields — that is `regroupArtwork`'s job.
 *
 * `setCardCountOfficial` and `setReleaseDate` (UIL-026) come from `opts`, not from `card.set`: the
 * card's embedded `set` object carries `cardCount` but NOT `releaseDate`, so both are read once off the
 * set resource in `syncSet` and threaded through here — the same reason `setSeries` is. Do not
 * "simplify" either to `card.set`, or the date silently becomes NULL on every row.
 */
export function toCatalogRow(
  card: TcgdexCardFull,
  opts: {
    isDigitalOnly: boolean;
    setSeries?: string | null;
    setCardCountOfficial?: number | null;
    setReleaseDate?: string | null;
  },
): CatalogInsert {
  const { priceLow, priceMarket } = extractPrices(card.pricing);
  const evolveFrom = card.evolveFrom && card.evolveFrom !== "None" ? card.evolveFrom : null;
  return {
    tcgdex_id: card.id,
    name: card.name,
    dex_id: card.dexId ?? [],
    set_id: card.set?.id ?? null,
    set_name: card.set?.name ?? null,
    set_series: opts.setSeries ?? null,
    local_id: card.localId ?? null,
    rarity: card.rarity ?? null,
    types: card.types ?? [],
    stage: card.stage ?? null,
    evolve_from: evolveFrom,
    illustrator: card.illustrator ?? null,
    hp: num(card.hp),
    variants: (card.variants ?? {}) as CatalogInsert["variants"],
    card_class: classifyCard(card),
    is_digital_only: opts.isDigitalOnly,
    image_url: card.image ?? null,
    price_low: priceLow,
    price_market: priceMarket,
    set_card_count_official: opts.setCardCountOfficial ?? null,
    set_release_date: opts.setReleaseDate ?? null,
  };
}

/** Keep the last row per `tcgdex_id` — required before an upsert (see catalogCardRepo.upsertMany). */
export function dedupeById(rows: CatalogInsert[]): CatalogInsert[] {
  const byId = new Map<string, CatalogInsert>();
  for (const r of rows) byId.set(r.tcgdex_id, r);
  return [...byId.values()];
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Run `task` over `items` with bounded concurrency, preserving input order in the result. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), items.length || 1) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await task(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

export interface SyncOptions {
  locale?: Locale;
  /** Concurrent full-card fetches per set. */
  concurrency?: number;
  /** Rows per upsert statement. */
  batchSize?: number;
  onProgress?: (message: string) => void;
}

export interface SetSyncResult {
  setId: string;
  setName: string;
  isDigitalOnly: boolean;
  fetched: number;
  upserted: number;
}

/** Mirror a single set — the "on new set release" path. Idempotent. */
export async function syncSet(
  db: DbClient,
  tcgdex: TcgdexClient,
  setId: string,
  opts: SyncOptions = {},
): Promise<SetSyncResult> {
  const set = await tcgdex.getSet(setId, opts.locale);
  const isDigitalOnly = set.serie?.id === TCG_POCKET_SERIE_ID;
  const setSeries = set.serie?.name ?? null;
  // Read once off the set resource (UIL-026): the per-card embedded `set` has cardCount but no
  // releaseDate, so both are threaded through toCatalogRow rather than read from the card.
  const setCardCountOfficial = set.cardCount?.official ?? null;
  const setReleaseDate = set.releaseDate ?? null;
  const briefs = set.cards ?? [];

  const fulls = await mapLimit(briefs, opts.concurrency ?? 8, (b) =>
    tcgdex.getCard(b.id, opts.locale),
  );
  const rows = dedupeById(
    fulls.map((c) =>
      toCatalogRow(c, { isDigitalOnly, setSeries, setCardCountOfficial, setReleaseDate }),
    ),
  );

  let upserted = 0;
  for (const batch of chunk(rows, opts.batchSize ?? 500)) {
    await catalogCardRepo.upsertMany(db, batch);
    upserted += batch.length;
  }
  opts.onProgress?.(`${set.id} (${set.name}): ${upserted} cards`);
  return { setId: set.id, setName: set.name, isDigitalOnly, fetched: fulls.length, upserted };
}

export interface FullSyncOptions extends SyncOptions {
  /** Restrict which sets to mirror (e.g. only sets newer than the last sync). */
  setFilter?: (set: { id: string; name: string; releaseDate?: string }) => boolean;
}

export interface FullSyncResult {
  sets: number;
  cards: number;
  details: SetSyncResult[];
}

/** Mirror the whole catalog, set by set (scheduled refresh). Idempotent. */
export async function syncAll(
  db: DbClient,
  tcgdex: TcgdexClient,
  opts: FullSyncOptions = {},
): Promise<FullSyncResult> {
  const allSets = await tcgdex.listSets(opts.locale);
  const sets = opts.setFilter ? allSets.filter((s) => opts.setFilter!(s)) : allSets;

  const details: SetSyncResult[] = [];
  let cards = 0;
  for (const s of sets) {
    const r = await syncSet(db, tcgdex, s.id, opts);
    details.push(r);
    cards += r.upserted;
  }
  return { sets: sets.length, cards, details };
}

// ---------------------------------------------------------------------------
// Artwork pass — perceptual-hash + cluster into artwork_group_id (system-design §10).
// Heavier (downloads images), so it is separate from the metadata mirror above.
// ---------------------------------------------------------------------------

/** Computes a card's raw artwork hash, or null when it can't (no image / fetch failure). */
export type ArtworkHasher = (card: {
  tcgdex_id: string;
  image_url: string | null;
}) => Promise<string | null>;

/** Default hasher: fetch the low-res PNG (`<image>/low.png`) and dHash its artwork region. */
export function defaultArtworkHasher(fetchImpl: typeof fetch = fetch): ArtworkHasher {
  return async ({ image_url }) => {
    if (!image_url) return null;
    const res = await fetchImpl(`${image_url}/low.png`);
    if (!res.ok) return null;
    return hashArtworkPng(new Uint8Array(await res.arrayBuffer()));
  };
}

export interface RegroupOptions {
  hasher?: ArtworkHasher;
  threshold?: number;
  concurrency?: number;
}

export interface RegroupResult {
  hashed: number;
  regrouped: number;
}

/**
 * Recompute artwork hashes for rows missing one, then re-cluster into `artwork_group_id`. Locked
 * rows (manual merge/split) keep their group. Persists the raw hash so a future re-cluster (tuned
 * threshold) needs no re-download.
 */
export async function regroupArtwork(
  db: DbClient,
  { hasher, threshold, concurrency = 8 }: RegroupOptions = {},
): Promise<RegroupResult> {
  const rows = await catalogCardRepo.listAll(db);

  // 1. Fill missing hashes (skip digital-only + already-hashed + locked-without-hash-needs).
  const needHash = hasher
    ? rows.filter((r) => r.artwork_hash == null && !r.is_digital_only && r.image_url)
    : [];
  const computed = await mapLimit(needHash, concurrency, async (r) => ({
    id: r.tcgdex_id,
    hash: await hasher!({ tcgdex_id: r.tcgdex_id, image_url: r.image_url }),
  }));
  const newHash = new Map(
    computed.filter((c) => c.hash != null).map((c) => [c.id, c.hash!] as const),
  );

  for (const [id, hash] of newHash) {
    await catalogCardRepo.update(db, id, { artwork_hash: hash });
  }

  // 2. Cluster over all known hashes; locked rows pin their group.
  const entries: ArtworkEntry[] = rows.map((r) => ({
    id: r.tcgdex_id,
    hash: newHash.get(r.tcgdex_id) ?? r.artwork_hash,
    lockedGroupId: r.artwork_group_locked ? r.artwork_group_id : null,
  }));
  const groups = clusterArtwork(entries, threshold == null ? {} : { threshold });

  let regrouped = 0;
  for (const r of rows) {
    if (r.artwork_group_locked) continue;
    const g = groups.get(r.tcgdex_id) ?? null;
    if (g !== r.artwork_group_id) {
      await catalogCardRepo.update(db, r.tcgdex_id, { artwork_group_id: g });
      regrouped++;
    }
  }
  return { hashed: newHash.size, regrouped };
}
