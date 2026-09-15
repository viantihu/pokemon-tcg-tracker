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

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  DecisionChoiceId,
  LineScreenData,
  LineView,
  MoveDestination,
  SlotView,
  UnlinedCard,
} from "@/lib/line/types";
import { CardFace } from "../_components/CardFace";
import { DecisionCard } from "../_components/DecisionCard";
import { MoveOverlay, type MoveTargetCard } from "../_components/MoveOverlay";
import { bandMeta } from "../_components/plan-meta";
import { fmtPrice } from "../_components/decision-format";
import { loadLine, moveCardAction, resolveDecisionAction } from "./actions";

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

export function LineScreen() {
  const [data, setData] = useState<LineScreenData | null>(null);
  const [curId, setCurId] = useState<string | null>(null);
  const [resolved, setResolved] = useState<Record<string, string>>({});
  const [activeDecisionId, setActiveDecisionId] = useState<string | null>(null);
  const [move, setMove] = useState<MoveTargetCard | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load the persisted lines + decisions once on mount, all catalog/DB access server-side.
  useEffect(() => {
    let live = true;
    loadLine()
      .then((d) => {
        if (!live) return;
        setData(d);
        setCurId((cur) => cur ?? d.lines[0]?.lineId ?? null);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "Could not load lines."));
    return () => {
      live = false;
    };
  }, []);

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

  async function onChoose(decisionId: string, choiceId: DecisionChoiceId) {
    const decision = decisions.find((d) => d.id === decisionId);
    const label = decision?.choices.find((c) => c.id === choiceId)?.label ?? "Resolved";
    setBusy(true);
    setError(null);
    const res = await resolveDecisionAction(decisionId, choiceId);
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
    if (!slot.copyId || !slot.card) return;
    const initialDest: MoveDestination | undefined = line.binderId
      ? { kind: "shelf", binderId: line.binderId, half: "back", band: line.bandKey }
      : undefined;
    setMove({
      copyId: slot.copyId,
      name: slot.card.name,
      localId: slot.card.localId,
      imageUrl: slot.card.imageUrl,
      bandKey: line.bandKey,
      currentLabel: `${line.binderLabel} · ${bandMeta(line.bandKey).display}`,
      initial: initialDest,
    });
  }

  /**
   * A shelved card with no line yet (UIL-056) — the strand her UAT report named. Offered the line
   * picker; a card already filling a slot is not (`openMove` above) — it already has a line, and
   * moving one INTO a different line is a rarer case left for a follow-up.
   */
  function openMoveForUnlined(card: UnlinedCard) {
    setMove({
      copyId: card.copyId,
      name: card.card.name,
      localId: card.card.localId,
      imageUrl: card.card.imageUrl,
      bandKey: card.card.bandKey,
      currentLabel: card.currentLabel,
      lineJoinCandidatesByBand: card.joinCandidatesByBand,
    });
  }

  async function onMoveConfirm(dest: MoveDestination) {
    if (!move) return;
    setBusy(true);
    setError(null);
    const res = await moveCardAction(move.copyId, dest);
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
            allowLineJoin={Boolean(move.lineJoinCandidatesByBand)}
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

      <div className="linetabs" role="tablist" aria-label="Evolution lines">
        {lines.map((l) => {
          const m = bandMeta(l.bandKey);
          return (
            <button
              key={l.lineId}
              type="button"
              role="tab"
              aria-selected={l.lineId === curLine.lineId}
              className={"lt u" + (l.lineId === curLine.lineId ? " on" : "")}
              onClick={() => setCurId(l.lineId)}
            >
              <span
                className={"chip" + (m.dither ? " dither" : "")}
                style={{ background: m.color, width: 16, height: 16 }}
              />
              {l.speciesLabel}
            </button>
          );
        })}
      </div>

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
              <Slot line={curLine} slot={slot} onMove={() => openMove(curLine, slot)} />
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
            decision={activeDecision}
            resolvedLabel={resolved[activeDecision.id] ?? null}
            busy={busy}
            onChoose={(choiceId) => onChoose(activeDecision.id, choiceId)}
            onReopen={() => onReopen(activeDecision.id)}
            onClose={() => setActiveDecisionId(null)}
          />
        </div>
      ) : null}

      {move ? (
        <MoveOverlay
          card={move}
          options={data.moveOptions}
          allowLineJoin={Boolean(move.lineJoinCandidatesByBand)}
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
 */
function UnlinedCardsPanel({
  cards,
  onMove,
}: {
  cards: UnlinedCard[];
  onMove: (card: UnlinedCard) => void;
}) {
  if (cards.length === 0) return null;
  return (
    <div className="lineinfo" style={{ marginTop: 16 }}>
      <div className="box panel" style={{ gridColumn: "1 / -1" }}>
        <div className="k u">NOT IN A LINE YET</div>
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
      </div>
    </div>
  );
}

function Slot({ line, slot, onMove }: { line: LineView; slot: SlotView; onMove: () => void }) {
  const meta = bandMeta(line.bandKey);
  const topBg =
    slot.state === "filled" ? meta.color : slot.state === "placeholder" ? "var(--ink)" : "#5F5035";
  const topStyle: React.CSSProperties = { background: topBg };
  if (meta.dark && slot.state === "filled") topStyle.color = "var(--panel)";

  return (
    <div className={`slot ${slot.state}`}>
      <div className="slotlabel u">
        <span>{slot.stage}</span>
        <span>{SLOT_HEAD[slot.state]}</span>
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
          {slot.card?.localId ? (
            <div>
              <span className="no">{slot.card.localId}</span>
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
                    .map((a) => `${a.localId ?? a.name} ${fmtPrice(a.priceMarket) ?? ""}`.trim())
                    .join(" · ")}
                </div>
              ) : null}
            </>
          ) : null}

          {slot.state === "block" && slot.wedgeLabel ? (
            <div className="tagline">{slot.wedgeLabel}</div>
          ) : null}

          {slot.moveable ? (
            <button type="button" className="movebtn u" onClick={onMove}>
              ↔ Move
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
