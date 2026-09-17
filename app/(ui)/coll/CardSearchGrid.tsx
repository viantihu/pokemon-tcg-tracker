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
import { CardFace } from "../_components/CardFace";
import { DEFAULT_BAND_ORDER, bandMeta } from "../_components/plan-meta";
import {
  browseCards,
  bulkAddTargets,
  getCollectionName,
  listSetOptions,
  resolveSpeciesToDexId,
} from "./actions";
import type { BrowseCard, BrowseFilters, SetOption } from "./coll-types";

type OwnedFilter = "any" | "owned" | "unowned";

const OWNED_LABEL: Record<OwnedFilter, string> = {
  any: "All cards",
  owned: "Cards I own",
  unowned: "Cards I'm missing",
};

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
  const [addedCount, setAddedCount] = useState<number | null>(null);

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
        const page = await browseCards(filters(), 0);
        if (token !== requestToken.current) return;
        setCards(page.cards);
        setNextOffset(page.nextOffset);
        setHasMore(page.hasMore);
      } catch (e) {
        if (token === requestToken.current) {
          setLoadError(e instanceof Error ? e.message : "Could not search the catalog.");
        }
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
      const page = await browseCards(filters(), nextOffset);
      setCards((prev) => [...prev, ...page.cards]);
      setNextOffset(page.nextOffset);
      setHasMore(page.hasMore);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not search the catalog.");
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
    const id = await resolveSpeciesToDexId(name);
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
      const res = await bulkAddTargets(collectionId, [...selected]);
      if (!res.ok) {
        setAddError(res.error);
        return;
      }
      setAddedCount(res.added);
      setSelected(new Set());
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "Could not add these cards.");
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
      {addedCount != null && (
        <div className="alertbar ok" role="status">
          <span>✓</span>
          <b>
            Added {addedCount} card{addedCount === 1 ? "" : "s"} to {collectionName}.
          </b>
        </div>
      )}

      <div className="cgrid">
        {cards.map((c) => {
          const picked = selected.has(c.tcgdexId);
          return (
            <button
              key={c.tcgdexId}
              type="button"
              className={"ccard" + (picked ? " picked" : "")}
              onClick={() => toggle(c.tcgdexId)}
              aria-pressed={picked}
            >
              <CardFace name={c.name} imageUrl={c.imageUrl} size="m" />
              <div className="cn u">{c.name}</div>
              {c.localId ? <div className="cno">{c.localId}</div> : null}
              {c.owned && <span className="cpill have u">Owned</span>}
              {picked && <span className="cpill wish u">Selected</span>}
            </button>
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
