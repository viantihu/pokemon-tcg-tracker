/**
 * Query-string reading for the catalog routes (UIL-083).
 *
 * `URLSearchParams` decodes a bare "+" as a SPACE (application/x-www-form-urlencoded rules). TCGdex set
 * ids can contain a literal plus — SM1+, sm2+, SM3+, SM4+, SM5+ — and the mirror workflow dispatches
 * `?set=SM1+`, so the route saw "SM1 " and TCGdex was asked for `/ja/sets/SM1%20` → 404, five sets
 * never mirrored. `decodeURIComponent` keeps a literal plus and still decodes `%2B`, so both the raw and
 * the encoded dispatch form yield the id TCGdex knows.
 */
/** The named query parameter, decoded without "+" → space; null when absent. */
export function rawQueryParam(url: string, name: string): string | null {
  const query = url.split("#")[0].split("?")[1] ?? "";
  for (const part of query.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = eq === -1 ? part : part.slice(0, eq);
    if (key !== name) continue;
    const value = eq === -1 ? "" : part.slice(eq + 1);
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}
