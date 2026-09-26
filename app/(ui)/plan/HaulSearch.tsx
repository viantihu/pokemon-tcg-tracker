"use client";

/**
 * "Search haul" (UIL-115): a search box over the plan on screen, results as card tiles.
 *
 * IMAGE-LED, and the same tiles as every other search in the app (UIL-071's `.cgrid` / `.ccard`): she
 * recognises artwork before she reads a name. Each tile adds what this search is for: where the card goes,
 * and whether it is already shelved ("Done"). Picking a tile puts that card in the spotlight and scrolls
 * its row into view; the query stays, so she can pick the next one.
 *
 * The matching rule is ./search.ts. At most SEARCH_PAGE tiles render; "Show more" adds as many again.
 */

import { useState } from "react";
import { formatCollectorNumber } from "@/lib/catalog/collector-number";
import { cardTag, stripLocaleNamespace } from "@/lib/catalog/locale";
import { BandChip } from "../_components/BandChip";
import { CardFace } from "../_components/CardFace";
import { SEARCH_PAGE, searchHaul, type HaulSearchEntry } from "./search";

/** A searchable card, with what its tile shows beyond the card itself. */
export interface HaulSearchTile extends HaulSearchEntry {
  /** Shelved: written to the database (UIL-027). */
  done: boolean;
  /** Where it goes, as its row says it (her override if she set one). */
  destination: string;
}

export function HaulSearch({
  entries,
  onPick,
}: {
  entries: HaulSearchTile[];
  onPick: (incomingId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(SEARCH_PAGE);
  const matches = searchHaul(entries, query);
  const searching = query.trim().length > 0;

  return (
    <div className="haulsearch panel">
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          className="field"
          style={{ flex: 1, minWidth: 0 }}
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setShown(SEARCH_PAGE);
          }}
          placeholder="Search haul: name, number (026/197), set or variant"
          autoComplete="off"
          spellCheck={false}
          aria-label="Search haul"
        />
        {searching ? (
          <button type="button" className="btn sm" onClick={() => setQuery("")}>
            Clear
          </button>
        ) : null}
      </div>

      {searching ? (
        matches.length === 0 ? (
          <div className="hint u" role="status" style={{ marginTop: 8 }}>
            No card in this haul matches “{query.trim()}”.
          </div>
        ) : (
          <>
            <div className="hint u" role="status" style={{ marginTop: 8 }}>
              {matches.length} card{matches.length === 1 ? "" : "s"} match
              {matches.length > shown ? ` · showing ${shown}` : ""}
            </div>
            <div
              className="cgrid"
              role="list"
              aria-label="Cards in this haul that match"
              style={{ marginTop: 8 }}
            >
              {matches.slice(0, shown).map((e) => {
                const { item } = e;
                const number = formatCollectorNumber(item.localId, item.setCardCountOfficial);
                return (
                  <button
                    key={item.incomingId}
                    type="button"
                    role="listitem"
                    className={"ccard" + (e.done ? " done" : "")}
                    aria-label={`${item.name}${number ? ` ${number}` : ""}${e.done ? ", done" : ""}: show it in the plan`}
                    onClick={() => onPick(item.incomingId)}
                  >
                    <CardFace
                      name={item.name}
                      tcgdexId={item.tcgdexId}
                      imageUrl={item.imageUrl ?? null}
                      size="m"
                    />
                    <div className="cn u">{item.name}</div>
                    <div className="cno">
                      {e.setName ?? stripLocaleNamespace(item.setId)}
                      {cardTag(item.tcgdexId) ? ` · ${cardTag(item.tcgdexId)}` : ""}
                    </div>
                    {number ? <div className="cno">{number}</div> : null}
                    <div className="cno">
                      <BandChip bandKey={item.bandKey} /> {e.destination}
                    </div>
                    {e.done ? <span className="cpill have u">Done</span> : null}
                  </button>
                );
              })}
            </div>
            {matches.length > shown ? (
              <button
                type="button"
                className="btn"
                style={{ marginTop: 8 }}
                onClick={() => setShown((s) => s + SEARCH_PAGE)}
              >
                Show more ({matches.length - shown} more)
              </button>
            ) : null}
          </>
        )
      ) : null}
    </div>
  );
}
