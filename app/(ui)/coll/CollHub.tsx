"use client";

/**
 * Collections + Wishlist hub (scr-coll; dev-spec §5 M8; system-design §7D).
 *
 * The Collections nav tab hosts two surfaces behind a segmented control — Collections (create /
 * edit / delete, FINITE vs OPEN, "＋ log a card" as a placement) and Wishlist (every open
 * placeholder grouped by line + binder, exportable as copy-paste AND a Dex-round-tripping CSV).
 * Wishlist lives here rather than adding a nav tab, since the app shell (TopBar) is frozen.
 *
 * Client-driven: loads via `loadCollHub` on mount and re-loads after each mutation.
 */

import { useCallback, useEffect, useState } from "react";
import type { MoveDestination } from "@/lib/line/types";
import {
  buildWishlistCopyText,
  buildWishlistCsv,
  encodeDexCsvUtf16le,
  finiteProgress,
  type WishlistBinderGroup,
} from "@/lib/surfaces";
import { BandChip } from "../_components/BandChip";
import { CardFace } from "../_components/CardFace";
import { CardLookup } from "../_components/CardLookup";
import { MoveOverlay } from "../_components/MoveOverlay";
import type { LookupCard } from "../plan/plan-types";
import {
  deleteCollection,
  loadCollHub,
  logCardIntoCollection,
  removeCardFromCollection,
  saveCollection,
  searchCatalog,
  setCollectionMode,
  wishlistCollectionCard,
} from "./actions";
import type {
  CollectionCardView,
  CollectionInput,
  CollectionView,
  CollHubData,
} from "./coll-types";

type Tab = "coll" | "wish";

/** A card held in the editor's working target list. */
interface DraftTarget {
  tcgdexId: string;
  name: string;
  setName: string | null;
  localId: string | null;
  /**
   * She holds a copy of this card in the collection's binder. Dropping it from the list here would
   * strand that physical copy, so the row's "✕" is not offered (UIL-014 defect 2) — removal is a move,
   * done from the card in the grid. Always false for a card added in this session: ownership is
   * derived server-side, so a freshly-added target is only known to be owned after the next load, and
   * `saveCollection` refuses the drop regardless.
   */
  owned: boolean;
}

/** The card whose new home she is picking, with the collection it is leaving. */
interface RemovalTarget {
  collection: CollectionView;
  card: CollectionCardView;
}

interface EditorState {
  id: string | null;
  name: string;
  mode: "finite" | "open";
  binderId: string; // an existing specialty binder id, or "__new"
  newBinderName: string;
  targets: DraftTarget[];
}

export function CollHub() {
  const [data, setData] = useState<CollHubData | null>(null);
  const [tab, setTab] = useState<Tab>("coll");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [logFor, setLogFor] = useState<CollectionView | null>(null);
  const [removeFor, setRemoveFor] = useState<RemovalTarget | null>(null);

  // Reused by mutation handlers. setState lands only inside .then/.catch (never synchronously).
  const refresh = useCallback(
    () =>
      loadCollHub().then(
        (d) => setData(d),
        (e) =>
          setError(
            e instanceof Error ? e.message : "Could not load collections. Is the DB reachable?",
          ),
      ),
    [],
  );

  useEffect(() => {
    let alive = true;
    loadCollHub()
      .then((d) => alive && setData(d))
      .catch(
        (e) =>
          alive &&
          setError(
            e instanceof Error ? e.message : "Could not load collections. Is the DB reachable?",
          ),
      );
    return () => {
      alive = false;
    };
  }, []);

  async function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) setError(res.error ?? "Something went wrong.");
      else await refresh();
      return res.ok;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function openNew() {
    const first = data?.specialtyBinders[0]?.id ?? "__new";
    setEditor({
      id: null,
      name: "",
      mode: "finite",
      binderId: first,
      newBinderName: "",
      targets: [],
    });
  }
  function openEdit(c: CollectionView) {
    setEditor({
      id: c.id,
      name: c.name,
      mode: c.mode,
      binderId: c.binderIds[0] ?? "__new",
      newBinderName: "",
      targets: c.cards.map((k) => ({
        tcgdexId: k.tcgdexId,
        name: k.name,
        setName: k.setName,
        localId: k.localId,
        owned: k.owned,
      })),
    });
  }

  /**
   * UIL-014: removal is a MOVE. A card she holds needs a new home, so it opens the shared move picker.
   * A card on the list she does NOT hold in this collection's binder has nothing to re-home (an open
   * collection whose copy has since moved on), so there is no home to pick — that one is just a
   * chase-list edit, confirmed inline.
   */
  async function requestRemove(collection: CollectionView, card: CollectionCardView) {
    if (card.copyIds.length > 0) {
      setRemoveFor({ collection, card });
      return;
    }
    const ok = window.confirm(
      `Remove "${card.name}" from ${collection.name}? You do not hold a copy of it in this ` +
        `collection's binder, so no card moves.`,
    );
    if (!ok) return;
    await run(() => removeCardFromCollection(collection.id, card.tcgdexId, { kind: "bulk" }));
  }

  async function submitEditor() {
    if (!editor) return;
    const input: CollectionInput = {
      id: editor.id,
      name: editor.name,
      mode: editor.mode,
      binderId: editor.binderId,
      newBinderName: editor.newBinderName,
      targetTcgdexIds: editor.targets.map((t) => t.tcgdexId),
    };
    const ok = await run(() => saveCollection(input));
    if (ok) setEditor(null);
  }

  return (
    <>
      {error && (
        <div className="alertbar" role="alert" style={{ background: "#FFD9DF" }}>
          <span>!</span>
          <b>{error}</b>
        </div>
      )}

      <div className="collhd panel">
        <span className="hk u">Collections</span>
        <div className="segbar" role="tablist" aria-label="Collections or wishlist">
          <button
            role="tab"
            aria-selected={tab === "coll"}
            className={"seg u" + (tab === "coll" ? " on" : "")}
            onClick={() => setTab("coll")}
          >
            Collections
          </button>
          <button
            role="tab"
            aria-selected={tab === "wish"}
            className={"seg u" + (tab === "wish" ? " on" : "")}
            onClick={() => setTab("wish")}
          >
            Wishlist{data ? ` · ${data.wishlist.entries.length}` : ""}
          </button>
        </div>
      </div>

      {!data ? (
        <div className="stub panel">
          <p>Loading…</p>
        </div>
      ) : tab === "coll" ? (
        <CollectionsView
          data={data}
          busy={busy}
          onNew={openNew}
          onEdit={openEdit}
          onMode={(id, mode) => run(() => setCollectionMode(id, mode))}
          onDelete={(id) => run(() => deleteCollection(id))}
          onLog={setLogFor}
          onWishlist={(cid, tid) => run(() => wishlistCollectionCard(cid, tid))}
          onRemove={requestRemove}
        />
      ) : (
        <WishlistView data={data} />
      )}

      {editor && (
        <CollectionEditor
          state={editor}
          binders={data?.specialtyBinders ?? []}
          busy={busy}
          onChange={setEditor}
          onClose={() => setEditor(null)}
          onSubmit={submitEditor}
        />
      )}

      {logFor && (
        <LogCardModal
          collection={logFor}
          busy={busy}
          onClose={() => setLogFor(null)}
          onLog={async (tid) => {
            const ok = await run(() => logCardIntoCollection(logFor.id, tid));
            if (ok) setLogFor(null);
          }}
        />
      )}

      {/*
        UIL-014: removing a card from a collection is a MOVE — `copy` has no `collection_id`, so the
        card has to be given somewhere else to live. Reuses the same picker the line strip and the plan
        spotlight use, seeded on the bulk box so the common case is one more click, with every shelf and
        collection right there when she wants to place it properly.
      */}
      {removeFor && data && (
        <MoveOverlay
          card={{
            copyId: removeFor.card.copyIds[0] ?? "",
            name: removeFor.card.name,
            localId: removeFor.card.localId,
            imageUrl: removeFor.card.imageUrl,
            bandKey: removeFor.card.bandKey,
            currentLabel: `${removeFor.collection.binderNames[0] ?? "No binder"} · ${removeFor.collection.name}`,
            initial: { kind: "bulk" },
          }}
          options={data.moveOptions}
          onClose={() => setRemoveFor(null)}
          onConfirm={async (dest: MoveDestination) => {
            const ok = await run(() =>
              removeCardFromCollection(removeFor.collection.id, removeFor.card.tcgdexId, dest),
            );
            if (ok) setRemoveFor(null);
          }}
        />
      )}
    </>
  );
}

/* ------------------------------- collections ------------------------------ */

function CollectionsView(props: {
  data: CollHubData;
  busy: boolean;
  onNew: () => void;
  onEdit: (c: CollectionView) => void;
  onMode: (id: string, mode: "finite" | "open") => void;
  onDelete: (id: string) => void;
  onLog: (c: CollectionView) => void;
  onWishlist: (collectionId: string, tcgdexId: string) => void;
  onRemove: (c: CollectionView, k: CollectionCardView) => void;
}) {
  const { data, busy, onNew, onEdit, onMode, onDelete, onLog, onWishlist, onRemove } = props;
  return (
    <div className="collwrap">
      <div className="collnew">
        <button className="newcollbtn u" onClick={onNew} disabled={busy}>
          ＋ New collection
        </button>
      </div>

      {data.collections.length === 0 && (
        <div className="stub panel">
          <p>No collections yet. Create one — it becomes a placement target immediately.</p>
        </div>
      )}

      {data.collections.map((c) => {
        const fin = c.mode === "finite";
        const prog = finiteProgress(c.totalCount, c.ownedCount);
        return (
          <div key={c.id} className="collcard panel">
            <div className="collhead">
              <div style={{ minWidth: 0 }}>
                <div className="collname">{c.name}</div>
                <div className="collmeta u">
                  {c.binderNames.join(" · ") || "No binder"} ·{" "}
                  {fin ? "Finite set list" : "Open running count"}
                </div>
              </div>
              <div className="collactions">
                <div className="modetoggle">
                  <button
                    className={"modebtn u" + (fin ? " on" : "")}
                    onClick={() => onMode(c.id, "finite")}
                    disabled={busy}
                  >
                    Finite
                  </button>
                  <button
                    className={"modebtn u" + (fin ? "" : " on")}
                    onClick={() => onMode(c.id, "open")}
                    disabled={busy}
                  >
                    Open
                  </button>
                </div>
                <button className="editcollbtn u" onClick={() => onEdit(c)} disabled={busy}>
                  ✎ Edit
                </button>
                <button
                  className="editcollbtn u"
                  onClick={() => {
                    if (confirm(`Delete "${c.name}"?`)) onDelete(c.id);
                  }}
                  disabled={busy}
                >
                  ✕ Delete
                </button>
              </div>
            </div>

            {fin ? (
              <>
                <div className="cbar">
                  <i style={{ width: `${prog.pct}%` }} />
                </div>
                <div className="cprog u">
                  <b>
                    {prog.owned} / {prog.total}
                  </b>{" "}
                  owned · {prog.pct}%
                  {prog.needed > 0 ? (
                    <span className="need"> · {prog.needed} needed</span>
                  ) : (
                    " · complete"
                  )}
                </div>
                <div className="cgrid">
                  {c.cards.map((k) => (
                    <div key={k.tcgdexId} className={"ccard" + (k.owned ? "" : " need")}>
                      <CardFace name={k.name} imageUrl={k.imageUrl} size="m" />
                      <div className="cn u">{k.name}</div>
                      {k.localId ? <div className="cno">{k.localId}</div> : null}
                      {k.owned ? (
                        <>
                          <span className="cpill have u">Owned</span>
                          <RemoveCardButton card={k} busy={busy} onClick={() => onRemove(c, k)} />
                        </>
                      ) : k.wished ? (
                        <span className="cpill wish u">On wishlist</span>
                      ) : (
                        <button
                          className="wbtn u"
                          disabled={busy}
                          onClick={() => onWishlist(c.id, k.tcgdexId)}
                        >
                          + Wishlist
                        </button>
                      )}
                    </div>
                  ))}
                  {c.cards.length === 0 && (
                    <p style={{ fontSize: 11, color: "var(--ink-2)" }}>
                      No cards in the set list yet. Edit to add the ones you are chasing.
                    </p>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="infbox">
                  <div className="infnum">{c.totalCount}</div>
                  <div className="inflab u">Cards and counting</div>
                  <button className="logbtn u" onClick={() => onLog(c)} disabled={busy}>
                    ＋ Log a card
                  </button>
                </div>
                <div className="cprog u">Open collection · no target, just a running count</div>
                {c.cards.length > 0 && (
                  <div className="cgrid">
                    {c.cards.map((k) => (
                      <div key={k.tcgdexId} className="ccard">
                        <CardFace name={k.name} imageUrl={k.imageUrl} size="m" />
                        <div className="cn u">{k.name}</div>
                        {k.localId ? <div className="cno">{k.localId}</div> : null}
                        <span className="cpill have u">In collection</span>
                        <RemoveCardButton card={k} busy={busy} onClick={() => onRemove(c, k)} />
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
      <div className="foot">FINITE · A SET LIST YOU CHASE. OPEN · A RUNNING COUNT WITH NO END.</div>
    </div>
  );
}

/**
 * The per-card removal control (UIL-014). Labelled with the count when the collection's binder holds
 * more than one copy of the printing, because all of them move: membership is per catalog card, so
 * leaving one behind would leave it shelved in the collection's binder and on no list — the exact
 * orphan this fix exists to prevent.
 */
function RemoveCardButton({
  card,
  busy,
  onClick,
}: {
  card: CollectionCardView;
  busy: boolean;
  onClick: () => void;
}) {
  const count = card.copyIds.length;
  return (
    <button
      className="wbtn u"
      style={{ background: "var(--panel)" }}
      disabled={busy}
      onClick={onClick}
      title={
        count === 0
          ? "Take this card off the collection's list. You hold no copy of it here, so nothing moves."
          : `Give ${count > 1 ? `these ${count} copies` : "this card"} a new home — removing it from a collection is a move, not a delete.`
      }
    >
      {count > 1 ? `Remove ${count} ▸` : "Remove ▸"}
    </button>
  );
}

/* -------------------------------- wishlist -------------------------------- */

function WishlistView({ data }: { data: CollHubData }) {
  const { groups, entries } = data.wishlist;
  const [copied, setCopied] = useState(false);

  function downloadCsv() {
    const csv = buildWishlistCsv(entries);
    const bytes = encodeDexCsvUtf16le(csv);
    const blob = new Blob([bytes as BlobPart], { type: "text/csv;charset=utf-16le" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "wishlist-dex.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copyList() {
    const text = buildWishlistCopyText(groups);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  if (entries.length === 0) {
    return (
      <div className="stub panel">
        <p>No open placeholders. Every line is filled or capped — nothing to chase right now.</p>
      </div>
    );
  }

  return (
    <div className="wishwrap">
      <div className="wishbar panel">
        <span className="hk u">{entries.length} open placeholders</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button className="btn u" onClick={copyList}>
            {copied ? "Copied ✓" : "Copy list"}
          </button>
          <button className="btn btn-primary u" onClick={downloadCsv}>
            Export Dex CSV ▾
          </button>
        </div>
      </div>

      {groups.map((g) => (
        <WishlistBinder key={g.binderId ?? "none"} group={g} />
      ))}

      <div className="foot">GROUPED BY BINDER → LINE · CSV MIRRORS BACK INTO DEX FOR SCANNING</div>
    </div>
  );
}

function WishlistBinder({ group }: { group: WishlistBinderGroup }) {
  return (
    <div className="wishgroup panel">
      <div className="bandhead" style={{ borderTop: 0 }}>
        <span className="nm u">{group.binderName}</span>
        <span className="ct">{group.count} needed</span>
      </div>
      {group.lineGroups.map((lg) => (
        <div key={lg.lineId ?? lg.lineLabel}>
          <div className="subhead u">{lg.lineLabel}</div>
          {lg.entries.map((e) => (
            <div key={e.id} className="wishrow">
              {e.bandKey ? <BandChip bandKey={e.bandKey} /> : <span className="chip" />}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="nm">
                  {e.chosen ? e.chosen.name : (e.speciesName ?? "Unknown")}
                  {e.chosen?.localId ? (
                    <span className="no" style={{ marginLeft: 8 }}>
                      {e.chosen.localId}
                    </span>
                  ) : null}
                </div>
                <div className="meta u">
                  {[e.requiredStage, e.bandDisplay, e.chosen?.setName].filter(Boolean).join(" · ")}
                  {e.willLiveInSpecialty ? " · SPECIALTY" : ""}
                </div>
                {e.alternates.length > 0 && (
                  <div className="alts u">
                    ALT:{" "}
                    {e.alternates
                      .map((a) => `${a.name}${a.localId ? ` ${a.localId}` : ""}`)
                      .join(" · ")}
                  </div>
                )}
              </div>
              <div className="wprice u">
                {e.chosen?.priceMarket != null ? `$${e.chosen.priceMarket.toFixed(2)}` : "—"}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/* --------------------------- editor + log modals -------------------------- */

function CollectionEditor(props: {
  state: EditorState;
  binders: { id: string; name: string }[];
  busy: boolean;
  onChange: (s: EditorState) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const { state, binders, busy, onChange, onClose, onSubmit } = props;
  const isNew = !state.id;

  /**
   * UIL-009: a stray click outside the panel used to unmount this editor and throw away everything
   * typed — no confirmation, no draft kept, no undo. Building a finite collection means picking cards
   * one at a time, so the work at risk grows the longer she stays, and the misclick costs most when
   * she is nearly done.
   *
   * The backdrop no longer dismisses at all: this is a form, not a lightbox. Close and Escape stay,
   * but both ask first once anything has been entered. Captured on mount, which is when the editor
   * opens, so "dirty" means changed since it was opened rather than merely non-empty (editing an
   * existing collection starts populated).
   */
  const [initial] = useState(() => JSON.stringify(state));
  const dirty = JSON.stringify(state) !== initial;

  const requestClose = useCallback(() => {
    if (
      dirty &&
      !window.confirm("Discard this collection? Everything entered here will be lost.")
    ) {
      return;
    }
    onClose();
  }, [dirty, onClose]);

  // Escape is the only keyboard way out of a modal; it routes through the same guard. No setState in
  // the effect body — the listener is registered, and only fires later.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  function addTarget(card: LookupCard) {
    if (state.targets.some((t) => t.tcgdexId === card.tcgdexId)) return;
    onChange({
      ...state,
      targets: [
        ...state.targets,
        {
          tcgdexId: card.tcgdexId,
          name: card.name,
          setName: card.setName,
          localId: card.localId,
          owned: false,
        },
      ],
    });
  }

  /**
   * Drop a card from the chase list. UIL-014 defect 2: this only ever edited the draft, and
   * `saveCollection` persisted it as `target_catalog_card_ids` without touching the `copy` row — so for
   * a card she owns it silently produced an untracked copy, still shelved in the collection's binder
   * but invisible in every collection and wishlist view. Owned rows no longer offer it (the server
   * refuses the drop either way); their removal is a move, from the card in the collection's grid.
   */
  function removeTarget(id: string) {
    if (state.targets.find((t) => t.tcgdexId === id)?.owned) return;
    onChange({ ...state, targets: state.targets.filter((t) => t.tcgdexId !== id) });
  }

  const valid =
    state.name.trim().length > 0 &&
    (state.binderId !== "__new" || state.newBinderName.trim().length > 0);

  // No backdrop onClick: dismissing a part-built collection by misclick is UIL-009.
  return (
    <div className="veil on">
      <div className="dsheet panel" role="dialog" aria-modal="true">
        <div className="cap">
          <span className="t u">{isNew ? "New collection" : "Edit collection"}</span>
          <button className="btn u" onClick={requestClose} style={{ background: "var(--panel-2)" }}>
            Close
          </button>
        </div>
        <div className="body">
          <label className="orow">
            <div className="ol u">Name</div>
            <input
              className="field"
              value={state.name}
              onChange={(e) => onChange({ ...state, name: e.target.value })}
              placeholder="e.g. Matsuno illustrations"
            />
          </label>

          <div className="orow">
            <div className="ol u">Mode</div>
            <div className="modetoggle" style={{ marginLeft: 0 }}>
              <button
                className={"modebtn u" + (state.mode === "finite" ? " on" : "")}
                onClick={() => onChange({ ...state, mode: "finite" })}
              >
                Finite
              </button>
              <button
                className={"modebtn u" + (state.mode === "open" ? " on" : "")}
                onClick={() => onChange({ ...state, mode: "open" })}
              >
                Open
              </button>
            </div>
          </div>

          <div className="orow">
            <div className="ol u">Specialty binder</div>
            <div className="ochips">
              {binders.map((b) => (
                <button
                  key={b.id}
                  className={"ochip u" + (state.binderId === b.id ? " on" : "")}
                  onClick={() => onChange({ ...state, binderId: b.id })}
                >
                  {b.name}
                </button>
              ))}
              <button
                className={"ochip u" + (state.binderId === "__new" ? " on" : "")}
                onClick={() => onChange({ ...state, binderId: "__new" })}
              >
                + New binder
              </button>
            </div>
          </div>

          {state.binderId === "__new" && (
            <label className="orow">
              <div className="ol u">New binder name</div>
              <input
                className="field"
                value={state.newBinderName}
                onChange={(e) => onChange({ ...state, newBinderName: e.target.value })}
                placeholder="e.g. Specialty Binder B"
              />
            </label>
          )}

          {state.mode === "finite" && (
            <>
              <div className="cerow-h u">
                Set list — the cards you chase. Owned status is derived from your shelf.
              </div>
              <CardLookup search={searchCatalog} onPick={addTarget} placeholder="Add a card…" />
              <div className="celist">
                {state.targets.map((t) => (
                  <div key={t.tcgdexId} className={"cerow" + (t.owned ? " own" : "")}>
                    <span className="cei">
                      <b>{t.name}</b>
                      <i>
                        {t.setName ?? ""}
                        {t.localId ? ` · ${t.localId}` : ""}
                      </i>
                    </span>
                    {t.owned ? (
                      <span className="cpill have u" style={{ marginTop: 0 }}>
                        Owned · remove on the card
                      </span>
                    ) : (
                      <button
                        className="cex"
                        title={`Take ${t.name} off the list. You hold no copy of it here, so nothing moves.`}
                        onClick={() => removeTarget(t.tcgdexId)}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
                {state.targets.length === 0 && (
                  <div className="cehint u">No cards yet. Search above to build the set list.</div>
                )}
              </div>
              {state.targets.some((t) => t.owned) && (
                <div className="hint u">
                  A card you own cannot be dropped from the list here — the physical card would stay
                  in the binder with nothing tracking it. Close this and use Remove on the card to
                  give it a new home.
                </div>
              )}
            </>
          )}

          <div className="cesave">
            <span className="hk u">
              {state.mode === "open"
                ? "Open collections log cards one at a time on the card."
                : `${state.targets.length} card${state.targets.length === 1 ? "" : "s"} in the list`}
            </span>
            <button
              className="btn btn-primary u"
              style={{ marginLeft: "auto" }}
              disabled={!valid || busy}
              onClick={onSubmit}
            >
              {busy ? "Saving…" : "Save collection"}
            </button>
          </div>
          <div className="hint u">
            Saving is instant across the app — a new binder joins the binder list and this
            collection joins the placement picker.
          </div>
        </div>
      </div>
    </div>
  );
}

function LogCardModal(props: {
  collection: CollectionView;
  busy: boolean;
  onClose: () => void;
  onLog: (tcgdexId: string) => void;
}) {
  const { collection, busy, onClose, onLog } = props;
  const [pick, setPick] = useState<LookupCard | null>(null);
  return (
    <div className="veil on" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dsheet panel" role="dialog" aria-modal="true">
        <div className="cap">
          <span className="t u">Log a card</span>
          <span className="n u">{collection.name}</span>
          <button className="btn u" onClick={onClose} style={{ background: "var(--panel-2)" }}>
            Close
          </button>
        </div>
        <div className="body">
          <div className="cerow-h u">
            Find the card — logging it is a placement into{" "}
            {collection.binderNames[0] ?? "the binder"}, not a tally bump.
          </div>
          <CardLookup search={searchCatalog} onPick={setPick} placeholder="Search the catalog…" />
          {pick && (
            <div className="cerow own" style={{ marginTop: 10 }}>
              <span className="cet">
                <CardFace name={pick.name} imageUrl={pick.imageUrl} size="s" />
              </span>
              <span className="cei">
                <b>{pick.name}</b>
                <i>
                  {pick.setName ?? ""}
                  {pick.localId ? ` · ${pick.localId}` : ""}
                </i>
              </span>
              <button className="cex" onClick={() => setPick(null)}>
                ✕
              </button>
            </div>
          )}
          <div className="loclock u" style={{ marginTop: 10 }}>
            ▤ {collection.binderNames[0] ?? "No binder"} · {collection.name}
          </div>
          <div className="cesave">
            <button
              className="btn btn-primary u"
              style={{ marginLeft: "auto" }}
              disabled={!pick || busy}
              onClick={() => pick && onLog(pick.tcgdexId)}
            >
              {busy ? "Logging…" : "Log it ▶"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
