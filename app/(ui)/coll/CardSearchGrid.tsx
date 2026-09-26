"use client";

/**
 * Card search for building a collection (UIL-039; scr-coll-search). Its own page rather than the
 * inline type-ahead, image-first per her standing design principle: a grid of `CardFace` tiles with
 * filters, not a list of names. Paginated (`browseCards`) rather than mounting everything, so this
 * never inherits UIL-034's "mount every card at once" problem on day one of existing.
 *
 * The ONE add surface for building a chase list — `CollectionEditor`'s old inline add is removed in
 * the same change that ships this page, once the link between them works (never both at once, and
 * never neither).
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BandChip } from "../_components/BandChip";
import { formatCollectorNumber } from "@/lib/catalog/collector-number";
import { CardFace } from "../_components/CardFace";
import { DEFAULT_BAND_ORDER, bandMeta } from "../_components/plan-meta";
import {
  browseCards,
  bulkAddTargets,
  getCollectionName,
  listSetOptions,
  resolveSpeciesToDexId,
} from "./actions";
import type { BrowseCard, BrowseFilters, BulkAddResult, SetOption } from "./coll-types";
import { isUnreached, LOST, reach } from "../_components/reach";

type OwnedFilter = "any" | "owned" | "unowned";

const OWNED_LABEL: Record<OwnedFilter, string> = {
  any: "All cards",
  owned: "Cards I own",
  unowned: "Cards I'm missing",
};

/** Why the species filter is off. `resolveSpeciesToDexId` throws for a server failure too, so it names no cause. */
export const speciesLookupFailed = (name: string) =>
  `Could not look up "${name}", so no species filter is applied. Reload the page to try again.`;

/**
 * What a bulk add did, in her words (UIL-101): how many joined the list, and of the cards she picked, how
 * many went on her wishlist and how many she already owns. Parts that are zero are left out.
 */
export function bulkAddSummary(
  r: { added: number; wishlisted: number; alreadyWished: number; owned: number },
  collectionName: string,
): string {
  const plural = (n: number) => (n === 1 ? "" : "s");
  const head = `Added ${r.added} card${plural(r.added)} to ${collectionName}.`;
  const parts: string[] = [];
  if (r.wishlisted > 0) parts.push(`${r.wishlisted} went on your wishlist`);
  if (r.alreadyWished > 0) {
    parts.push(
      `${r.alreadyWished} ${r.alreadyWished === 1 ? "was" : "were"} already on your wishlist`,
    );
  }
  if (r.owned > 0) parts.push(`${r.owned} you already own`);
  if (parts.length === 0) return head;
  const picked = r.wishlisted + r.alreadyWished + r.owned;
  return `${head} Of the ${picked} you picked, ${parts.join(", ")}.`;
}

export function CardSearchGrid({ collectionId }: { collectionId: string }) {
  const router = useRouter();
  const [collectionName, setCollectionName] = useState("");

  useEffect(() => {
    getCollectionName(collectionId).then((n) => setCollectionName(n ?? "Untitled collection"));
  }, [collectionId]);

  const [illustrator, setIllustrator] = useState("");
  const [text, setText] = useState("");
  const [species, setSpecies] = useState("");
  const [dexId, setDexId] = useState<number | null>(null);
  const [speciesError, setSpeciesError] = useState<string | null>(null);
  const [setId, setSetId] = useState<string>("");
  const [type, setType] = useState<string>("");
  const [owned, setOwned] = useState<OwnedFilter>("any");
  const [setOptions, setSetOptions] = useState<SetOption[]>([]);

  const [cards, setCards] = useState<BrowseCard[]>([]);
  const [nextOffset, setNextOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [added, setAdded] = useState<Extract<BulkAddResult, { ok: true }> | null>(null);

  const requestToken = useRef(0);

  useEffect(() => {
    listSetOptions().then(setSetOptions, () => setSetOptions([]));
  }, []);

  function filters(): BrowseFilters {
    return {
      text: text.trim() || undefined,
      illustrator: illustrator.trim() || undefined,
      setId: setId || undefined,
      dexId: dexId ?? undefined,
      type: type || undefined,
      owned,
    };
  }

  // Runs on every filter change (debounced) — always a FRESH search from offset 0, never appended.
  useEffect(() => {
    const token = ++requestToken.current;
    const t = setTimeout(async () => {
      setLoading(true);
      setLoadError(null);
      try {
        // Through `reach` (UIL-109): a failed search says so in the shared words.
        const page = await reach(() => browseCards(filters(), 0), LOST.load);
        if (token !== requestToken.current) return;
        if (isUnreached(page)) {
          setLoadError(page.error);
          return;
        }
        setCards(page.cards);
        setNextOffset(page.nextOffset);
        setHasMore(page.hasMore);
      } finally {
        if (token === requestToken.current) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- filters() reads this same state
  }, [text, illustrator, setId, dexId, type, owned]);

  async function loadMore() {
    setLoading(true);
    setLoadError(null);
    try {
      const page = await reach(() => browseCards(filters(), nextOffset), LOST.load);
      if (isUnreached(page)) {
        setLoadError(page.error);
        return;
      }
      setCards((prev) => [...prev, ...page.cards]);
      setNextOffset(page.nextOffset);
      setHasMore(page.hasMore);
    } finally {
      setLoading(false);
    }
  }

  async function resolveSpecies(value: string) {
    setSpecies(value);
    setSpeciesError(null);
    const name = value.trim();
    if (!name) {
      setDexId(null);
      return;
    }
    let id: number | null;
    try {
      id = await resolveSpeciesToDexId(name);
    } catch {
      // UIL-106: the lookup threw (a dropped connection, a redeploy, or the server failing), so no
      // species is applied — said here, rather than silently leaving the last name's filter on.
      setDexId(null);
      setSpeciesError(speciesLookupFailed(name));
      return;
    }
    if (id == null) {
      setDexId(null);
      setSpeciesError(`No card named "${name}" in the catalog.`);
    } else {
      setDexId(id);
    }
  }

  function toggle(tcgdexId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tcgdexId)) next.delete(tcgdexId);
      else next.add(tcgdexId);
      return next;
    });
  }

  async function addSelected() {
    if (selected.size === 0) return;
    setAdding(true);
    setAddError(null);
    try {
      // Through `reach` (UIL-106): a call that never answers ends in words, and her selection is kept.
      const res = await reach(() => bulkAddTargets(collectionId, [...selected]), LOST.action);
      if (!res.ok) {
        setAddError(res.error);
        return;
      }
      setAdded(res);
      setSelected(new Set());
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="csearch">
      <div className="collhd panel">
        <span className="hk u">Search &amp; add · {collectionName || "Untitled collection"}</span>
        <button
          type="button"
          className="btn u"
          onClick={() => router.push(`/coll?edit=${collectionId}`)}
        >
          ← Back to collection
        </button>
      </div>

      <div className="csfilters panel">
        <label className="orow">
          <div className="ol u">Illustrator</div>
          <input
            className="field"
            value={illustrator}
            onChange={(e) => setIllustrator(e.target.value)}
            placeholder="e.g. Ryota Murayama"
            autoFocus
          />
        </label>

        <label className="orow">
          <div className="ol u">Set</div>
          <select className="field" value={setId} onChange={(e) => setSetId(e.target.value)}>
            <option value="">Any set</option>
            {setOptions.map((s) => (
              <option key={s.setId} value={s.setId}>
                {s.setName}
              </option>
            ))}
          </select>
        </label>

        <label className="orow">
          <div className="ol u">Pokémon</div>
          <input
            className="field"
            value={species}
            onChange={(e) => resolveSpecies(e.target.value)}
            placeholder="e.g. Charmander"
          />
          {speciesError && <div className="hint u">{speciesError}</div>}
        </label>

        <div className="orow">
          <div className="ol u">Type</div>
          <div className="ochips">
            <button
              type="button"
              className={"ochip u" + (type === "" ? " on" : "")}
              onClick={() => setType("")}
            >
              All
            </button>
            {DEFAULT_BAND_ORDER.map((key) => (
              <button
                key={key}
                type="button"
                className={"ochip u" + (type === key ? " on" : "")}
                onClick={() => setType(key)}
              >
                <BandChip bandKey={key} /> {bandMeta(key).display}
              </button>
            ))}
          </div>
        </div>

        <div className="orow">
          <div className="ol u">Own it?</div>
          <div className="modetoggle">
            {(["any", "unowned", "owned"] as OwnedFilter[]).map((v) => (
              <button
                key={v}
                type="button"
                className={"modebtn u" + (owned === v ? " on" : "")}
                onClick={() => setOwned(v)}
              >
                {OWNED_LABEL[v]}
              </button>
            ))}
          </div>
        </div>

        <label className="orow">
          <div className="ol u">Name or number</div>
          <input
            className="field"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Free text — name or collector number"
          />
        </label>
      </div>

      {loadError && (
        <div className="alertbar" role="alert" style={{ background: "#FFD9DF" }}>
          <span>!</span>
          <b>{loadError}</b>
        </div>
      )}
      {addError && (
        <div className="alertbar" role="alert" style={{ background: "#FFD9DF" }}>
          <span>!</span>
          <b>{addError}</b>
        </div>
      )}
      {added && (
        <div className="alertbar ok" role="status">
          <span>✓</span>
          <b>{bulkAddSummary(added, collectionName)}</b>
        </div>
      )}

      <div className="cgrid">
        {cards.map((c) => {
          const picked = selected.has(c.tcgdexId);
          return (
            <BrowseCardTile
              key={c.tcgdexId}
              card={c}
              picked={picked}
              onToggle={() => toggle(c.tcgdexId)}
            />
          );
        })}
      </div>

      {!loading && cards.length === 0 && (
        <div className="stub panel">
          <p>No cards match these filters.</p>
        </div>
      )}

      <div className="cesave">
        <span className="hk u">
          {loading ? "Searching…" : `${cards.length} shown`}
          {selected.size > 0 ? ` · ${selected.size} selected` : ""}
        </span>
        {hasMore && (
          <button type="button" className="btn u" onClick={loadMore} disabled={loading}>
            Load more
          </button>
        )}
        <button
          type="button"
          className="btn btn-primary u"
          style={{ marginLeft: "auto" }}
          disabled={selected.size === 0 || adding}
          onClick={addSelected}
        >
          {adding ? "Adding…" : `Add ${selected.size || ""} to ${collectionName || "collection"}`}
        </button>
      </div>
    </div>
  );
}

/**
 * One tile of the builder grid, exported so the collector-number rendering can be pinned without
 * driving the page (it needs a router). Shows the FULL printed number, "099/182" (UIL-077) — the bare
 * digits were the wishlist-grid gap Karvi screenshotted.
 */
export function BrowseCardTile({
  card,
  picked,
  onToggle,
}: {
  card: BrowseCard;
  picked: boolean;
  onToggle: () => void;
}) {
  const number = formatCollectorNumber(card.localId, card.setCardCountOfficial);
  return (
    <button
      type="button"
      className={"ccard" + (picked ? " picked" : "")}
      onClick={onToggle}
      aria-pressed={picked}
    >
      <CardFace name={card.name} tcgdexId={card.tcgdexId} imageUrl={card.imageUrl} size="m" />
      <div className="cn u">{card.name}</div>
      {number ? <div className="cno">{number}</div> : null}
      {card.owned && <span className="cpill have u">Owned</span>}
      {picked && <span className="cpill wish u">Selected</span>}
    </button>
  );
}
