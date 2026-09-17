"use client";

/**
 * The move overlay (design/prototype.html `renderMove`): a veil + sheet wrapping the reusable
 * `MovePanel`, shown when a card is moved from the line strip, the plan spotlight, or lookup. Shows
 * the card being moved and its current home, then the placement picker. Escape / backdrop closes.
 */

import { useEffect } from "react";
import type {
  ExistingLineBlock,
  LineJoinCandidate,
  MoveDestination,
  MoveOptions,
} from "@/lib/line/types";
import { CardFace } from "./CardFace";
import { MovePanel } from "./MovePanel";

export interface MoveTargetCard {
  copyId: string;
  name: string;
  localId: string | null;
  imageUrl: string | null;
  bandKey: string;
  currentLabel: string;
  initial?: MoveDestination;
  /** Line screen only (UIL-056): existing lines this card could join, by band, plus "start new". */
  lineJoinCandidatesByBand?: Record<string, LineJoinCandidate[]>;
  /** Line screen only (UIL-056): a band whose only matching line has this card's stage filled. */
  existingLineByBand?: Record<string, ExistingLineBlock>;
}

export function MoveOverlay({
  card,
  options,
  allowLineJoin = false,
  onConfirm,
  onClose,
}: {
  card: MoveTargetCard;
  options: MoveOptions;
  /** UIL-056: only the Line screen turns this on — see MovePanel's docstring. */
  allowLineJoin?: boolean;
  onConfirm: (dest: MoveDestination) => void;
  onClose: () => void;
}) {
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
        <div className="cap">
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
              {card.localId ? (
                <div style={{ marginTop: 6 }}>
                  <span className="no">{card.localId}</span>
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
            allowLineJoin={allowLineJoin}
            lineJoinCandidatesByBand={card.lineJoinCandidatesByBand}
            existingLineByBand={card.existingLineByBand}
            onConfirm={onConfirm}
          />
          <div className="hint">Pick a new home. No rule applies here — it is your call.</div>
        </div>
      </div>
    </div>
  );
}
