"use client";

/**
 * Card lookup — "where is my card" (scr-look; dev-spec §5 M8; system-design §7C).
 *
 * Mobile-first: one search field, and the answer sits ABOVE THE FOLD — identity, then the address
 * (binder · half · band), then her copies with a Move on each (UIL-051), then the four show-floor facts
 * (owned? · line? · wishlisted? · collection?). The type-ahead + answer both come from server actions;
 * the client holds no data.
 *
 * Three distinct states after a pick, never collapsed into one (UIL-035, third site): the answer; NO
 * MATCH, which is only ever said when the mirror was asked and does not have the card; and COULD NOT
 * LOOK THIS UP, when the lookup itself failed — the card may well be on her shelf.
 */

import { useState } from "react";
import type { MoveDestination, MoveOptions } from "@/lib/line/types";
import type { LookupAnswer } from "@/lib/surfaces";
import { CardFace } from "../_components/CardFace";
import { cardCaption } from "../_components/CardLightbox";
import { CardResultsGrid } from "../_components/CardResultsGrid";
import { formatCollectorNumber } from "@/lib/catalog/collector-number";
import { MoveOverlay, type MoveTargetCard } from "../_components/MoveOverlay";
import { bandMeta } from "../_components/plan-meta";
import type { LookupCard } from "../plan/plan-types";
import {
  lookupAnswer,
  lookupMoveOptions,
  mergeCopies,
  moveFromLookup,
  removeCopy,
  searchCatalog,
  type LookupResult,
} from "./actions";
import type { LookupMovableCopy } from "./lookup-copies";
import { RemoveCopyButton } from "../_components/RemoveCopyButton";
import { lookupViewFrom, type LookupView } from "./lookup-state";

const FACT_ICON: Record<string, string> = { y: "✓", n: "·", hot: "★" };

const EMPTY_VIEW: LookupView = { answer: null, copies: [], notFound: false, failed: null };

/**
 * The Move sheet's card for one of her copies of the looked-up printing (UIL-051/UIL-077). PURE and
 * exported so the mapping is unit-pinned; `openMove` runs from a click a static render cannot reach.
 */
export function lookupMoveTarget(answer: LookupAnswer, copy: LookupMovableCopy): MoveTargetCard {
  return {
    copyId: copy.copyId,
    name: answer.card.name,
    localId: answer.card.localId,
    setCardCountOfficial: answer.card.setCardCountOfficial,
    imageUrl: answer.card.imageUrl,
    bandKey: answer.bandKey,
    currentLabel: copy.currentLabel,
    initial: copy.initial,
  };
}

export function LookupScreen() {
  const [view, setView] = useState<LookupView>(EMPTY_VIEW);
  const { answer, copies, notFound, failed } = view;
  const [loading, setLoading] = useState(false);

  const [moveOptions, setMoveOptions] = useState<MoveOptions | null>(null);
  const [moveTarget, setMoveTarget] = useState<MoveTargetCard | null>(null);
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  function flashToast(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 2600);
  }

  /** The one place a lookup result becomes screen state (lookup-state.ts), so the states cannot overlap. */
  function applyResult(res: LookupResult) {
    setView(lookupViewFrom(res));
  }

  async function onPick(card: LookupCard) {
    setLoading(true);
    setView((v) => ({ ...v, notFound: false, failed: null }));
    setMoveError(null);
    try {
      applyResult(await lookupAnswer(card.tcgdexId));
    } catch (err) {
      // The action itself never throws; this is the request not completing (offline, session gone).
      applyResult({
        ok: false,
        error: err instanceof Error ? err.message : "The request did not complete.",
      });
    } finally {
      setLoading(false);
    }
  }

  async function openMove(copy: LookupMovableCopy) {
    if (!answer) return;
    setMoveError(null);
    let opts = moveOptions;
    if (!opts) {
      const r = await lookupMoveOptions();
      if (!r.ok) {
        setMoveError(r.error);
        return;
      }
      opts = r.options;
      setMoveOptions(opts);
    }
    setMoveTarget(lookupMoveTarget(answer, copy));
  }

  /**
   * Remove one copy (UIL-089). The answer is re-assembled from the server afterwards, so the screen shows
   * the card as it now is — one fewer copy, or not owned — rather than a row for a card that is gone.
   */
  async function onRemove(copy: LookupMovableCopy) {
    if (!answer) return;
    setMoveError(null);
    setMoving(true);
    const res = await removeCopy(copy.copyId, answer.card.tcgdexId);
    setMoving(false);
    if (!res.ok) {
      setMoveError(res.error);
      return;
    }
    if (res.lookup) applyResult(res.lookup);
    flashToast(`Removed · ${answer.card.name}`);
  }

  /**
   * Merge two records of one card (UIL-089): the copy she keeps adopts the Dex twin's identity.
   *
   * Offered only where it can be true — see `mergeableTwinOf`. The twin is the Dex-backed record, so the
   * survivor is the one she has actually placed, which is also the one she would be annoyed to lose.
   */
  async function onMerge(survivor: LookupMovableCopy, twin: LookupMovableCopy) {
    if (!answer) return;
    setMoveError(null);
    setMoving(true);
    const res = await mergeCopies(survivor.copyId, twin.copyId, answer.card.tcgdexId);
    setMoving(false);
    if (!res.ok) {
      setMoveError(res.error);
      return;
    }
    if (res.lookup) applyResult(res.lookup);
    flashToast(`Merged · one ${answer.card.name}, one record`);
  }

  async function onMoveConfirm(dest: MoveDestination) {
    if (!moveTarget || !answer) return;
    setMoving(true);
    setMoveError(null);
    const res = await moveFromLookup(moveTarget.copyId, dest, answer.card.tcgdexId);
    setMoving(false);
    // Close the sheet either way: a failure shown behind a veil is a failure she cannot read.
    setMoveTarget(null);
    if (!res.ok) {
      setMoveError(res.error);
      return;
    }
    applyResult(res.lookup);
    flashToast(`Moved · ${moveTarget.name} → ${res.label}`);
  }

  return (
    <div className="lookwrap">
      <CardResultsGrid search={searchCatalog} onPick={onPick} placeholder="Where is my…" />

      {loading && (
        <p style={{ marginTop: 14, fontSize: 11, color: "var(--ink-2)" }}>Reading the shelf…</p>
      )}

      {failed && !loading ? <LookupNotice kind="failed" message={failed} /> : null}
      {notFound && !loading ? <LookupNotice kind="notfound" /> : null}
      {moveError ? <LookupNotice kind="moveFailed" message={moveError} /> : null}

      {answer && !loading && (
        <AnswerPanel
          answer={answer}
          copies={copies}
          busy={moving}
          onMove={openMove}
          onRemove={onRemove}
          onMerge={onMerge}
        />
      )}

      <div className="foot">BINDER → HALF → BAND · NO PAGE, NO POCKET</div>

      {moveTarget && moveOptions ? (
        <MoveOverlay
          card={moveTarget}
          options={moveOptions}
          onConfirm={onMoveConfirm}
          onClose={() => setMoveTarget(null)}
        />
      ) : null}

      {toast ? (
        <div className="toast on" role="status">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The three things the screen can say instead of an answer, kept apart on purpose (UIL-035). Only
 * `notfound` claims anything about her collection; the other two say the app did not get an answer.
 */
export function LookupNotice({
  kind,
  message,
}: {
  kind: "notfound" | "failed" | "moveFailed";
  message?: string;
}) {
  if (kind === "notfound") {
    return (
      <div className="notfound panel">
        <b>NO MATCH.</b>
        <div style={{ fontSize: 11, color: "var(--ink-2)", marginTop: 8 }}>
          No card found — check the number or try the card name.
        </div>
      </div>
    );
  }
  return (
    <div className="notfound panel" role="alert">
      <b>{kind === "failed" ? "COULD NOT LOOK THIS UP." : "COULD NOT MOVE IT."}</b>
      <div style={{ fontSize: 11, color: "var(--ink-2)", marginTop: 8 }}>
        {message}
        {kind === "failed"
          ? " — the card may well be on your shelf; the app just did not get an answer. Try again."
          : " — nothing changed. Try again."}
      </div>
    </div>
  );
}

export function AnswerPanel({
  answer,
  copies,
  busy,
  onMove,
  onRemove,
  onMerge,
}: {
  answer: LookupAnswer;
  copies: LookupMovableCopy[];
  busy: boolean;
  onMove: (copy: LookupMovableCopy) => void;
  onRemove: (copy: LookupMovableCopy) => void;
  onMerge: (survivor: LookupMovableCopy, twin: LookupMovableCopy) => void;
}) {
  const meta = bandMeta(answer.bandKey);
  return (
    <div className="answer panel">
      <div className="cap">
        <span>{answer.owned ? "YOU OWN IT" : "NOT OWNED"}</span>
        <span>FOUND</span>
      </div>

      <div className="hand" style={{ padding: "12px 13px 0" }}>
        <CardFace
          name={answer.card.name}
          imageUrl={answer.card.imageUrl}
          size="m"
          zoomable
          caption={cardCaption(answer.card.setName, answer.card.localId)}
        />
        <div style={{ minWidth: 0 }}>
          <div className="nm">{answer.card.name}</div>
          {formatCollectorNumber(answer.card.localId, answer.card.setCardCountOfficial) ? (
            <div style={{ marginTop: 6 }}>
              <span className="no">
                {formatCollectorNumber(answer.card.localId, answer.card.setCardCountOfficial)}
              </span>
            </div>
          ) : null}
          <div className="sb u">{answer.subtitle}</div>
        </div>
      </div>

      <div className="hero">
        {answer.owned && (
          <div className="bandstack" aria-hidden>
            {answer.bandStack.map((b) => {
              const m = bandMeta(b.key);
              return (
                <i
                  key={b.key}
                  className={(b.active ? "on" : "") + (m.dither ? " dither" : "")}
                  style={{ background: m.color }}
                />
              );
            })}
          </div>
        )}
        <div className="where">
          {answer.location ? (
            <>
              {answer.location.binderName}
              <br />
              {answer.location.half}
              <small>
                {answer.location.bandDisplay
                  ? `${meta.display} · ${meta.types}`
                  : "SPECIALTY · BY COLLECTION"}
              </small>
            </>
          ) : (
            <>
              NOT IN A BINDER
              <small>NOT OWNED YET</small>
            </>
          )}
        </div>
      </div>

      {copies.length > 0 ? (
        <CopyRows
          copies={copies}
          busy={busy}
          onMove={onMove}
          onRemove={onRemove}
          onMerge={onMerge}
        />
      ) : null}

      <div className="facts">
        {answer.facts.map((f, i) => (
          <div key={i} className={`fact ${f.tone}`}>
            <span className="ic" aria-hidden>
              {FACT_ICON[f.tone] ?? "·"}
            </span>
            <span>
              <b>{f.label}</b>
              <br />
              {f.detail}
              {f.lineId ? (
                <>
                  {" "}
                  <span className="tag">LINE · M7</span>
                </>
              ) : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Her physical copies of this printing, one row each, with a Move on every one the picker can take
 * (UIL-051: "Lookup provides no way to move cards"). The one exception is named on the row itself, with
 * its remedy: a binder block holds its pockets, and the place to free it is the line detail — a refusal
 * is only acceptable when the condition is stated and the way round it is on screen.
 */
/**
 * The Dex twin this copy could be merged with, or null (UIL-089).
 *
 * Two records are one card only in the shape the incident actually produced: one copy she typed by hand
 * (in no presence group, so `dexTracked` is false) and one the import created. Offered on the HAND-TYPED
 * row, because that is the record she placed and the one she would be annoyed to lose, and the Dex-backed
 * twin is the identity being adopted. Two Dex-backed records mean Dex itself claims two cards, which is
 * not this screen's to overrule; two hand-typed ones have no identity to adopt. `applyCopyMerge` refuses
 * both from the server side too — this only decides whether to offer it.
 */
export function mergeableTwinOf(
  copy: LookupMovableCopy,
  copies: readonly LookupMovableCopy[],
): LookupMovableCopy | null {
  if (copy.dexTracked || copy.role === "block") return null;
  const twins = copies.filter((c) => c.copyId !== copy.copyId && c.dexTracked);
  return twins.length === 1 ? twins[0] : null;
}

function CopyRows({
  copies,
  busy,
  onMove,
  onRemove,
  onMerge,
}: {
  copies: LookupMovableCopy[];
  busy: boolean;
  onMove: (copy: LookupMovableCopy) => void;
  onRemove: (copy: LookupMovableCopy) => void;
  onMerge: (survivor: LookupMovableCopy, twin: LookupMovableCopy) => void;
}) {
  return (
    <div className="facts" style={{ borderBottom: "3px solid var(--ink)" }}>
      {copies.map((c, i) => (
        <div key={c.copyId} className="fact y" style={{ alignItems: "center" }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <b>{copies.length > 1 ? `COPY ${i + 1} OF ${copies.length}` : "YOUR COPY"}</b>
            <br />
            {c.currentLabel}
            {c.role === "block" ? (
              <>
                <br />
                <span style={{ color: "var(--ink-2)" }}>
                  A binder block holds its pockets. Free it from the line detail to move it.
                </span>
              </>
            ) : null}
          </span>
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            {c.role !== "block" ? (
              <button type="button" className="btn sm" disabled={busy} onClick={() => onMove(c)}>
                Move
              </button>
            ) : null}
            {(() => {
              const twin = mergeableTwinOf(c, copies);
              return twin ? (
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy}
                  onClick={() => onMerge(c, twin)}
                  title="One card, two records: keep this one and fold the imported record into it."
                >
                  Same card
                </button>
              ) : null;
            })()}
            {/* A block is removable like anything else: a spacer she has thrown away is gone (UIL-089). */}
            <RemoveCopyButton onRemove={() => onRemove(c)} busy={busy} what="this copy" />
          </span>
        </div>
      ))}
    </div>
  );
}
