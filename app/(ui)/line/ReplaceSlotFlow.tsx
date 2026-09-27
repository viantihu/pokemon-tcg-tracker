"use client";

/**
 * "Replace this card" from a filled slot on the Lines page (UIL-117 PR 3, mockup v3 section 5): pick one of the
 * copies she already owns, then the line popup lays the two side by side and asks which stays. It opens on Keep
 * (her answer 2: nothing moves unless she chooses it); a swap is one write, with the card coming out going wherever
 * she picks, bulk suggested (her answer 3).
 *
 * The screen owns the write and the refresh (`onSwap`); this owns the pick and the popup.
 */

import { useEffect, useState } from "react";
import {
  defaultChoiceFor,
  type LineChoice,
  type LinePopupModel,
  type LineProposal,
} from "@/lib/line/popup";
import type { MoveOptions } from "@/lib/line/types";
import type { ReplaceCandidate, ReplaceCandidates } from "@/lib/line/replace-candidates";
import { formatCollectorNumber } from "@/lib/catalog/collector-number";
import { CardFace } from "../_components/CardFace";
import { LinePopup } from "../_components/LinePopup";

export function ReplaceSlotFlow({
  lineId,
  slotId,
  slotName,
  moveOptions,
  loadCandidates,
  loadModel,
  onSwap,
  onClose,
  busy,
}: {
  lineId: string;
  slotId: string;
  slotName: string;
  moveOptions: MoveOptions;
  /** The copies that could take the slot. Must not throw. */
  loadCandidates(): Promise<ReplaceCandidates>;
  /** The popup's model for a copy and a proposal; a refusal throws its message. */
  loadModel(copyId: string, proposal: LineProposal): Promise<LinePopupModel>;
  /** Her swap: the screen writes it (a Move of the incoming copy with her replace choice). */
  onSwap(incomingCopyId: string, choice: LineChoice): void;
  onClose(): void;
  busy: boolean;
}) {
  const [list, setList] = useState<ReplaceCandidates | null>(null);
  const [pop, setPop] = useState<{ model: LinePopupModel; choice: LineChoice } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let live = true;
    void loadCandidates().then((res) => live && setList(res));
    return () => {
      live = false;
    };
  }, [loadCandidates]);

  async function pick(c: ReplaceCandidate) {
    const proposal: LineProposal = { kind: "replace", lineId, slotId, defaultKeep: true };
    setLoading(true);
    setError(null);
    try {
      setPop({ model: await loadModel(c.copyId, proposal), choice: defaultChoiceFor(proposal) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  if (pop?.model.replace) {
    const { model } = pop;
    const replace = model.replace!;
    return (
      <div className="lp-overlay">
        <LinePopup
          model={model}
          value={pop.choice}
          busy={busy}
          error={error}
          incomingLabel="New"
          moveOptions={moveOptions}
          keepLabel={`It stays in ${replace.incoming.where}. Nothing in the line moves.`}
          outgoingLineModel={(p) => loadModel(replace.current.copyId, p)}
          onChange={(choice) => setPop({ ...pop, choice })}
          onCancel={onClose}
          onConfirm={(choice) => {
            // A Keep changes nothing: she chose to leave the line as it is.
            if (choice.mode === "replace" && choice.keep) onClose();
            else onSwap(replace.incoming.copyId, choice);
          }}
        />
      </div>
    );
  }

  return (
    <div
      className="veil on"
      role="dialog"
      aria-modal="true"
      aria-label={`Replace ${slotName}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dsheet panel">
        <div className="cap movecap">
          <span className="t">REPLACE THIS CARD</span>
          <span className="n">{slotName}</span>
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
          {list === null ? (
            <div className="u rp-hint">Looking for your other copies…</div>
          ) : !list.ok ? (
            <div className="lp-error" role="alert">
              {list.error}
            </div>
          ) : list.candidates.length === 0 ? (
            <div className="u rp-hint" role="status">
              You have no other {list.slotCardName} outside a line to swap in. A new copy from a
              haul offers the swap on the Haul Plan.
            </div>
          ) : (
            <>
              <div className="u rp-hint">
                Pick the copy that could take its place. You choose which one stays next; nothing
                moves until you confirm.
              </div>
              <div className="rp-grid">
                {list.candidates.map((c) => (
                  <button
                    type="button"
                    key={c.copyId}
                    className="rp-card"
                    disabled={loading || busy}
                    onClick={() => void pick(c)}
                  >
                    <CardFace
                      name={c.card.name}
                      tcgdexId={c.card.tcgdexId}
                      imageUrl={c.card.imageUrl}
                      size="l"
                    />
                    <span className="rp-nm u">{c.card.name}</span>
                    <span className="rp-no">
                      {formatCollectorNumber(c.card.localId, c.card.setCardCountOfficial ?? null)}
                    </span>
                    <span className="rp-where u">Now · {c.where}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          {error ? (
            <div className="lp-error" role="alert">
              {error}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
