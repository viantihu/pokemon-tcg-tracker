"use client";

/**
 * Card type-ahead against the LOCAL mirror (dev-spec §5 M6 shared primitive; §7B step 2).
 *
 * The query runs on the SERVER via the injected `search` fn (a server action that hits
 * `catalog_card` through `lib/repo`) — the client never calls TCGdex. Decoupled from any one screen
 * so backfill (M5) and lookup (M8) can pass their own `search`/`onPick`.
 */

import { useEffect, useRef, useState } from "react";
import { CardFace } from "./CardFace";
import type { LookupCard } from "../plan/plan-types";

export function CardLookup({
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
   * The search FAILED, as distinct from finding nothing (UIL-035).
   *
   * Without this the dropdown reported "No match in the local mirror" for a Supabase outage, an expired
   * session and a genuinely unknown card alike — telling her a card does not exist when the truth was
   * that nothing was asked. `search` now throws on failure and an empty array means only "asked, and
   * there was nothing", so the two states are finally separable here.
   *
   * Lives in this shared component rather than in each caller: five screens inject their own `search`,
   * and doing it once means every one of them gains the distinction, including the screens this change
   * does not touch.
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
        <div className="sugg" role="listbox">
          {failed ? (
            /* A failure, said as one. Never "no match" — that would be a claim about her collection
               that the app is in no position to make (UIL-035). */
            <button
              type="button"
              disabled
              style={{ cursor: "default", color: "var(--ink)", background: "var(--note)" }}
            >
              {failed} — the card may well exist; the catalog just did not answer. Try again.
            </button>
          ) : loading && results.length === 0 ? (
            <button type="button" disabled style={{ cursor: "default", color: "var(--ink-2)" }}>
              Searching the mirror…
            </button>
          ) : results.length === 0 ? (
            <button type="button" disabled style={{ cursor: "default", color: "var(--ink-2)" }}>
              No match in the local mirror. (Full catalog needs a sync run.)
            </button>
          ) : (
            results.map((c) => (
              <button
                key={c.tcgdexId}
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => pick(c)}
              >
                <CardFace name={c.name} imageUrl={c.imageUrl} size="s" />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="nm" style={{ display: "block" }}>
                    {c.name}
                  </span>
                  <span style={{ fontSize: 10, color: "var(--ink-2)" }}>
                    {(c.setName ?? c.setId ?? "").toString()}
                    {c.localId ? ` · ${c.localId}` : ""}
                    {c.cardClass === "specialty" ? " · SPECIALTY" : ""}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
