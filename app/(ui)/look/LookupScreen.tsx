"use client";

/**
 * Card lookup — "where is my card" (scr-look; dev-spec §5 M8; system-design §7C).
 *
 * Mobile-first: one search field, and the answer sits ABOVE THE FOLD — identity, then the address
 * (binder · half · band), then the four show-floor facts (owned? · line? · wishlisted? ·
 * collection?). The type-ahead + answer both come from server actions; the client holds no data.
 */

import { useState } from "react";
import type { LookupAnswer } from "@/lib/surfaces";
import { CardFace } from "../_components/CardFace";
import { CardLookup } from "../_components/CardLookup";
import { bandMeta } from "../_components/plan-meta";
import type { LookupCard } from "../plan/plan-types";
import { lookupAnswer, searchCatalog } from "./actions";

const FACT_ICON: Record<string, string> = { y: "✓", n: "·", hot: "★" };

export function LookupScreen() {
  const [answer, setAnswer] = useState<LookupAnswer | null>(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);

  async function onPick(card: LookupCard) {
    setLoading(true);
    setNotFound(false);
    try {
      const ans = await lookupAnswer(card.tcgdexId);
      setAnswer(ans);
      setNotFound(ans === null);
    } catch {
      setAnswer(null);
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="lookwrap">
      <CardLookup search={searchCatalog} onPick={onPick} placeholder="Where is my…" />

      {loading && (
        <p style={{ marginTop: 14, fontSize: 11, color: "var(--ink-2)" }}>Reading the shelf…</p>
      )}

      {notFound && !loading && (
        <div className="notfound panel">
          <b>NO MATCH.</b>
          <div style={{ fontSize: 11, color: "var(--ink-2)", marginTop: 8 }}>
            Not in the local mirror. A full catalog needs a sync run.
          </div>
        </div>
      )}

      {answer && !loading && <AnswerPanel answer={answer} />}

      <div className="foot">BINDER → HALF → BAND · NO PAGE, NO POCKET</div>
    </div>
  );
}

function AnswerPanel({ answer }: { answer: LookupAnswer }) {
  const meta = bandMeta(answer.bandKey);
  return (
    <div className="answer panel">
      <div className="cap">
        <span>{answer.owned ? "YOU OWN IT" : "NOT OWNED"}</span>
        <span>FOUND</span>
      </div>

      <div className="hand" style={{ padding: "12px 13px 0" }}>
        <CardFace name={answer.card.name} imageUrl={answer.card.imageUrl} size="m" />
        <div style={{ minWidth: 0 }}>
          <div className="nm">{answer.card.name}</div>
          {answer.card.localId ? (
            <div style={{ marginTop: 6 }}>
              <span className="no">{answer.card.localId}</span>
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
