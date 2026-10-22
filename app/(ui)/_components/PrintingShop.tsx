"use client";

/**
 * "Pick another" for an empty stage, as a place to browse (Karvi, 2026-10-22: "she should be almost shopping for the
 * next card for her collection"). Every printing of the stage's species in the line's language, as the app's card
 * tiles (`.cgrid`/`.ccard`, the Collections search grid's look): big art she can tap to enlarge, the set, the number,
 * the price, and what is different about it. A find box, a colour filter and a sort let her look around; "Chase" on a
 * tile is her pick.
 *
 * Render and report only: the options come from the stage's `loadOptions`, and `onPick` hands the chosen one back.
 */

import { useState } from "react";
import { formatCollectorNumber } from "@/lib/catalog/collector-number";
import { stripLocaleNamespace } from "@/lib/catalog/locale";
import type { StageOption } from "@/lib/line/popup";
import { CardFace } from "./CardFace";
import { fmtPrice } from "./decision-format";

type Sort = "suggested" | "cheap" | "dear" | "set";
type Colour = "any" | "same";

const SORT_LABEL: Record<Sort, string> = {
  suggested: "Suggested",
  cheap: "Cheapest",
  dear: "Priciest",
  set: "By set",
};

const setOf = (o: StageOption) => o.card.setName ?? stripLocaleNamespace(o.card.setId);
const numberOf = (o: StageOption) =>
  formatCollectorNumber(o.card.localId, o.card.setCardCountOfficial ?? null);
/** Unpriced printings sort last either way: a missing price is not a cheap one. */
const priceKey = (o: StageOption, dir: 1 | -1) =>
  o.priceMarket == null ? Number.POSITIVE_INFINITY : dir * o.priceMarket;

function sorted(items: readonly StageOption[], sort: Sort): StageOption[] {
  const list = [...items];
  if (sort === "cheap") list.sort((a, b) => priceKey(a, 1) - priceKey(b, 1));
  if (sort === "dear") list.sort((a, b) => priceKey(a, -1) - priceKey(b, -1));
  if (sort === "set") {
    list.sort(
      (a, b) =>
        setOf(a).localeCompare(setOf(b)) ||
        (a.card.localId ?? "").localeCompare(b.card.localId ?? "", undefined, { numeric: true }),
    );
  }
  return list;
}

export function PrintingShop({
  items,
  label,
  chosen,
  onPick,
  busy,
}: {
  items: readonly StageOption[];
  /** The grid's name, e.g. "Printings for the Stage 1 slot". */
  label: string;
  /** The printing she is chasing now, if any. */
  chosen: string | null;
  onPick(o: StageOption): void;
  busy: boolean;
}) {
  const [find, setFind] = useState("");
  const [sort, setSort] = useState<Sort>("suggested");
  const [colour, setColour] = useState<Colour>("any");
  const sameCount = items.filter((o) => o.sameColour).length;
  const needle = find.trim().toLowerCase();
  const shown = sorted(
    items.filter(
      (o) =>
        (colour === "any" || o.sameColour) &&
        (!needle ||
          o.card.name.toLowerCase().includes(needle) ||
          setOf(o).toLowerCase().includes(needle) ||
          (numberOf(o) ?? "").toLowerCase().includes(needle)),
    ),
    sort,
  );
  const prices = items.map((o) => o.priceMarket).filter((p): p is number => p != null);
  const range =
    prices.length > 0
      ? `${fmtPrice(Math.min(...prices))}${prices.length > 1 ? ` – ${fmtPrice(Math.max(...prices))}` : ""}`
      : null;

  return (
    <div className="lp-shop">
      <div className="lp-shopbar">
        <input
          type="search"
          className="lp-find"
          aria-label="Find a printing"
          placeholder="Find by set or number"
          value={find}
          onChange={(e) => setFind(e.target.value)}
        />
        <div className="modetoggle" role="group" aria-label="Colour">
          <button
            type="button"
            className={"modebtn u" + (colour === "any" ? " on" : "")}
            aria-pressed={colour === "any"}
            onClick={() => setColour("any")}
          >
            All colours
          </button>
          <button
            type="button"
            className={"modebtn u" + (colour === "same" ? " on" : "")}
            aria-pressed={colour === "same"}
            disabled={sameCount === 0}
            onClick={() => setColour("same")}
          >
            This line&apos;s colour
          </button>
        </div>
        <div className="modetoggle" role="group" aria-label="Sort">
          {(Object.keys(SORT_LABEL) as Sort[]).map((s) => (
            <button
              key={s}
              type="button"
              className={"modebtn u" + (sort === s ? " on" : "")}
              aria-pressed={sort === s}
              onClick={() => setSort(s)}
            >
              {SORT_LABEL[s]}
            </button>
          ))}
        </div>
      </div>
      <div className="lp-note u" role="status">
        {shown.length === items.length
          ? `${items.length} printing${items.length === 1 ? "" : "s"}`
          : `${shown.length} of ${items.length} printings`}
        {range ? ` · ${range}` : ""} · tap a card to look closer
      </div>
      {shown.length === 0 ? <div className="lp-note">No printing matches that.</div> : null}
      <div className="cgrid lp-shopgrid" role="group" aria-label={label}>
        {shown.map((o) => {
          const c = o.card;
          const number = numberOf(o);
          const on = chosen === c.tcgdexId;
          const name = `${c.name} ${number ?? ""}`.trim();
          return (
            <div key={c.tcgdexId} className={"ccard lp-shopcard" + (on ? " picked" : "")}>
              <CardFace
                name={c.name}
                tcgdexId={c.tcgdexId}
                imageUrl={c.imageUrl}
                size="l"
                zoomable
                caption={[setOf(o), number].filter(Boolean).join(" · ") || null}
              />
              <div className="cn u">{c.name}</div>
              <div className="cno">{setOf(o)}</div>
              {number ? <div className="cno">{number}</div> : null}
              <div className="lp-price u">{fmtPrice(o.priceMarket) ?? "No price"}</div>
              {!o.sameColour ? <span className="cpill u">Different colour</span> : null}
              {o.special ? <span className="cpill wish u">Special</span> : null}
              <button
                type="button"
                className={"btn sm" + (on ? " picked" : "")}
                aria-pressed={on}
                aria-label={`Chase ${name}`}
                disabled={busy}
                onClick={() => onPick(o)}
              >
                {on ? "Chasing" : "Chase"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
