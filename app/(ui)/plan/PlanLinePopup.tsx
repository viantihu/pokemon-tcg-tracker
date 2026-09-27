"use client";

/**
 * The line popup on the Haul Plan (UIL-117, mockup v3 section 1): every card headed into a back half opens it, and
 * nothing is written until she confirms. The popup itself is the one every screen shares (the Tech Lead's
 * `LinePopup`); this is the Haul Plan's side of it:
 *
 *   - it opens on what the plan proposes (start / add / replace), from a model the server builds fresh;
 *   - "New · this haul" names the card she is placing;
 *   - a HOLO UPGRADE opens pre-set to Swap, the old copy to the bulk box; on Keep, "Where does the holo go?"
 *     opens on the bulk box, suggested (the Senior BA's ruling);
 *   - an extra copy's Keep sends it where an extra copy goes today, the front half, and says so;
 *   - an Add whose line is another colour asks which wins, neither picked (UIL-069, v3's two options);
 *   - "Add to that line" on a line she already has reloads the popup for that line.
 *
 * The step-through ("Line card k of N", "Confirm & next") is the screen's: it opens the next line card after a
 * confirm. Escape cancels, through the app's layer stack.
 */

import { useEffect, useState } from "react";
import type { BandMismatchChoice, PlanItem } from "@/lib/plan";
import type { MoveDestination, MoveOptions } from "@/lib/line/types";
import {
  defaultChoiceFor,
  type LineChoice,
  type LinePopupModel,
  type LineProposal,
} from "@/lib/line/popup";
import { LinePopup } from "../_components/LinePopup";
import { useEscapeLayer } from "../_components/escape-layer";

export function PlanLinePopup({
  item,
  copyId,
  moveOptions,
  loadModelFor,
  bandMismatch,
  position,
  busy,
  error,
  onConfirm,
  onConfirmOwnColour,
  onCancel,
}: {
  item: PlanItem & { lineProposal: LineProposal };
  /** The haul copy this popup places. */
  copyId: string;
  moveOptions: MoveOptions | null;
  /**
   * The popup's model for a copy and a proposal, from the server; a refusal throws its message. For this card, and
   * for the card coming OUT of a swap when she sends it to "Another line…" (answer 3: anywhere).
   */
  loadModelFor(copyId: string, proposal: LineProposal): Promise<LinePopupModel>;
  /** The card's colour question, when its line is another colour (UIL-069); null when there is none. */
  bandMismatch: BandMismatchChoice | null;
  /** "Line card k of N" in this haul, and whether another unshelved line card remains after this one. */
  position: { index: number; total: number; next: boolean };
  busy: boolean;
  error: string | null;
  onConfirm(choice: LineChoice): void;
  /** "File by its own colour": the front half, not a line. */
  onConfirmOwnColour(destination: MoveDestination): void;
  onCancel(): void;
}) {
  const [proposal, setProposal] = useState<LineProposal>(item.lineProposal);
  const [model, setModel] = useState<LinePopupModel | null>(null);
  const [value, setValue] = useState<LineChoice>(() => defaultChoiceFor(item.lineProposal));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [colour, setColour] = useState<"line" | "own" | null>(null);
  useEscapeLayer(true, onCancel);

  useEffect(() => {
    let live = true;
    loadModelFor(copyId, proposal).then(
      (m) => {
        if (!live) return;
        setModel(m);
        setValue(defaultChoiceFor(proposal));
        setLoadError(null);
      },
      (e: unknown) => {
        if (live) setLoadError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      live = false;
    };
  }, [proposal, copyId, loadModelFor]);

  if (!model) {
    return (
      <div className="lp-overlay">
        <div className="lp-pop panel" role="dialog" aria-label="Line">
          {loadError ? (
            <>
              <div className="lp-error" role="alert">
                {loadError}
              </div>
              <button type="button" className="btn" onClick={onCancel}>
                Close
              </button>
            </>
          ) : (
            <div className="u rp-hint" role="status">
              Opening its line…
            </div>
          )}
        </div>
      </div>
    );
  }

  const holo = proposal.kind === "replace" && !proposal.defaultKeep;
  const bandName = (key: string) => moveOptions?.bands.find((b) => b.key === key)?.display ?? key;
  // The colour question belongs to the line it was asked about: after "Add to that line" it no longer applies
  // (UX review of #392).
  const opened = item.lineProposal;
  const onOpenedLine =
    proposal.kind === "add" &&
    opened.kind === "add" &&
    proposal.lineId === opened.lineId &&
    proposal.slotId === opened.slotId;
  const mismatch = model.mode === "add" && onOpenedLine && bandMismatch ? bandMismatch : null;

  return (
    <div className="lp-overlay">
      <LinePopup
        model={model}
        value={value}
        onChange={setValue}
        onCancel={onCancel}
        onConfirm={onConfirm}
        onSwitch={(p) => setProposal(p)}
        position={position}
        busy={busy}
        error={error ?? loadError}
        incomingLabel="New · this haul"
        moveOptions={moveOptions ?? undefined}
        keepDestination={holo ? { kind: "bulk" } : undefined}
        outgoingLineModel={
          model.replace
            ? (p: LineProposal) => loadModelFor(model.replace!.current.copyId, p)
            : undefined
        }
        // An extra copy's Keep shelves it where an extra copy goes today; the popup names that row (v3 section 5).
        keepTo={proposal.kind === "replace" && !holo ? item.destination : undefined}
        colourChoice={
          mismatch
            ? {
                cardBand: {
                  key:
                    mismatch.ownColorMoveDestination.kind === "shelf"
                      ? mismatch.ownColorMoveDestination.band
                      : item.bandKey,
                  display: bandName(
                    mismatch.ownColorMoveDestination.kind === "shelf"
                      ? mismatch.ownColorMoveDestination.band
                      : item.bandKey,
                  ),
                },
                lineBand: { key: model.line.bandKey, display: model.line.bandDisplay },
                addSub: `takes the line's colour · ${mismatch.lineDestination}`,
                ownSub: `${mismatch.ownColorDestination} · not in a line`,
                picked: colour,
                onPick: setColour,
                onConfirmOwn: () => onConfirmOwnColour(mismatch.ownColorMoveDestination),
              }
            : undefined
        }
      />
    </div>
  );
}
