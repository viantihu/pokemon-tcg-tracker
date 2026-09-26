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

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { MoveDestination, MoveOptions } from "@/lib/line/types";
import { formatCollectorNumber } from "@/lib/catalog/collector-number";
import {
  buildWishlistCopyText,
  buildWishlistCsv,
  encodeDexCsvUtf16le,
  finiteProgress,
  type WishlistBinderGroup,
} from "@/lib/surfaces";
import { BandChip } from "../_components/BandChip";
import { isUnreached, LOST, reach } from "../_components/reach";
import { CardFace } from "../_components/CardFace";
import { cardCaption } from "../_components/CardLightbox";
import { CardResultsGrid } from "../_components/CardResultsGrid";
import { MoveOverlay } from "../_components/MoveOverlay";
import type { LookupCard } from "../plan/plan-types";
import { createAutosaveScheduler, flushBeforeNavigate } from "./autosave";
import {
  deleteCollection,
  loadCollHub,
  logCardIntoCollection,
  rebindCollectionWithMove,
  removeCardFromCollection,
  removeCopyFromApp,
  saveCollection,
  searchCatalog,
  setCollectionMode,
  wishlistCollectionCard,
} from "./actions";
import type {
  CollectionCardView,
  CollectionInput,
  CollectionView,
  RebindRemedy,
  SaveResult,
  CollHubData,
} from "./coll-types";
import { RemoveCopyButton } from "../_components/RemoveCopyButton";

/**
 * What she reads when a save cannot reach the server at all (UIL-106) — the same family as the Sync page's
 * (#349). A thrown save may or may not have landed, so none of these says "nothing was saved".
 */
export const COLL_LOST = {
  autosave:
    "The app was updated while this page was open, or the connection dropped, so your last change may " +
    "not have been saved. It will be sent again with your next change; if this keeps happening, reload " +
    "the page.",
  close:
    "The app was updated while this page was open, or the connection dropped, so your last change may " +
    "not have been saved. Press Close again to close without it, or reload the page.",
  change:
    "The app was updated while this page was open, or the connection dropped. Reload the page to see " +
    "whether that change went through.",
} as const;

type Tab = "coll" | "wish";

/** A card held in the editor's working target list. */
interface DraftTarget {
  tcgdexId: string;
  name: string;
  setName: string | null;
  localId: string | null;
  /** Printed set total, so the row can show "099/182" (UIL-077). */
  setCardCountOfficial: number | null;
  /**
   * She holds a copy of this card in the collection's binder. Dropping it from the list here would
   * strand that physical copy, so the row's "✕" is not offered (UIL-014 defect 2) — removal is a move,
   * done from the card in the grid. Always false for a card added in this session: ownership is
   * derived server-side, so a freshly-added target is only known to be owned after the next load, and
   * `saveCollection` refuses the drop regardless.
   */
  owned: boolean;
  /** For the inline Move sheet (UIL-043): the face and the band the sheet shows. */
  imageUrl: string | null;
  bandKey: string;
}

/** The card whose new home she is picking, with the collection it is leaving. */
interface RemovalTarget {
  collection: CollectionView;
  card: CollectionCardView;
}

interface EditorState {
  /** Always a real row id (UIL-038) — a draft is created server-side the moment the editor opens. */
  id: string;
  /**
   * A collection created THIS session and not yet explicitly finished. Drives the reversibility
   * split: everything autosaves for a brand-new draft (nothing has real placement consequences yet),
   * but editing an EXISTING collection keeps target-removal and binder-rebind as their own deliberate
   * click — those can strand real shelved copies, so they get the same immediate, self-contained
   * confirm-or-refuse shape the Collections page's own Remove button already uses.
   */
  isNewDraft: boolean;
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
  const searchParams = useSearchParams();
  const editParam = searchParams.get("edit");
  const consumedEditParam = useRef<string | null>(null);

  // Reused by mutation handlers. setState lands only inside .then/.catch (never synchronously).
  const refresh = useCallback(
    () =>
      // Through `reach` (UIL-109): a failed load says so in the shared words, never the raw error text.
      reach(() => loadCollHub(), LOST.load).then((d) =>
        isUnreached(d) ? setError(d.error) : setData(d),
      ),
    [],
  );

  useEffect(() => {
    let alive = true;
    void reach(() => loadCollHub(), LOST.load).then((d) => {
      if (!alive) return;
      if (isUnreached(d)) setError(d.error);
      else setData(d);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Returning from "Search & add cards" (UIL-039) reopens the editor on the same collection rather
  // than dropping her back on the plain list — the link out of the editor and the link back in have
  // to agree, or "Back to collection" is a worse regression than the inline add it replaces. Fires
  // once per `edit` value: closing the editor herself afterward must not reopen it.
  useEffect(() => {
    if (!data || !editParam || consumedEditParam.current === editParam) return;
    consumedEditParam.current = editParam;
    const col = data.collections.find((c) => c.id === editParam);
    if (col) openEdit(col);
  }, [data, editParam]);

  async function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(true);
    setError(null);
    try {
      // Through `reach` (UIL-109): every action `run` takes returns `{ ok }` for its own failures, so a throw
      // is a call that never arrived, said in the shared words rather than the raw error text.
      const res = await reach(fn, LOST.action);
      if (!res.ok) setError(res.error ?? "Something went wrong.");
      else await refresh();
      return res.ok;
    } finally {
      setBusy(false);
    }
  }

  /**
   * UIL-038: the draft exists server-side from the moment the editor opens, not only after an
   * explicit "Save collection" click — an interruption before that click used to lose everything
   * typed, with nothing server-side to resume. Creating it empty (`draft: true`) and letting the
   * editor's autosave take over from here is what closes that gap.
   */
  async function openNew() {
    const first = data?.specialtyBinders[0]?.id ?? "__new";
    // Through `reach` (UIL-106): a call that never answers used to leave "New collection" doing nothing, silently.
    const res = await reach(
      () =>
        saveCollection(
          {
            id: null,
            name: "",
            mode: "finite",
            binderId: first,
            newBinderName: "",
            targetTcgdexIds: [],
          },
          { draft: true },
        ),
      LOST.action,
    );
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setEditor({
      id: res.id,
      isNewDraft: true,
      name: "",
      mode: "finite",
      binderId: first,
      newBinderName: "",
      targets: [],
    });
    await refresh(); // so it shows up (marked incomplete) if she leaves without finishing it
  }
  function openEdit(c: CollectionView) {
    setEditor({
      id: c.id,
      isNewDraft: false,
      name: c.name,
      mode: c.mode,
      binderId: c.binderIds[0] ?? "__new",
      newBinderName: "",
      targets: c.cards.map((k) => ({
        tcgdexId: k.tcgdexId,
        name: k.name,
        setName: k.setName,
        localId: k.localId,
        setCardCountOfficial: k.setCardCountOfficial,
        owned: k.owned,
        imageUrl: k.imageUrl,
        bandKey: k.bandKey,
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

  /**
   * UIL-089: the copy is gone, not moved. `run` refreshes the hub, so the row drops to "not owned" (or off
   * a finite list's held set) without the screen holding a card she has told it she does not have.
   */
  async function onRemoveCopyFromApp(copyId: string) {
    await run(() => removeCopyFromApp(copyId));
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

  /**
   * UIL-038/UIL-009: closing no longer needs a "discard this?" confirmation — autosave already has
   * whatever was typed. The only remaining question is whether a still-completely-empty draft is
   * worth keeping (delete it) or was actually built up (keep it, refreshed into the list).
   */
  async function closeEditor(id: string, deleteIfEmpty: boolean) {
    if (deleteIfEmpty) await run(() => deleteCollection(id));
    else await refresh();
    setEditor(null);
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
          onRemoveCopy={onRemoveCopyFromApp}
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
          onClose={(deleteIfEmpty) => closeEditor(editor.id, deleteIfEmpty)}
          onSubmit={submitEditor}
          moveOptions={data?.moveOptions ?? null}
          onMoveOwned={(tcgdexId, dest) =>
            run(() => removeCardFromCollection(editor.id, tcgdexId, dest))
          }
          onRebindMove={async (toBinderId) => {
            // Not through `run`: the refusal this remedies lives on the editor's own bar, so its
            // outcome — success or the error that replaces it — belongs there too, not on the hub's.
            setBusy(true);
            try {
              // Through `reach` (UIL-106): a call that never answers ends on the editor's bar as a message.
              const res = await reach(
                () => rebindCollectionWithMove(editor.id, toBinderId),
                LOST.action,
              );
              if (res.ok) await refresh();
              return res;
            } finally {
              setBusy(false);
            }
          }}
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
            localId: formatCollectorNumber(
              removeFor.card.localId,
              removeFor.card.setCardCountOfficial,
            ),
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

/**
 * UIL-059: "If the user left the collections page expanded, it must stay expanded" — her issue-log
 * entry says "across visits", and she uses the app across days, not one sitting. localStorage, not
 * sessionStorage: a sessionStorage entry clears the moment the tab closes, which would silently
 * un-fix this the next time she opens the app. No resume concept for this page otherwise — just the
 * one Set, read back as-is rather than validated against a stamp. A stale id (a deleted collection) is
 * harmless: it simply never matches anything in `data.collections`, the same way a brand-new
 * collection's id is harmlessly ABSENT from an old stored set and so opens expanded, exactly as it
 * does today with no persistence at all.
 */
const COLLAPSED_KEY = "binderops.coll-collapsed.v1";

function readStoredCollapsed(): Set<string> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) return null;
    return new Set(parsed);
  } catch {
    return null; // corrupt entry, quota error, or storage disabled — fall back to the old default
  }
}

function writeStoredCollapsed(collapsed: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    // Full or unavailable storage just means it won't resume next time; the page itself is unaffected.
  }
}

export function CollectionsView(props: {
  data: CollHubData;
  busy: boolean;
  onNew: () => void;
  onEdit: (c: CollectionView) => void;
  onMode: (id: string, mode: "finite" | "open") => void;
  onDelete: (id: string) => void;
  onLog: (c: CollectionView) => void;
  onWishlist: (collectionId: string, tcgdexId: string) => void;
  onRemove: (c: CollectionView, k: CollectionCardView) => void;
  /** UIL-089: remove the COPY from the app, distinct from `onRemove`'s collection-level move. */
  onRemoveCopy: (copyId: string) => void;
}) {
  const { data, busy, onNew, onEdit, onMode, onDelete, onLog, onWishlist, onRemove, onRemoveCopy } =
    props;
  // Defaults every collection already on the page to FOLDED (UIL-034): unlike the Haul Plan, which
  // defaults all-expanded because she works one band at a time, Collections is a browse surface — and
  // a finite set list is 200-300+ CardFace tiles, the same "fine at three cards, wrong at real scale"
  // shape #78 fixed for the worklist. Lazy initializer runs once, so a collection created later (via
  // "+ New collection") is not in this Set and opens expanded, which is what you want right after
  // creating one. Restored from localStorage when she has a stored set from a previous visit
  // (UIL-059) — first-ever visit (nothing stored yet) still falls back to all-current-ids-collapsed.
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => readStoredCollapsed() ?? new Set(data.collections.map((c) => c.id)),
  );
  useEffect(() => {
    writeStoredCollapsed(collapsed);
  }, [collapsed]);
  function toggleCollapse(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  return (
    <div className="collwrap">
      <div className="collnew">
        <button className="newcollbtn u" onClick={onNew} disabled={busy}>
          ＋ New collection
        </button>
      </div>

      {data.collections.length > 1 && (
        <div className="worktools">
          <span className="hk">COLLECTIONS</span>
          <button
            type="button"
            className="btn"
            onClick={() => setCollapsed(new Set(data.collections.map((c) => c.id)))}
            disabled={collapsed.size === data.collections.length}
          >
            Collapse all
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setCollapsed(new Set())}
            disabled={collapsed.size === 0}
          >
            Expand all
          </button>
        </div>
      )}

      {data.collections.length === 0 && (
        <div className="stub panel">
          <p>No collections yet. Create one — it becomes a placement target immediately.</p>
        </div>
      )}

      {data.collections.map((c) => (
        <CollectionCard
          key={c.id}
          collection={c}
          busy={busy}
          collapsed={collapsed.has(c.id)}
          onToggleCollapse={() => toggleCollapse(c.id)}
          onEdit={onEdit}
          onMode={onMode}
          onDelete={onDelete}
          onLog={onLog}
          onWishlist={onWishlist}
          onRemove={onRemove}
          onRemoveCopy={onRemoveCopy}
        />
      ))}
      <div className="foot">FINITE · A SET LIST YOU CHASE. OPEN · A RUNNING COUNT WITH NO END.</div>
    </div>
  );
}

/**
 * One collection, foldable (UIL-034 — the same mechanism as `PlanScreen`'s `BandSection` / UIL-018: a
 * folded collection renders NOTHING below its header, not CSS-hidden, so a 200-300 card finite set
 * list costs a header's worth of markup rather than a page's worth. The progress summary moves into
 * the header itself so it survives folding — per the issue log, that summary is the reason to glance
 * at the page at all even when collapsed.
 */
export function CollectionCard(props: {
  collection: CollectionView;
  busy: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onEdit: (c: CollectionView) => void;
  onMode: (id: string, mode: "finite" | "open") => void;
  onDelete: (id: string) => void;
  onLog: (c: CollectionView) => void;
  onWishlist: (collectionId: string, tcgdexId: string) => void;
  onRemove: (c: CollectionView, k: CollectionCardView) => void;
  /** UIL-089: remove the COPY from the app, distinct from `onRemove`'s collection-level move. */
  onRemoveCopy: (copyId: string) => void;
}) {
  const {
    collection: c,
    busy,
    collapsed,
    onToggleCollapse,
    onEdit,
    onMode,
    onDelete,
    onLog,
    onWishlist,
    onRemove,
    onRemoveCopy,
  } = props;
  const fin = c.mode === "finite";
  const prog = finiteProgress(c.totalCount, c.ownedCount);
  return (
    <div className={"collcard panel" + (collapsed ? " folded" : "")}>
      <div className="collhead">
        <button
          type="button"
          className="collfold"
          aria-expanded={!collapsed}
          onClick={onToggleCollapse}
          title={collapsed ? `Show ${c.name}` : `Hide ${c.name}`}
        >
          <span aria-hidden>{collapsed ? "▶" : "▼"}</span>
        </button>
        <div style={{ minWidth: 0 }}>
          <div className="collname">
            {c.name || "Untitled collection"}
            {c.incomplete && (
              <span
                className="cpill draft u"
                title="Still missing a name or a binder — pick up where you left off with Edit."
              >
                Draft
              </span>
            )}
          </div>
          <div className="collmeta u">
            {c.binderNames.join(" · ") || "No binder yet"} ·{" "}
            {fin ? "Finite set list" : "Open running count"} ·{" "}
            {fin ? `${prog.owned} / ${prog.total} owned · ${prog.pct}%` : `${c.totalCount} logged`}
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

      {collapsed ? null : fin ? (
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
                <CardFace
                  name={k.name}
                  tcgdexId={k.tcgdexId}
                  imageUrl={k.imageUrl}
                  size="m"
                  zoomable
                  caption={cardCaption(
                    k.setName,
                    formatCollectorNumber(k.localId, k.setCardCountOfficial),
                  )}
                />
                <div className="cn u">{k.name}</div>
                {formatCollectorNumber(k.localId, k.setCardCountOfficial) ? (
                  <div className="cno">
                    {formatCollectorNumber(k.localId, k.setCardCountOfficial)}
                  </div>
                ) : null}
                {k.owned ? (
                  <>
                    <span className="cpill have u">Owned</span>
                    <RemoveCardButton card={k} busy={busy} onClick={() => onRemove(c, k)} />
                    <NotMineButton card={k} busy={busy} onRemoveCopy={onRemoveCopy} />
                    <NotMineButton card={k} busy={busy} onRemoveCopy={onRemoveCopy} />
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
              ＋ Add a card
            </button>
          </div>
          <div className="cprog u">Open collection · no target, just a running count</div>
          {c.cards.length > 0 && (
            <div className="cgrid">
              {c.cards.map((k) => (
                <div key={k.tcgdexId} className="ccard">
                  <CardFace
                    name={k.name}
                    tcgdexId={k.tcgdexId}
                    imageUrl={k.imageUrl}
                    size="m"
                    zoomable
                    caption={cardCaption(
                      k.setName,
                      formatCollectorNumber(k.localId, k.setCardCountOfficial),
                    )}
                  />
                  <div className="cn u">{k.name}</div>
                  {formatCollectorNumber(k.localId, k.setCardCountOfficial) ? (
                    <div className="cno">
                      {formatCollectorNumber(k.localId, k.setCardCountOfficial)}
                    </div>
                  ) : null}
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
}

/**
 * The per-card removal control (UIL-014). Labelled with the count when the collection's binder holds
 * more than one copy of the printing, because all of them move: membership is per catalog card, so
 * leaving one behind would leave it shelved in the collection's binder and on no list — the exact
 * orphan this fix exists to prevent.
 */
/**
 * TWO different removals sit on this row, and the difference is the point (UIL-089).
 *
 * "Remove ▸" takes the card off this collection's list and re-homes the copies — a MOVE, not a delete
 * (UIL-014). "Not mine" means she does not have the card at all: that one deletes the copy.
 *
 * Offered only when she holds exactly ONE copy here. With two or more, "remove this card" has no single
 * answer — Lookup shows each copy as its own row with its own button, which is where an ambiguous case
 * belongs. Inventing a bulk delete here would be this action guessing which cards she no longer owns.
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

/** The "I do not have this card" button, beside the collection-level one (UIL-089). */
function NotMineButton({
  card,
  busy,
  onRemoveCopy,
}: {
  card: CollectionCardView;
  busy: boolean;
  onRemoveCopy: (copyId: string) => void;
}) {
  if (card.copyIds.length !== 1) return null;
  return (
    <RemoveCopyButton
      onRemove={() => onRemoveCopy(card.copyIds[0])}
      busy={busy}
      label="Not mine"
      what={`${card.name} from your collection`}
    />
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

      <div className="foot">GROUPED BY BINDER → LINE · CSV EXPORTS BACK INTO DEX FOR SCANNING</div>
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
                  {e.chosen &&
                  formatCollectorNumber(e.chosen.localId, e.chosen.setCardCountOfficial) ? (
                    <span className="no" style={{ marginLeft: 8 }}>
                      {formatCollectorNumber(e.chosen.localId, e.chosen.setCardCountOfficial)}
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
                      .map((a) => {
                        const n = formatCollectorNumber(a.localId, a.setCardCountOfficial);
                        return `${a.name}${n ? ` ${n}` : ""}`;
                      })
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

/** `CollectionInput` built from the editor's working state — the shape every save call sends. */
function inputFrom(state: EditorState): CollectionInput {
  return {
    id: state.id,
    name: state.name,
    mode: state.mode,
    binderId: state.binderId,
    newBinderName: state.newBinderName,
    targetTcgdexIds: state.targets.map((t) => t.tcgdexId),
  };
}

/** A binder pick that hasn't named its new binder yet has nothing resolvable to send. */
function resolvable(state: EditorState): boolean {
  return state.binderId !== "__new" || state.newBinderName.trim().length > 0;
}

/**
 * The remedy button's label IS the confirmation (UIL-040 step 2), so it says exactly what the click
 * does: how many cards, to which binder. When every blocked card stays (all chased by another
 * collection still in the old binder) nothing moves and the label says so instead.
 */
export function rebindButtonLabel(remedy: RebindRemedy): string {
  const n = remedy.copyCount;
  if (n > 0) return `Move ${n} card${n === 1 ? "" : "s"} to ${remedy.toBinderName} and rebind`;
  const s = remedy.staying.reduce((k, c) => k + c.copyCount, 0);
  const from = remedy.fromBinderNames.join(", ") || "the old binder";
  return `Rebind and leave ${s} card${s === 1 ? "" : "s"} in ${from}`;
}

export function CollectionEditor(props: {
  state: EditorState;
  binders: { id: string; name: string }[];
  busy: boolean;
  onChange: (s: EditorState) => void;
  onClose: (deleteIfEmpty: boolean) => void;
  onSubmit: () => void;
  /**
   * UIL-043: the inline Move from an owned target's row. `moveOptions` feeds the shared move sheet;
   * `onMoveOwned` performs the same removal-as-a-move the card's own Remove button does (UIL-014) and
   * resolves true when it landed, at which point the row leaves the list here too.
   */
  moveOptions: MoveOptions | null;
  onMoveOwned: (tcgdexId: string, dest: MoveDestination) => Promise<boolean>;
  /**
   * UIL-040 step 2: the remedy to a refused binder rebind — move the collection's shelved copies into
   * the new binder and re-point the collection, as one transaction. Resolves with the server's own
   * outcome so a failure's reason can replace the refusal on the same bar.
   */
  onRebindMove: (toBinderId: string) => Promise<SaveResult>;
}) {
  const {
    state,
    binders,
    busy,
    onChange,
    onClose,
    onSubmit,
    moveOptions,
    onMoveOwned,
    onRebindMove,
  } = props;
  /** The owned target whose Move sheet is open (UIL-043). */
  const [moveFor, setMoveFor] = useState<DraftTarget | null>(null);
  const isNew = state.isNewDraft;
  const router = useRouter();
  const [searchNavigating, setSearchNavigating] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  /**
   * UIL-040 step 2: the refusal's remedy, when the server offered one. Only the binder it names is
   * applied on success — to the editor's CURRENT state, never a snapshot from refusal time, because she
   * can keep typing between the refusal and the click and those edits must survive (FSD-1's review; the
   * same shape as the UIL-038 follow-up). `latest` is that current state, read at completion time.
   */
  const [remedy, setRemedy] = useState<RebindRemedy | null>(null);
  const [rebinding, setRebinding] = useState(false);
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  }, [state]);

  // Captured once per mount (the editor remounts fresh each time it opens) — the baseline "untouched"
  // binder pick, for deciding on close whether a still-empty NEW draft is worth keeping.
  const [initialBinderId] = useState(state.binderId);

  /**
   * UIL-038: one scheduler per editing session, created once when the editor mounts. Debounced +
   * serialized (see `./autosave`) — passive edits (name, mode, target adds) flow through it and never
   * block typing on a round trip.
   */
  /** Close was pressed once over an unsaved edit and told so; a second press closes anyway (UIL-106). */
  const [closeOverUnsaved, setCloseOverUnsaved] = useState(false);
  const [autosave] = useState(() =>
    createAutosaveScheduler<EditorState>(
      async (s) => {
        const res = await saveCollection(inputFrom(s), { draft: true });
        if (!res.ok)
          setInlineError(res.error); // rare here — these fields carry no stranding guard
        // A save that lands clears the "may not have been saved" it would otherwise leave standing.
        else {
          setInlineError((e) => (e === COLL_LOST.autosave || e === COLL_LOST.close ? null : e));
          setCloseOverUnsaved(false);
        }
      },
      600,
      // UIL-106: a THROWN save no longer breaks the queue; it is kept, and she is told.
      () => setInlineError(COLL_LOST.autosave),
    ),
  );

  /** Passive: update the UI immediately, autosave in the background. Safe for any field a fresh
   * draft can be missing — `draft: true` tolerates it — because nothing routed here ever touches an
   * EXISTING collection's already-resolved binder (see the reversibility split below). */
  function passiveChange(next: EditorState) {
    onChange(next);
    autosave.schedule(next);
  }

  /**
   * Deliberate: target removal and a binder rebind on an EXISTING collection, each its own click —
   * not the passive debounce, not deferred behind "Save collection". Both can strand real shelved
   * copies (UIL-014, UIL-040), so the UI only updates once the server has actually accepted it; on
   * refusal the click is a no-op and the reason shows right here.
   */
  async function immediateChange(next: EditorState) {
    await autosave.flush(); // keep this in order behind anything already mid-save
    let res: Awaited<ReturnType<typeof saveCollection>>;
    try {
      res = await saveCollection(inputFrom(next), { draft: true });
    } catch {
      // UIL-106: the call never reached the server, or never answered. The UI was not changed.
      setInlineError(COLL_LOST.change);
      return;
    }
    if (res.ok) {
      setInlineError(null);
      setRemedy(null);
      onChange(next);
    } else {
      setInlineError(res.error);
      // UIL-040 step 2: a refused rebind names its remedy. The binder she picked is NOT applied to the
      // editor until the server has actually moved the cards and re-pointed the collection.
      setRemedy(res.remedy ?? null);
    }
  }

  /**
   * The remedy's click (UIL-040 step 2). The button's label is the confirmation — it names the count and
   * the destination — so there is no second question. On success the refusal clears and the editor
   * settles on the binder she picked; on failure the server's reason replaces the refusal text and the
   * button goes away (nothing moved — the write is one transaction), so a re-pick re-derives the offer.
   */
  async function confirmRebindMove() {
    if (!remedy) return;
    const toBinderId = remedy.toBinderId;
    setRebinding(true);
    try {
      // Flush first, as `immediateChange` does: a passive edit still debounced from the last 600 ms
      // carries the OLD binder, and landing after the rebind it would either re-point the collection
      // back or trip the guard against the copies now in the new binder (FSD-1's review).
      await autosave.flush();
      const res = await onRebindMove(toBinderId);
      if (res.ok) {
        setInlineError(null);
        // The current state with only the binder changed — never a snapshot from refusal time.
        onChange({ ...latest.current, binderId: toBinderId, newBinderName: "" });
      } else {
        setInlineError(res.error);
      }
      setRemedy(null);
    } finally {
      setRebinding(false);
    }
  }

  const requestClose = useCallback(async () => {
    if (rebinding) return; // UIL-040 step 2: a move-and-rebind is in flight; its outcome lands here
    const saved = await autosave.flush();
    // UIL-106: never stranded, never silent. The first press over an unsaved edit says so and stays open;
    // the second closes anyway.
    if (!saved && !closeOverUnsaved) {
      setCloseOverUnsaved(true);
      setInlineError(COLL_LOST.close);
      return;
    }
    const empty =
      state.isNewDraft &&
      state.name.trim().length === 0 &&
      state.targets.length === 0 &&
      state.binderId === initialBinderId;
    onClose(empty);
  }, [autosave, state, initialBinderId, onClose, rebinding, closeOverUnsaved]);

  /**
   * UIL-038 follow-up (QA on #155): a plain `<Link>` here navigated straight through any pending
   * debounce, so a name edit made in the last 600ms before the click was lost — a data-loss path
   * inside the very feature meant to prevent data loss. Flush-and-await, not flush-and-navigate: the
   * search page reopens the editor from server state, so an unresolved write racing that reload risks
   * the same loss again; a beat of latency is cheaper than reopening the window it exists to close.
   */
  async function goSearchAndAdd() {
    setSearchNavigating(true);
    const saved = await flushBeforeNavigate(autosave, () =>
      router.push(`/coll/search?collectionId=${state.id}`),
    );
    // UIL-106: it stays here rather than reopening the editor from server state without her edit.
    if (!saved) setSearchNavigating(false);
  }

  // Escape is the only keyboard way out of a modal; it routes through the same close path.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  /**
   * Drop a card from the chase list. UIL-014 defect 2: this only ever edited the draft, and
   * `saveCollection` persisted it as `target_catalog_card_ids` without touching the `copy` row — so for
   * a card she owns it silently produced an untracked copy, still shelved in the collection's binder
   * but invisible in every collection and wishlist view. Owned rows no longer offer it (the server
   * refuses the drop either way); their removal is a move, from the card in the collection's grid.
   *
   * A brand-new draft has nothing shelved in it yet, so removal there is passive like everything
   * else; an existing collection's list can have real owned cards on it, so it's deliberate.
   */
  function removeTarget(id: string) {
    if (state.targets.find((t) => t.tcgdexId === id)?.owned) return;
    const next = { ...state, targets: state.targets.filter((t) => t.tcgdexId !== id) };
    if (isNew) passiveChange(next);
    else immediateChange(next);
  }

  /** Picking an existing binder is one click either way — deliberate for an existing collection. */
  function pickBinder(binderId: string) {
    const next = { ...state, binderId };
    if (isNew) passiveChange(next);
    else immediateChange(next);
  }

  /**
   * "+ New binder" only stages the chip locally: nothing is resolvable until she names it, and
   * sending an unresolved pick in draft mode would leave `current_binder_ids` empty — fine for a new
   * draft that has none yet, but not for an existing collection that already has a real one.
   */
  function pickNewBinderChip() {
    onChange({ ...state, binderId: "__new" });
  }

  function newBinderNameChange(value: string) {
    const next = { ...state, binderId: "__new", newBinderName: value };
    onChange(next);
    if (isNew && resolvable(next)) autosave.schedule(next);
  }

  function newBinderNameBlur() {
    if (!isNew && resolvable(state)) immediateChange(state);
  }

  const valid =
    state.name.trim().length > 0 &&
    (state.binderId !== "__new" || state.newBinderName.trim().length > 0);

  // No backdrop onClick: a click meant for something behind the modal shouldn't be able to close it.
  return (
    <>
      <div className="veil on">
        <div className="dsheet panel" role="dialog" aria-modal="true">
          <div className="cap">
            <span className="t u">{isNew ? "New collection" : "Edit collection"}</span>
            <button
              className="btn u"
              onClick={requestClose}
              disabled={rebinding}
              style={{ background: "var(--panel-2)" }}
            >
              Close
            </button>
          </div>
          <div className="body">
            {inlineError && (
              <div className="alertbar" role="alert" style={{ background: "#FFD9DF" }}>
                <span>!</span>
                <b>{inlineError}</b>
                {remedy && (
                  /* UIL-040 step 2: the remedy on the same bar as the refusal, never a dead end. The
                     label carries the count and the destination, so the click IS the confirmation. */
                  <button
                    type="button"
                    className="btn u"
                    /* Shrinkable and left-aligned on purpose: at 375 the label wraps to two lines inside
                       the bar; a non-shrinking button overflowed it by 43px (harness, 2026-09-20), and a
                       wrapped <button> centres its text by default (the UIL-070 lesson). */
                    style={{ marginLeft: "auto", maxWidth: "100%", textAlign: "left" }}
                    disabled={busy || rebinding}
                    onClick={confirmRebindMove}
                  >
                    {rebinding ? "Moving…" : rebindButtonLabel(remedy)}
                  </button>
                )}
              </div>
            )}
            {remedy && remedy.staying.length > 0 && (
              <div className="hint u">
                Stays in {remedy.fromBinderNames.join(", ")}:{" "}
                {remedy.staying
                  .map((s) => `${s.name} (also chased by ${s.alsoChasedBy.join(", ")})`)
                  .join("; ")}
                .
              </div>
            )}

            <label className="orow">
              <div className="ol u">Name</div>
              <input
                className="field"
                value={state.name}
                onChange={(e) => passiveChange({ ...state, name: e.target.value })}
                placeholder="e.g. Matsuno illustrations"
              />
            </label>

            <div className="orow">
              <div className="ol u">Mode</div>
              <div className="modetoggle" style={{ marginLeft: 0 }}>
                <button
                  className={"modebtn u" + (state.mode === "finite" ? " on" : "")}
                  onClick={() => passiveChange({ ...state, mode: "finite" })}
                >
                  Finite
                </button>
                <button
                  className={"modebtn u" + (state.mode === "open" ? " on" : "")}
                  onClick={() => passiveChange({ ...state, mode: "open" })}
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
                    onClick={() => pickBinder(b.id)}
                  >
                    {b.name}
                  </button>
                ))}
                <button
                  className={"ochip u" + (state.binderId === "__new" ? " on" : "")}
                  onClick={pickNewBinderChip}
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
                  onChange={(e) => newBinderNameChange(e.target.value)}
                  onBlur={newBinderNameBlur}
                  placeholder="e.g. Specialty Binder B"
                />
              </label>
            )}

            {state.mode === "finite" && (
              <>
                <div className="cerow-h u">
                  Set list — the cards you chase. Owned status is derived from your shelf.
                </div>
                <button
                  type="button"
                  className="btn u"
                  onClick={goSearchAndAdd}
                  disabled={searchNavigating}
                >
                  {searchNavigating ? "Saving…" : "Search & add cards →"}
                </button>
                <div className="celist">
                  {state.targets.map((t) => (
                    <div key={t.tcgdexId} className={"cerow" + (t.owned ? " own" : "")}>
                      <span className="cei">
                        <b>{t.name}</b>
                        <i>
                          {t.setName ?? ""}
                          {formatCollectorNumber(t.localId, t.setCardCountOfficial)
                            ? ` · ${formatCollectorNumber(t.localId, t.setCardCountOfficial)}`
                            : ""}
                        </i>
                      </span>
                      {t.owned ? (
                        /* UIL-014 as Karvi chose it: no ✕ on an owned row, and the server refuses the
                         drop regardless. UIL-043 adds the shortcut beside it — the same Move the card's
                         Remove button opens, so she need not leave the editor to give it a new home. */
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                          <span className="cpill have u" style={{ marginTop: 0 }}>
                            Owned
                          </span>
                          <button
                            type="button"
                            className="movebtn u"
                            disabled={busy || !moveOptions || state.binderId === "__new"}
                            title={`Give ${t.name} a new home. It leaves this list as it goes.`}
                            onClick={() => setMoveFor(t)}
                          >
                            ↔ Move ▸
                          </button>
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
                    <div className="cehint u">
                      No cards yet. Search &amp; add cards above to build the set list.
                    </div>
                  )}
                </div>
                {state.targets.some((t) => t.owned) && (
                  <div className="hint u">
                    A card you own cannot be dropped from the list here — the physical card would
                    stay in the binder with nothing tracking it. Use Move on its row to give it a
                    new home; it leaves the list as it goes.
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
                onClick={async () => {
                  // UIL-106: not confirmed over an edit that may not have been saved; pressing again retries.
                  if (!(await autosave.flush())) return;
                  onSubmit();
                }}
              >
                {busy ? "Saving…" : "Save collection"}
              </button>
            </div>
            <div className="hint u">
              Everything here is already saved as you go — Save collection just confirms
              you&rsquo;re done. A new binder joins the binder list and this collection joins the
              placement picker the moment it has a name.
            </div>
          </div>
        </div>
      </div>
      {moveFor && moveOptions && (
        <MoveOverlay
          card={{
            copyId: "",
            name: moveFor.name,
            localId: moveFor.localId,
            setCardCountOfficial: moveFor.setCardCountOfficial,
            imageUrl: moveFor.imageUrl,
            bandKey: moveFor.bandKey,
            currentLabel: `${binders.find((b) => b.id === state.binderId)?.name ?? "No binder"} · ${state.name || "Untitled collection"}`,
            // The collection's own binder pre-selected (Senior BA's call for UIL-043): she sees where the
            // card is and changes only what she means to. Shelf-shaped only to carry the binder id; the
            // panel derives the specialty binder's collection mode from the binder itself.
            initial: {
              kind: "shelf",
              binderId: state.binderId,
              half: "front",
              band: moveFor.bandKey,
            },
          }}
          options={moveOptions}
          onClose={() => setMoveFor(null)}
          onConfirm={async (dest: MoveDestination) => {
            const ok = await onMoveOwned(moveFor.tcgdexId, dest);
            if (ok) {
              setMoveFor(null);
              // The server subtracted the target as part of the move (lib/coll/remove.ts); mirror it.
              onChange({
                ...state,
                targets: state.targets.filter((x) => x.tcgdexId !== moveFor.tcgdexId),
              });
            }
          }}
        />
      )}
    </>
  );
}

export function LogCardModal(props: {
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
          <span className="t u">Add a card</span>
          <span className="n u">{collection.name}</span>
          <button className="btn u" onClick={onClose} style={{ background: "var(--panel-2)" }}>
            Close
          </button>
        </div>
        <div className="body">
          {/* UIL-098: this used to create inventory for a card she did not own — Karvi: "Adding cards that
              I don't own to a collection should add them to the wishlist, not into inventory itself." So
              it says what each case does: nothing here ever adds a card to her collection. */}
          <div className="cerow-h u">
            Find the card. If you already have it in {collection.binderNames[0] ?? "this binder"},
            it joins this collection. If you don&apos;t own it yet, it goes on your wishlist — it is
            never added to your inventory.
          </div>
          <CardResultsGrid
            search={searchCatalog}
            onPick={setPick}
            placeholder="Search the catalog…"
          />
          {pick && (
            <div className="cerow own" style={{ marginTop: 10 }}>
              <span className="cet">
                <CardFace
                  name={pick.name}
                  tcgdexId={pick.tcgdexId}
                  imageUrl={pick.imageUrl}
                  size="s"
                  zoomable
                  caption={cardCaption(
                    pick.setName,
                    formatCollectorNumber(pick.localId, pick.setCardCountOfficial),
                  )}
                />
              </span>
              <span className="cei">
                <b>{pick.name}</b>
                <i>
                  {pick.setName ?? ""}
                  {formatCollectorNumber(pick.localId, pick.setCardCountOfficial)
                    ? ` · ${formatCollectorNumber(pick.localId, pick.setCardCountOfficial)}`
                    : ""}
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
              {busy ? "Adding…" : "Add it ▶"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
