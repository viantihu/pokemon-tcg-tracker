"use client";

/**
 * The move overlay (design/prototype.html `renderMove`): a veil + sheet wrapping the reusable
 * `MovePanel`, shown when a card is moved from the line strip, the plan spotlight, or lookup. Shows
 * the card being moved and its current home, then the placement picker. Escape / backdrop closes.
 */

import { useEffect } from "react";
import type {
  BlockNeedCandidate,
  ExistingLineBlock,
  LineJoinCandidate,
  MoveDestination,
  MoveOptions,
} from "@/lib/line/types";
import { formatCollectorNumber } from "@/lib/catalog/collector-number";
import { CardFace } from "./CardFace";
import { MovePanel } from "./MovePanel";

export interface MoveTargetCard {
  copyId: string;
  name: string;
  localId: string | null;
  /** Printed set total, for the full "099/182" form (UIL-077). Absent or null → the bare number. */
  setCardCountOfficial?: number | null;
  imageUrl: string | null;
  bandKey: string;
  currentLabel: string;
  initial?: MoveDestination;
  /** Line screen only (UIL-056/064): existing lines this card could join, flat across every band —
   *  present (even if empty) turns the picker's line-first flow on; absent (a card already filling a
   *  slot elsewhere) keeps today's plain binder/half/band flow. */
  joinCandidates?: LineJoinCandidate[];
  /** Line screen only (UIL-056): a band whose only matching line has this card's stage filled. */
  existingLineByBand?: Record<string, ExistingLineBlock>;
  /** Line screen only (UIL-064 part 1): this card's own type-derived band — the default for "start a
   *  new line"'s one remaining pick. */
  naturalBandKey?: string;
  /** UIL-030: open binder-block needs this card could fill — present only when the engine offered the
   *  card as a repurposed block (Plan spotlight). The panel shows its block section only then. */
  blockNeeds?: BlockNeedCandidate[];
}

export function MoveOverlay({
  card,
  options,
  allowLineJoin,
  onConfirm,
  onClose,
}: {
  card: MoveTargetCard;
  options: MoveOptions;
  /**
   * The line-first flow (UIL-056; see MovePanel's docstring). When omitted it FOLLOWS THE CARD:
   * `joinCandidates` present (even empty) turns it on, absent leaves the plain move. Derived here
   * rather than at each call site (UIL-070 part 1 follow-up): QA showed the Plan's call site could
   * hard-code `false` with every test still green, because the picker's wiring lived in a prop the
   * tests could not see. Passing the prop explicitly still overrides the default.
   */
  allowLineJoin?: boolean;
  onConfirm: (dest: MoveDestination) => void;
  onClose: () => void;
}) {
  const lineJoinOn = allowLineJoin ?? Boolean(card.joinCandidates);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="veil on"
      role="dialog"
      aria-modal="true"
      aria-label={`Move ${card.name}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dsheet panel">
        {/* `movecap` scopes UIL-070's narrow-width reflow to THIS sheet's header; the other .dsheet
            users (Collections, DecisionCard, Sync) keep the shared rule untouched. */}
        <div className="cap movecap">
          <span className="t">MOVE A SHELVED CARD</span>
          <span className="n">{card.name}</span>
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
          <div className="hand" style={{ marginBottom: 16 }}>
            <CardFace name={card.name} imageUrl={card.imageUrl} size="m" />
            <div style={{ minWidth: 0 }}>
              <div className="nm" style={{ fontSize: 15 }}>
                {card.name}
              </div>
              {/* The full printed number (UIL-077), the last site that still showed the bare one. */}
              {formatCollectorNumber(card.localId, card.setCardCountOfficial) ? (
                <div style={{ marginTop: 6 }}>
                  <span className="no">
                    {formatCollectorNumber(card.localId, card.setCardCountOfficial)}
                  </span>
                </div>
              ) : null}
              <div
                className="u"
                style={{
                  fontSize: 10,
                  color: "var(--ink-2)",
                  letterSpacing: "0.08em",
                  marginTop: 8,
                }}
              >
                NOW · {card.currentLabel}
              </div>
            </div>
          </div>
          <MovePanel
            options={options}
            initial={card.initial}
            allowLineJoin={lineJoinOn}
            joinCandidates={card.joinCandidates}
            existingLineByBand={card.existingLineByBand}
            naturalBandKey={card.naturalBandKey}
            blockNeeds={card.blockNeeds}
            onConfirm={onConfirm}
          />
          <div className="hint">Pick a new home. No rule applies here — it is your call.</div>
        </div>
      </div>
    </div>
  );
}
