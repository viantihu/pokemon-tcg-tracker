"use client";

/**
 * The decision card — the confirm-or-override moment (dev-spec §5 M7; system-design §8 screen 2;
 * design/prototype.html decision overlay). UIL-067 shape, approved by Karvi: the proposal, what
 * physically happens to this copy, one sentence of why, and the choices; the CATALOG / YOU OWN
 * evidence, the rest of the reasoning and the priced alternates grid sit behind a Details disclosure.
 * The system PROPOSES (one choice marked); she confirms or overrides; it NEVER auto-blocks.
 *
 * Placed in `_components/` so M9's sync UI reuses it. Presentational + callbacks only — it renders a
 * `DecisionCard` view-model and reports the chosen option; the write is a server action the host
 * owns. `resolvedLabel` shows the "you chose" state (the host tracks which decisions are resolved
 * this session, mirroring the prototype's resolved map). The host wraps this sheet in a veil.
 */

import { useState } from "react";
import type {
  DecisionCard as DecisionCardModel,
  DecisionChoiceId,
  EvidenceRow,
} from "@/lib/line/types";
import { formatCollectorNumber } from "@/lib/catalog/collector-number";
import { CardFace } from "./CardFace";
import { bandMeta } from "./plan-meta";
import { fmtPrice } from "./decision-format";

function EvidenceList({ rows }: { rows: EvidenceRow[] }) {
  return (
    <ul>
      {rows.map((r, i) => (
        <li key={i}>
          <span className={`tick ${r.mark}`} />
          <span>{r.text}</span>
        </li>
      ))}
    </ul>
  );
}

export function DecisionCard({
  decision,
  resolvedLabel,
  busy,
  onChoose,
  onReopen,
  onClose,
}: {
  decision: DecisionCardModel;
  resolvedLabel?: string | null;
  busy?: boolean;
  /** `pickedCatalogCardId` (UIL-057): which wishlist alternate she has selected, when there is one —
   *  the host thread this through resolveDecisionWrites instead of always taking the cheapest. */
  onChoose: (choiceId: DecisionChoiceId, pickedCatalogCardId?: string) => void;
  onReopen: () => void;
  onClose: () => void;
}) {
  const d = decision;
  // Overridden = she picked a non-recommended option (amber "you overrode" vs green "you chose").
  const chosen = resolvedLabel ? d.choices.find((c) => c.label === resolvedLabel) : undefined;
  const overridden = Boolean(resolvedLabel && chosen && !chosen.recommended);
  // Defaults to the server's own recommendation (index 0, "CHEAPEST") — she can pick a different one
  // before confirming; the parent remounts this component per decision (`key={decision.id}`), so this
  // never carries a stale selection over from a different decision's wishlist.
  const [pickedAlt, setPickedAlt] = useState<string | null>(d.wishlist[0]?.tcgdexId ?? null);

  return (
    <div className="dsheet panel">
      <div className="cap">
        <span className="t">DECISION</span>
        <span className="n">{d.card?.name ?? d.title}</span>
        <button
          type="button"
          className="btn sm"
          style={{ background: "var(--panel-2)", color: "var(--ink)" }}
          onClick={onClose}
        >
          Close
        </button>
      </div>
      <div className="body">
        <span className="dkind">{d.title}</span>

        {d.card ? (
          <div className="hand" style={{ marginBottom: 18 }}>
            <CardFace
              name={d.card.name}
              tcgdexId={d.card.tcgdexId}
              imageUrl={d.card.imageUrl}
              size="m"
            />
            <div style={{ minWidth: 0 }}>
              <div className="nm" style={{ fontSize: 15 }}>
                {d.card.name}
              </div>
              {formatCollectorNumber(d.card.localId, d.card.setCardCountOfficial) ? (
                <div style={{ marginTop: 6 }}>
                  <span className="no">
                    {formatCollectorNumber(d.card.localId, d.card.setCardCountOfficial)}
                  </span>
                </div>
              ) : null}
              <div className="bd u" style={{ marginTop: 8 }}>
                <span
                  className={"chip" + (bandMeta(d.card.bandKey).dither ? " dither" : "")}
                  style={{ background: bandMeta(d.card.bandKey).color, width: 14, height: 14 }}
                />
                {bandMeta(d.card.bandKey).display}
              </div>
            </div>
          </div>
        ) : null}

        <div className="dq">{d.question}</div>

        {/*
          UIL-067, Karvi: "This UX is too crowded, and a lot of the information here is not helpful. I
          need something simpler." What she needs to confirm or override: the proposal, WHAT PHYSICALLY
          HAPPENS to this copy (the one fact the old card never said plainly), one sentence of why, and
          the buttons. The catalog statistics, the you-own list, the rest of the reasoning and the
          alternates grid are still here — behind Details — for the times she wants to check the engine's
          working. Same shape she approved 2026-09-20.
        */}
        <div className="dprop">
          <div className="k">PROPOSED</div>
          <div className="t">{d.proposal}</div>
          {d.wishlist.length > 0 ? (
            <div className="wishline u" style={{ marginTop: 8 }}>
              WISHLISTING ·{" "}
              {(() => {
                const picked = d.wishlist.find((w) => w.tcgdexId === pickedAlt) ?? d.wishlist[0];
                return `${picked.name} ${formatCollectorNumber(picked.localId, picked.setCardCountOfficial) ?? ""} ${fmtPrice(picked.priceMarket) ?? ""}`;
              })()}
              {d.wishlist.length > 1 ? " · CHANGE UNDER DETAILS" : ""}
            </div>
          ) : null}
        </div>

        {d.outcome ? (
          <div className="dprop doutcome">
            <div className="k">WHAT HAPPENS TO THIS COPY</div>
            <div className="t">{d.outcome}</div>
          </div>
        ) : null}

        {d.why[0] ? (
          <p className="dwhy" style={{ fontSize: 12, lineHeight: 1.7, marginBottom: 20 }}>
            {d.why[0]}
          </p>
        ) : null}

        {resolvedLabel ? (
          <>
            <div className="dprop" style={{ background: overridden ? "#F4C86B" : "var(--mint)" }}>
              <div className="k">{overridden ? "YOU OVERRODE" : "YOU CHOSE"}</div>
              <div className="t">{resolvedLabel}</div>
              {overridden ? (
                <div
                  style={{
                    fontSize: 10,
                    color: "var(--ink-2)",
                    marginTop: 7,
                    letterSpacing: "0.06em",
                  }}
                >
                  AGAINST THE PROPOSAL. LOGGED AS A MANUAL CALL.
                </div>
              ) : null}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="btn" onClick={onReopen}>
                Change
              </button>
              <button type="button" className="btn btn-primary" onClick={onClose}>
                ◀ Back to the line
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="dchoices">
              {d.choices.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={"dchoice" + (c.recommended ? " rec" : "")}
                  disabled={busy}
                  onClick={() => onChoose(c.id, pickedAlt ?? undefined)}
                >
                  <span className={`tick ${c.recommended ? "y" : "n"}`} style={{ marginTop: 5 }} />
                  <span>
                    <span className="lb">
                      {c.label}
                      {c.recommended ? (
                        <span
                          style={{
                            fontSize: 9,
                            border: "2px solid var(--ink)",
                            padding: "2px 5px",
                            marginLeft: 8,
                          }}
                        >
                          PICK
                        </span>
                      ) : null}
                    </span>
                    <span className="ds">{c.description}</span>
                  </span>
                  <span className="ar">▶</span>
                </button>
              ))}
            </div>
            <div className="hint">
              Pick a proposal above. The system never blocks a line without you.
            </div>
          </>
        )}

        <details className="dmore">
          <summary className="u">Details · catalog, what you own, alternates</summary>
          <div className="dmorebody">
            {d.why.length > 1 ? (
              <div style={{ fontSize: 11, lineHeight: 1.75, marginBottom: 14 }}>
                {d.why.slice(1).map((t, i) => (
                  <p key={i} style={{ marginBottom: 8 }}>
                    {t}
                  </p>
                ))}
              </div>
            ) : null}
            <div className="ev">
              <div className="col">
                <div className="h">CATALOG</div>
                <div className="c">
                  <EvidenceList rows={d.catalog} />
                </div>
              </div>
              <div className="col">
                <div className="h">YOU OWN</div>
                <div className="c">
                  <EvidenceList rows={d.owned} />
                </div>
              </div>
            </div>

            {d.wishlist.length > 0 ? (
              <div className="wish">
                <div className="k">
                  <span>
                    {d.wishlist.length === 1 ? "WISHLIST TARGET" : "WISHLIST OPTIONS"} · CHEAPEST
                    FIRST
                  </span>
                </div>
                <div className="wcards">
                  {d.wishlist.map((w) => {
                    const isPicked = w.tcgdexId === pickedAlt;
                    return (
                      <div
                        key={w.tcgdexId}
                        className={"wcard" + (isPicked ? " on" : "")}
                        role={resolvedLabel ? undefined : "button"}
                        tabIndex={resolvedLabel ? undefined : 0}
                        aria-pressed={resolvedLabel ? undefined : isPicked}
                        onClick={resolvedLabel ? undefined : () => setPickedAlt(w.tcgdexId)}
                        onKeyDown={
                          resolvedLabel
                            ? undefined
                            : (e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  setPickedAlt(w.tcgdexId);
                                }
                              }
                        }
                        style={resolvedLabel ? undefined : { cursor: "pointer" }}
                      >
                        <div className="top">
                          <CardFace
                            name={w.name}
                            tcgdexId={w.tcgdexId}
                            imageUrl={w.imageUrl}
                            size="m"
                          />
                          {w.badge ? <span className="badge">{w.badge}</span> : null}
                        </div>
                        <div className="wn">{w.name}</div>
                        <div className="wno">
                          {formatCollectorNumber(w.localId, w.setCardCountOfficial) ?? ""}
                        </div>
                        <div className="wpx">{fmtPrice(w.priceMarket) ?? "—"}</div>
                        {isPicked ? <span className="pill">WISHLISTING</span> : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        </details>
      </div>
    </div>
  );
}
