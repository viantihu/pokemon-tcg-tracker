"use client";

/**
 * Card type-ahead against the LOCAL mirror, results as a GRID of card tiles (UIL-071).
 *
 * Karvi: "the search throughout the app should be uniform." UIL-039 built Collections' builder search
 * image-first — a grid of `CardFace` tiles, because this is a visual hobby and she recognises artwork
 * before she reads a name — and this is that presentation for EVERY inline type-ahead in the app: the
 * Haul Plan intake, the Lookup tab, Backfill's five sites, Sync's unresolved-entry pin picker and
 * Collections' log-a-card. Each composes it with the same contract (`search`, `onPick`, `placeholder?`;
 * the query runs on the SERVER via the injected `search`, a server action over `lib/repo` — the client
 * never calls TCGdex), so its behaviour is the app's behaviour: a 200 ms debounce, a 2-character
 * minimum, three non-result states — searching, no match, and the UIL-035 failure ("could not search …
 * the card may well exist"), with the last good results kept on screen through a transient failure —
 * and results as tiles with name / set / full collector number ("099/182", UIL-077) underneath.
 *
 * It replaced the text-list type-ahead one call site per PR (UIL-071) and is now the ONLY copy of this
 * logic. NOT the builder page's `CardSearchGrid`, which is a different thing — filters, pagination,
 * multi-select, bulk add — coupled to that page.
 */

import { useEffect, useRef, useState } from "react";
import { formatCollectorNumber } from "@/lib/catalog/collector-number";
import { CardFace } from "./CardFace";
import type { LookupCard } from "../plan/plan-types";

export function CardResultsGrid({
  search,
  onPick,
  placeholder = "Set + number or name…",
}: {
  search: (query: string) => Promise<LookupCard[]>;
  onPick: (card: LookupCard) => void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LookupCard[]>([]);
  const [loading, setLoading] = useState(false);
  /**
   * The search FAILED, as distinct from finding nothing (UIL-035). Before this the dropdown reported
   * "no match" for a Supabase outage, an expired session and a genuinely unknown card alike — telling her
   * a card does not exist when the truth was that nothing was asked. `search` throws on failure and an
   * empty array means only "asked, and there was nothing", so the two states are separable here, once,
   * for every screen that injects a `search`.
   */
  const [failed, setFailed] = useState<string | null>(null);
  const latest = useRef(0);

  useEffect(() => {
    const q = query.trim();
    const token = ++latest.current;
    // All state updates run inside the (async) timeout callback — never synchronously in the
    // effect body — so a keystroke does not trigger a cascading render.
    const t = setTimeout(
      async () => {
        if (q.length < 2) {
          if (token === latest.current) {
            setResults([]);
            setLoading(false);
          }
          return;
        }
        if (token === latest.current) setLoading(true);
        try {
          const found = await search(q);
          if (token === latest.current) {
            setResults(found);
            setFailed(null);
          }
        } catch (err) {
          // Keep the last good results on screen rather than blanking them — a transient failure
          // mid-typing should not also erase what she could already see.
          if (token === latest.current) {
            setFailed(err instanceof Error ? err.message : "Could not search the catalog.");
          }
        } finally {
          if (token === latest.current) setLoading(false);
        }
      },
      q.length < 2 ? 0 : 200,
    );
    return () => clearTimeout(t);
  }, [query, search]);

  function pick(card: LookupCard) {
    onPick(card);
    setQuery("");
    setResults([]);
    setFailed(null);
  }

  return (
    <div className="lookup">
      <input
        className="field"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        aria-label="Card lookup"
      />
      {query.trim().length >= 2 && (
        <CardResultTiles results={results} loading={loading} failed={failed} onPick={pick} />
      )}
    </div>
  );
}

/**
 * The results half, presentational and exported so it can be rendered without driving the type-ahead:
 * a grid of tiles, or one of the three non-result states. A failure is
 * shown ABOVE whatever results were already there — never instead of them, never as "no match".
 */
export function CardResultTiles({
  results,
  loading,
  failed,
  onPick,
}: {
  results: LookupCard[];
  loading: boolean;
  failed: string | null;
  onPick: (card: LookupCard) => void;
}) {
  return (
    <div className="cresults" style={{ marginTop: 8, display: "grid", gap: 8 }}>
      {failed ? (
        <div
          className="hint u"
          role="alert"
          style={{ color: "var(--ink)", background: "var(--note)", padding: "8px 10px" }}
        >
          {failed} — the card may well exist; the catalog just did not answer. Try again.
        </div>
      ) : loading && results.length === 0 ? (
        <div className="hint u" role="status">
          Searching the mirror…
        </div>
      ) : results.length === 0 ? (
        <div className="hint u" role="status">
          No match in the local mirror. (Full catalog needs a sync run.)
        </div>
      ) : null}

      {results.length > 0 ? (
        <div className="cgrid" role="listbox" aria-label="Matching cards">
          {results.map((c) => {
            const number = formatCollectorNumber(c.localId, c.setCardCountOfficial);
            return (
              <button
                key={c.tcgdexId}
                type="button"
                className="ccard"
                role="option"
                aria-selected={false}
                onClick={() => onPick(c)}
              >
                <CardFace name={c.name} imageUrl={c.imageUrl} size="m" />
                <div className="cn u">{c.name}</div>
                <div className="cno">{(c.setName ?? c.setId ?? "").toString()}</div>
                {number ? <div className="cno">{number}</div> : null}
                {c.cardClass === "specialty" ? (
                  <span className="cpill wish u">Specialty</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
