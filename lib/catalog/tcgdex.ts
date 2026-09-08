/**
 * Typed TCGdex client (docs/dev-spec.md §5 M2; docs/system-design.md §9). No API key.
 *
 * Verified facts baked in (do NOT re-derive — dev-spec §0, sync-architecture appendix):
 *   * Base:            https://api.tcgdex.net/v2  (overridable via TCGDEX_BASE_URL / opts.baseUrl)
 *   * Full card:       GET /v2/<locale>/cards/<id>
 *   * Filtered brief:  GET /v2/<locale>/cards?name=... and the line-engine query
 *                      GET /v2/<locale>/cards?evolveFrom=<name>&types=<type>
 *   * Set (w/ cards):  GET /v2/<locale>/sets/<id>   — carries `serie` (id 'tcgp' == TCG Pocket)
 *   * All sets brief:  GET /v2/<locale>/sets
 *   * ids/localIds are stored EXACTLY as returned (padding varies by era). This client never
 *     normalizes them.
 *   * `image` is a base path (e.g. .../sv/sv03/027); append /<quality>.<ext> for a real image.
 *   * `evolveFrom` is the string "None" for basics — the mirror treats that as null.
 *
 * `fetch` is injected (defaults to global fetch) so the mirror and tests stay hermetic.
 */
import type { Locale } from "@/lib/sync/types";

export interface TcgdexVariants {
  firstEdition?: boolean;
  holo?: boolean;
  normal?: boolean;
  reverse?: boolean;
  wPromo?: boolean;
}

export interface TcgdexSerieRef {
  id: string;
  name?: string;
}

/** The `set` object embedded on a card (id + name only; `serie` lives on the set resource). */
export interface TcgdexCardSetRef {
  id: string;
  name?: string;
}

/** TCGplayer/Cardmarket pricing is deeply nested and optional; kept permissive on purpose. */
export type TcgdexPricing = {
  tcgplayer?: Record<string, unknown> | null;
  cardmarket?: Record<string, unknown> | null;
} | null;

/** A full card record (GET /cards/<id>). Only the fields the mirror consumes are typed. */
export interface TcgdexCardFull {
  id: string;
  localId: string;
  name: string;
  category?: string;
  image?: string;
  rarity?: string | null;
  stage?: string | null;
  evolveFrom?: string | null;
  illustrator?: string | null;
  hp?: number | null;
  types?: string[];
  dexId?: number[];
  variants?: TcgdexVariants;
  set?: TcgdexCardSetRef;
  pricing?: TcgdexPricing;
}

/** A brief card entry (from a filtered list or a set's `cards[]`). */
export interface TcgdexCardBrief {
  id: string;
  localId: string;
  name: string;
  image?: string;
}

/** A set resource (GET /sets/<id>) — includes its series and the brief card list. */
export interface TcgdexSet {
  id: string;
  name: string;
  serie?: TcgdexSerieRef;
  releaseDate?: string;
  cardCount?: { official?: number; total?: number };
  cards?: TcgdexCardBrief[];
}

/** A set as it appears in the all-sets list (no `cards[]`). */
export interface TcgdexSetBrief {
  id: string;
  name: string;
  serie?: TcgdexSerieRef;
  releaseDate?: string;
  cardCount?: { official?: number; total?: number };
}

/** Filters for the brief card list. `evolveFrom` + `types` is the verified line-engine query. */
export interface CardListQuery {
  name?: string;
  evolveFrom?: string;
  types?: string;
}

export interface TcgdexClient {
  getCard(id: string, locale?: Locale): Promise<TcgdexCardFull>;
  listCards(query: CardListQuery, locale?: Locale): Promise<TcgdexCardBrief[]>;
  getSet(id: string, locale?: Locale): Promise<TcgdexSet>;
  listSets(locale?: Locale): Promise<TcgdexSetBrief[]>;
}

export interface TcgdexClientOptions {
  baseUrl?: string;
  /** Injected fetch (defaults to the global). Kept as a param so the mirror + tests are hermetic. */
  fetchImpl?: typeof fetch;
  /** Default locale for calls that don't pass one. 'ja' resolves Japanese printings (sync-arch §1.3). */
  locale?: Locale;
}

const DEFAULT_BASE_URL = "https://api.tcgdex.net/v2";

export function createTcgdexClient(opts: TcgdexClientOptions = {}): TcgdexClient {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const defaultLocale: Locale = opts.locale ?? "en";

  async function getJson<T>(path: string): Promise<T> {
    const res = await doFetch(`${baseUrl}${path}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`TCGdex ${path} -> HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  function q(query: CardListQuery): string {
    const parts: string[] = [];
    if (query.name) parts.push(`name=${encodeURIComponent(query.name)}`);
    if (query.evolveFrom) parts.push(`evolveFrom=${encodeURIComponent(query.evolveFrom)}`);
    if (query.types) parts.push(`types=${encodeURIComponent(query.types)}`);
    return parts.length ? `?${parts.join("&")}` : "";
  }

  return {
    getCard(id, locale = defaultLocale) {
      return getJson<TcgdexCardFull>(`/${locale}/cards/${encodeURIComponent(id)}`);
    },
    listCards(query, locale = defaultLocale) {
      return getJson<TcgdexCardBrief[]>(`/${locale}/cards${q(query)}`);
    },
    getSet(id, locale = defaultLocale) {
      return getJson<TcgdexSet>(`/${locale}/sets/${encodeURIComponent(id)}`);
    },
    listSets(locale = defaultLocale) {
      return getJson<TcgdexSetBrief[]>(`/${locale}/sets`);
    },
  };
}
