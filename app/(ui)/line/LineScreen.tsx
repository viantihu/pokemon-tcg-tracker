"use client";

/**
 * Line detail — the emotional center (scr-line; dev-spec §5 M7; system-design §8 screen 6;
 * design/rationale.md §2 the three slot states).
 *
 * The persisted evolution lines as tabbed strips: each stage is an object, not a table row —
 * a filled card, a hunting sticky-note (dimmed art + price + priced alternates), or a dead block
 * (hatched void + X). A capped line ends in a torn-corner cap plate. Outstanding confirm-or-override
 * moments surface as a decision queue (the shared `DecisionCard`); any filled/shelved card can be
 * moved via the shared `MovePanel`. All writes go through server actions (move / resolve).
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type {
  DecisionChoiceId,
  LineScreenData,
  LineView,
  LineViewMode,
  MoveDestination,
  SlotView,
  UnlinedCard,
} from "@/lib/line/types";
// Leaf import: the "@/lib/line" barrel re-exports load.ts (server repos), which must stay out of
// the browser bundle.
import { binderGroups } from "@/lib/line/order";
import { CardFace } from "../_components/CardFace";
import { DecisionCard } from "../_components/DecisionCard";
import { formatCollectorNumber } from "@/lib/catalog/collector-number";
import { MoveOverlay, type MoveTargetCard } from "../_components/MoveOverlay";
import { bandMeta } from "../_components/plan-meta";
import { fmtPrice } from "../_components/decision-format";
import { loadLine, moveCardAction, removeSlotCopyAction, resolveDecisionAction } from "./actions";
import { RemoveCopyButton } from "../_components/RemoveCopyButton";

const SLOT_HEAD: Record<SlotView["state"], string> = {
  filled: "FILLED",
  placeholder: "HUNTING",
  block: "BLOCKED",
};
const SLOT_TAG: Record<SlotView["state"], string> = {
  filled: "◆ OWNED",
  placeholder: "◇ OPEN",
  block: "✕ DEAD",
};
const STATUS_GLYPH: Record<LineView["status"], string> = {
  open: "● OPEN",
  capped: "▲ CAPPED",
  complete: "◆ COMPLETE",
  terminated: "■ TERMINATED",
};

/**
 * The Move sheet's card for a filled slot (UIL-056/UIL-077). PURE and exported so the mapping the Line
 * screen's sheet depends on is unit-pinned — `openMove` runs from a click, which a static render cannot
 * reach. Null when the slot holds no movable card.
 */
export function slotMoveTarget(line: LineView, slot: SlotView): MoveTargetCard | null {
  if (!slot.copyId || !slot.card) return null;
  const initialDest: MoveDestination | undefined = line.binderId
    ? { kind: "shelf", binderId: line.binderId, half: "back", band: line.bandKey }
    : undefined;
  return {
    copyId: slot.copyId,
    name: slot.card.name,
    localId: slot.card.localId,
    setCardCountOfficial: slot.card.setCardCountOfficial,
    imageUrl: slot.card.imageUrl,
    bandKey: line.bandKey,
    currentLabel: `${line.binderLabel} · ${bandMeta(line.bandKey).display}`,
    initial: initialDest,
  };
}

/** The Move sheet's card for a shelved, line-less card (UIL-056) — the one offered the line picker. */
export function unlinedMoveTarget(card: UnlinedCard): MoveTargetCard {
  return {
    copyId: card.copyId,
    name: card.card.name,
    localId: card.card.localId,
    setCardCountOfficial: card.card.setCardCountOfficial,
    imageUrl: card.card.imageUrl,
    bandKey: card.card.bandKey,
    currentLabel: card.currentLabel,
    joinCandidates: card.joinCandidates,
    existingLineByBinderBand: card.existingLineByBinderBand,
    naturalBandKey: card.naturalBandKey,
  };
}

/**
 * The strip of line tabs (UIL-074). Exported and PURE so the two orders are render-tested: in
 * `"binder"` view a heading opens each binder's run and the run's last tab closes its border; in
 * `"color"` view the tabs run flat. The lines arrive already ordered by the loader — this groups
 * what it is given and never re-sorts.
 */
export function LineTabs({
  lines,
  view,
  currentId,
  onSelect,
}: {
  lines: LineView[];
  view: LineViewMode;
  currentId: string | null;
  onSelect: (lineId: string) => void;
}) {
  const tab = (l: LineView, groupEnd: boolean) => {
    const m = bandMeta(l.bandKey);
    return (
      <button
        key={l.lineId}
        type="button"
        role="tab"
        aria-selected={l.lineId === currentId}
        className={"lt u" + (l.lineId === currentId ? " on" : "") + (groupEnd ? " gend" : "")}
        onClick={() => onSelect(l.lineId)}
      >
        <span
          className={"chip" + (m.dither ? " dither" : "")}
          style={{ background: m.color, width: 16, height: 16 }}
        />
        {l.speciesLabel}
      </button>
    );
  };
  return (
    <div className="linetabs" role="tablist" aria-label="Evolution lines">
      {view === "binder"
        ? binderGroups(lines).map((g) => (
            <Fragment key={g.key}>
              <span className="lgh u">{g.label}</span>
              {g.lines.map((l, i) => tab(l, i === g.lines.length - 1))}
            </Fragment>
          ))
        : lines.map((l) => tab(l, false))}
    </div>
  );
}

export function LineScreen() {
  const [data, setData] = useState<LineScreenData | null>(null);
  const [curId, setCurId] = useState<string | null>(null);
  const [resolved, setResolved] = useState<Record<string, string>>({});
  const [activeDecisionId, setActiveDecisionId] = useState<string | null>(null);
  const [move, setMove] = useState<MoveTargetCard | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Strip order (UIL-074): her two views, read from and written to the URL (`?view=binder`) so the
  // choice survives a reload and the round trip through a decision. The loader sorts; this only asks.
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const view: LineViewMode = searchParams.get("view") === "binder" ? "binder" : "color";
  function setView(next: LineViewMode) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "color") params.delete("view");
    else params.set("view", next);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }

  // Load the persisted lines + decisions on mount and whenever the order changes, all catalog/DB
  // access server-side.
  useEffect(() => {
    let live = true;
    loadLine(view)
      .then((d) => {
        if (!live) return;
        setData(d);
        setCurId((cur) => cur ?? d.lines[0]?.lineId ?? null);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "Could not load lines."));
    return () => {
      live = false;
    };
  }, [view]);

  const lines = useMemo(() => data?.lines ?? [], [data]);
  const curLine = useMemo(
    () => lines.find((l) => l.lineId === curId) ?? lines[0] ?? null,
    [lines, curId],
  );

  const decisions = useMemo(() => data?.decisions ?? [], [data]);
  const openDecisions = useMemo(
    () => decisions.filter((d) => !resolved[d.id]),
    [decisions, resolved],
  );
  const activeDecision = useMemo(
    () => decisions.find((d) => d.id === activeDecisionId) ?? null,
    [decisions, activeDecisionId],
  );

  const flashToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 2600);
  }, []);

  async function onChoose(
    decisionId: string,
    choiceId: DecisionChoiceId,
    pickedCatalogCardId?: string,
  ) {
    const decision = decisions.find((d) => d.id === decisionId);
    const label = decision?.choices.find((c) => c.id === choiceId)?.label ?? "Resolved";
    setBusy(true);
    setError(null);
    const res = await resolveDecisionAction(decisionId, choiceId, pickedCatalogCardId, view);
    setBusy(false);
    if (res.ok) {
      setData(res.data);
      setResolved((prev) => ({ ...prev, [decisionId]: label }));
      flashToast(`Decision recorded · ${label}`);
    } else {
      setError(res.error);
    }
  }

  function onReopen(decisionId: string) {
    setResolved((prev) => {
      const next = { ...prev };
      delete next[decisionId];
      return next;
    });
  }

  function openMove(line: LineView, slot: SlotView) {
    const target = slotMoveTarget(line, slot);
    if (target) setMove(target);
  }

  /**
   * A shelved card with no line yet (UIL-056) — the strand her UAT report named. Offered the line
   * picker; a card already filling a slot is not (`openMove` above) — it already has a line, and
   * moving one INTO a different line is a rarer case left for a follow-up.
   */
  function openMoveForUnlined(card: UnlinedCard) {
    setMove(unlinedMoveTarget(card));
  }

  /** UIL-089: the card in this pocket is gone. The slot reopens and the line is no longer complete. */
  async function onRemoveSlotCopy(copyId: string) {
    setBusy(true);
    setError(null);
    const res = await removeSlotCopyAction(copyId, view);
    setBusy(false);
    if (res.ok) {
      setData(res.data);
      flashToast("Removed · the stage is open again");
    } else {
      setError(res.error);
    }
  }

  async function onMoveConfirm(dest: MoveDestination) {
    if (!move) return;
    setBusy(true);
    setError(null);
    const res = await moveCardAction(move.copyId, dest, view);
    setBusy(false);
    if (res.ok) {
      setData(res.data);
      setMove(null);
      flashToast(`Moved · ${move.name} → ${res.label}`);
    } else {
      setError(res.error);
    }
  }

  if (!data) {
    return (
      <div className="stub panel">
        <h1 className="u">Loading lines…</h1>
        <p>Reading the persisted evolution lines and their open decisions.</p>
      </div>
    );
  }

  if (!curLine) {
    return (
      <>
        <div className="stub panel">
          <h1 className="u">No lines yet</h1>
          <p>
            Evolution lines appear here once a haul creates one (a Stage 1 or Stage 2 that forms a
            viable line), or once you start one yourself from a shelved card below.
          </p>
        </div>
        <UnlinedCardsPanel cards={data.unlinedCards} onMove={openMoveForUnlined} />
        {move ? (
          <MoveOverlay
            card={move}
            options={data.moveOptions}
            allowLineJoin={Boolean(move.joinCandidates)}
            onConfirm={onMoveConfirm}
            onClose={() => setMove(null)}
          />
        ) : null}
      </>
    );
  }

  const meta = bandMeta(curLine.bandKey);

  return (
    <>
      {error && (
        <div className="alertbar" role="alert" style={{ background: "#FFD9DF" }}>
          <span>!</span>
          <b>{error}</b>
        </div>
      )}

      <div
        className={"alertbar" + (openDecisions.length === 0 ? " ok" : "")}
        role={openDecisions.length ? "status" : undefined}
      >
        <span className={openDecisions.length ? "blink" : ""}>
          {openDecisions.length ? "!" : "✓"}
        </span>
        <b>
          {openDecisions.length
            ? `${openDecisions.length} decision${openDecisions.length > 1 ? "s" : ""} to confirm or override`
            : "No open decisions · every line is confirmed"}
        </b>
        {openDecisions.length > 0 && (
          <button
            type="button"
            className="btn"
            style={{ marginLeft: "auto" }}
            onClick={() => setActiveDecisionId(openDecisions[0].id)}
          >
            Work the decisions ▶
          </button>
        )}
      </div>

      <div className="viewmode">
        <span className="hk">ORDER</span>
        <div className="modetoggle" role="group" aria-label="Line order">
          <button
            type="button"
            className={"modebtn u" + (view === "color" ? " on" : "")}
            aria-pressed={view === "color"}
            onClick={() => setView("color")}
          >
            Colour + A–Z
          </button>
          <button
            type="button"
            className={"modebtn u" + (view === "binder" ? " on" : "")}
            aria-pressed={view === "binder"}
            onClick={() => setView("binder")}
          >
            By binder
          </button>
        </div>
      </div>

      <LineTabs lines={lines} view={data.view} currentId={curLine.lineId} onSelect={setCurId} />

      <div className="linehead">
        <div className="linetitle panel">
          <div className="sp u">{curLine.speciesLabel}</div>
          <div className="lc u">
            <span
              className={"chip" + (meta.dither ? " dither" : "")}
              style={{ background: meta.color, width: 14, height: 14 }}
            />
            {meta.display} · {curLine.binderLabel} · {curLine.counts.filled}◆{" "}
            {curLine.counts.placeholder}◇ {curLine.counts.block}✕
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center" }}>
          <span className={`status ${curLine.status}`}>{STATUS_GLYPH[curLine.status]}</span>
        </div>
      </div>

      <div className="page">
        <span
          className={"pagerail" + (meta.dither ? " dither" : "")}
          style={{ background: meta.color }}
        />
        <div className="pageholes" aria-hidden>
          <i />
          <i />
          <i />
          <i />
        </div>
        <div className="strip">
          {curLine.slots.map((slot, i) => (
            <div key={slot.slotId} style={{ display: "contents" }}>
              {i > 0 ? (
                <div
                  className={
                    "arrowcell" +
                    (slot.state === "block" || curLine.slots[i - 1].state === "block"
                      ? " dead"
                      : "")
                  }
                  aria-hidden
                >
                  <span className="evlabel">▶</span>
                  <span className="pxarrow">
                    <i />
                    <i />
                    <i />
                  </span>
                </div>
              ) : null}
              <Slot
                line={curLine}
                slot={slot}
                onMove={() => openMove(curLine, slot)}
                onRemoveCopy={onRemoveSlotCopy}
              />
            </div>
          ))}
          {curLine.cap ? (
            <>
              <div className="tear" aria-hidden />
              <div className="capcell">
                <div className="capplate">
                  <div className="k u">▲ CAP</div>
                  <div className="t">{curLine.cap.targetLabel}</div>
                  <div className="w">{curLine.cap.note}</div>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>

      <div className="lineinfo">
        {curLine.info.map((box, i) => (
          <div key={i} className="box panel">
            <div className="k u">{box.k}</div>
            <div className="v">{box.v}</div>
          </div>
        ))}
      </div>

      <UnlinedCardsPanel cards={data.unlinedCards} onMove={openMoveForUnlined} />

      <div className="foot">BINDER → HALF → BAND · ONE HORIZONTAL LINE, NO PAGE, NO POCKET</div>

      {activeDecision ? (
        <div
          className="veil on"
          onClick={(e) => {
            if (e.target === e.currentTarget) setActiveDecisionId(null);
          }}
        >
          <DecisionCard
            key={activeDecision.id}
            decision={activeDecision}
            resolvedLabel={resolved[activeDecision.id] ?? null}
            busy={busy}
            onChoose={(choiceId, pickedCatalogCardId) =>
              onChoose(activeDecision.id, choiceId, pickedCatalogCardId)
            }
            onReopen={() => onReopen(activeDecision.id)}
            onClose={() => setActiveDecisionId(null)}
          />
        </div>
      ) : null}

      {move ? (
        <MoveOverlay
          card={move}
          options={data.moveOptions}
          allowLineJoin={Boolean(move.joinCandidates)}
          onConfirm={onMoveConfirm}
          onClose={() => setMove(null)}
        />
      ) : null}

      {toast ? (
        <div className="toast on" role="status">
          {toast}
        </div>
      ) : null}
    </>
  );
}

/**
 * Shelved cards with no line yet (UIL-056) — the way OFF the front half her UAT report was missing.
 * Nothing to show is the common case (most shelved cards are already lined or have no line
 * concept), so this collapses to nothing rather than an empty panel.
 *
 * UIL-064 part 3: split by CURRENT HALF, not flattened together. A back-half card with no line is
 * the strand this feature exists for — it sits in the lines area with nothing tracking it. A
 * front-half card with no line is not an anomaly (most front-half cards never get one), so it is the
 * common case, not something needing attention; folding hundreds of those in with the 5-10 that
 * actually need a decision was itself part of what made this list unusable.
 */
function UnlinedCardsPanel({
  cards,
  onMove,
}: {
  cards: UnlinedCard[];
  onMove: (card: UnlinedCard) => void;
}) {
  if (cards.length === 0) return null;
  const stranded = cards.filter((c) => c.binderHalf === "back");
  const rest = cards.filter((c) => c.binderHalf !== "back");
  return (
    <div className="lineinfo" style={{ marginTop: 16 }}>
      {stranded.length > 0 ? (
        <div className="box panel" style={{ gridColumn: "1 / -1" }}>
          <div className="k u">STRANDED IN THE BACK HALF · {stranded.length}</div>
          <UnlinedCardGrid cards={stranded} onMove={onMove} />
        </div>
      ) : null}
      {rest.length > 0 ? (
        <details className="box panel" style={{ gridColumn: "1 / -1" }}>
          <summary className="k u" style={{ cursor: "pointer" }}>
            OTHER UNLINED CARDS (FRONT HALF) · {rest.length}
          </summary>
          <UnlinedCardGrid cards={rest} onMove={onMove} />
        </details>
      ) : null}
    </div>
  );
}

function UnlinedCardGrid({
  cards,
  onMove,
}: {
  cards: UnlinedCard[];
  onMove: (card: UnlinedCard) => void;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 8 }}>
      {cards.map((c) => (
        <div key={c.copyId} className="hand" style={{ minWidth: 160 }}>
          <CardFace name={c.card.name} imageUrl={c.card.imageUrl} size="m" />
          <div style={{ minWidth: 0 }}>
            <div className="nm" style={{ fontSize: 13 }}>
              {c.card.name}
            </div>
            <div className="u" style={{ fontSize: 10, color: "var(--ink-2)", marginTop: 4 }}>
              {c.currentLabel}
            </div>
            <button
              type="button"
              className="movebtn u"
              style={{ marginTop: 6 }}
              onClick={() => onMove(c)}
            >
              ↔ Move
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * One stage of a line as an object on the strip. Exported so the labels she reads on it — the printed
 * collector number and the priced alternates line — are render-tested (UIL-077), not just read.
 */
export function Slot({
  line,
  slot,
  onMove,
  onRemoveCopy,
}: {
  line: LineView;
  slot: SlotView;
  onMove: () => void;
  /** UIL-089: remove the copy filling this slot. Absent on a screen that does not offer it. */
  onRemoveCopy?: (copyId: string) => void;
}) {
  const meta = bandMeta(line.bandKey);
  const topBg =
    slot.state === "filled" ? meta.color : slot.state === "placeholder" ? "var(--ink)" : "#5F5035";
  const topStyle: React.CSSProperties = { background: topBg };
  if (meta.dark && slot.state === "filled") topStyle.color = "var(--panel)";

  return (
    <div className={`slot ${slot.state}`}>
      <div className="slotlabel u">
        <span>{slot.stage}</span>
        {/* UIL-087: a slot reading FILLED whose card was never shelved says so, rather than looking
            like every other filled stage. She can see which rows are wrong before she moves them, and
            Move is now offered on exactly these (lib/line/view.ts). */}
        <span>{slot.copyNotShelved ? "FILLED · CARD NOT SHELVED" : SLOT_HEAD[slot.state]}</span>
      </div>
      <div className="pocket">
        <div className="top u" style={topStyle}>
          <span>{SLOT_TAG[slot.state]}</span>
        </div>
        <div className="art">
          {slot.state === "block" ? (
            <span className="xmark" aria-hidden>
              <i />
              <i />
            </span>
          ) : (
            <CardFace
              name={slot.card?.name ?? slot.stage}
              imageUrl={slot.card?.imageUrl ?? null}
              size="l"
            />
          )}
        </div>
        <div className="info">
          <div className="cn">{slot.card?.name ?? slot.stage}</div>
          {slot.card && formatCollectorNumber(slot.card.localId, slot.card.setCardCountOfficial) ? (
            <div>
              <span className="no">
                {formatCollectorNumber(slot.card.localId, slot.card.setCardCountOfficial)}
              </span>
            </div>
          ) : null}
          {slot.card?.setName || slot.card?.setId ? (
            <div className="cs">{slot.card.setName ?? slot.card.setId}</div>
          ) : null}

          {slot.state === "placeholder" ? (
            <>
              {fmtPrice(slot.priceMarket) ? (
                <div className="price">
                  {fmtPrice(slot.priceMarket)}
                  <span className="caret" />
                </div>
              ) : null}
              {slot.willLiveInSpecialty ? (
                <div
                  className="tagline"
                  style={{ background: "var(--b-purple)", color: "var(--ink)" }}
                >
                  SPECIALTY
                </div>
              ) : null}
              {slot.alternates.length > 0 ? (
                <div className="alts">
                  ALTS ·{" "}
                  {slot.alternates
                    .slice(0, 3)
                    .map((a) =>
                      `${formatCollectorNumber(a.localId, a.setCardCountOfficial) ?? a.name} ${fmtPrice(a.priceMarket) ?? ""}`.trim(),
                    )
                    .join(" · ")}
                </div>
              ) : null}
            </>
          ) : null}

          {slot.state === "block" && slot.wedgeLabel ? (
            <div className="tagline">{slot.wedgeLabel}</div>
          ) : null}

          {slot.copyNotShelved ? (
            /* `.movedtag` rather than a new class: it is the styled tag slot in this exact position
               (the prototype audit's L5 notes it existed but only the Plan rendered it), so this needs
               no CSS of its own. */
            <div className="movedtag u" role="status">
              This stage reads as filled but the card is not shelved here. Move it to put the record
              right.
            </div>
          ) : null}
          {slot.moveable ? (
            <button type="button" className="movebtn u" onClick={onMove}>
              ↔ Move
            </button>
          ) : null}
          {/* UIL-089: the card in this pocket can be gone — traded, lost, or never really here. Removing it
              releases the slot back to a placeholder and reopens the line, so the stage is wanted again
              rather than reading as filled by a card she does not have. */}
          {onRemoveCopy && slot.copyId ? (
            <div style={{ marginTop: 6 }}>
              <RemoveCopyButton
                onRemove={() => onRemoveCopy(slot.copyId as string)}
                what={`${slot.card?.name ?? "this card"} from your collection`}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
