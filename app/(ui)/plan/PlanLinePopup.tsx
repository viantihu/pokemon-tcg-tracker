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
 * confirm, unless its line is then DONE (UIL-120, `lineDoneFor`), so a confirm that will leave it done does not say
 * "· next". Escape cancels, through the app's layer stack.
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
import { lineDoneFor } from "@/lib/plan/line-done";

export function PlanLinePopup({
  item,
  copyId,
  moveOptions,
  loadModelFor,
  bandMismatch,
  position,
  extraCopy = false,
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
  /**
   * "Line card k of N" in this haul, and whether another unshelved line card remains after this one. Absent for the
   * swap on a plain extra copy (UIL-126), which is not in the step-through.
   */
  position?: { index: number; total: number; next: boolean };
  /**
   * UIL-126: opened from a plain extra copy's "⇄ Swap this one into the line…". Swap is picked, the card coming out to
   * bulk; Keep is her normal Done, this card to where an extra copy goes (the front half), named in the popup.
   */
  extraCopy?: boolean;
  busy: boolean;
  error: string | null;
  /** Her confirm, with the line's name as the popup shows it (its top stage), or null when it has none. */
  onConfirm(choice: LineChoice, lineName: string | null): void;
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

  const holo = proposal.kind === "replace" && !proposal.defaultKeep && !extraCopy;
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
  // UIL-120: when this confirm leaves its line DONE the screen stops stepping, so the button does not say "· next".
  // The forecast is the server's one rule over the slots as they will be: the card going in (or the one kept there),
  // every card already here, a pull only if she ticked it, a block as a block. Filing by its own colour is no line.
  const ticked = value.mode === "start" ? value.pulls : [];
  const completes =
    colour !== "own" &&
    lineDoneFor(
      model.stages.map((st) =>
        st.state === "incoming" || st.state === "here"
          ? "filled"
          : st.state === "blocked"
            ? "block"
            : st.state === "pullable" && st.pull && ticked.includes(st.pull.copyId)
              ? "filled"
              : "placeholder",
      ),
      // The line's status as it stands (null for a start): a line that already reads CLOSED is done, a stage she
      // left empty with it (QA on #423; the same rule the server answers with).
      model.line.status,
    );

  return (
    <div className="lp-overlay">
      <LinePopup
        model={model}
        value={value}
        onChange={setValue}
        onCancel={onCancel}
        onConfirm={(choice) => onConfirm(choice, model.stages.at(-1)?.card?.name ?? null)}
        onSwitch={(p) => setProposal(p)}
        position={position ? { ...position, next: position.next && !completes } : undefined}
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
