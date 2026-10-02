"use client";

/**
 * UIL-130: a spare card coming OUT of its pocket (a card takes the stage, or she changes what fills it) goes back to
 * its home box. Karvi, 2026-09-29: a box with a card limit that is full takes no more ("Stop it, ask for another"),
 * and the Senior BA's condition: a return to bulk her other choice causes asks for a box when home is full, never
 * silently. So each returning card is named with where it goes; with its home box full (or gone), she picks a box
 * before she can confirm.
 *
 * 0037 (Karvi, 2026-10-01/02: "Users should always be able to override all rules"): a full box, her full home too, is
 * offered as well. Picked, it is warned in her words, and it counts only once she taps "Add anyway · N over"; that
 * card then rides in `overFull`, so the write records it with the move.
 */

import type { BulkUnitView } from "@/lib/repo/bulk-unit";
import type { ReturningCard } from "@/lib/line/popup";
import { addAnywayLabel, addAnywayWarning, boxLoad, hasRoom, overBy } from "@/lib/plan/bulk-units";

/** The box a returning card goes to: hers to pick when its home is full or gone, else its home. */
function homeOf(spare: ReturningCard, boxes: readonly BulkUnitView[]) {
  const home = spare.homeBoxId ? boxes.find((u) => u.id === spare.homeBoxId) : undefined;
  return { home, needsPick: !home || !hasRoom(home) };
}

/**
 * Whether every returning card has somewhere to go: its home with room, or a picked box with room, or a full box she
 * said "Add anyway" to (`overFull`).
 */
export function sparesReady(
  spares: readonly ReturningCard[],
  boxes: readonly BulkUnitView[],
  picked: Readonly<Record<string, string>>,
  overFull: readonly string[] = [],
): boolean {
  return spares.every((s) => {
    if (!homeOf(s, boxes).needsPick) return true;
    const box = boxes.find((u) => u.id === picked[s.copyId]);
    return !!box && (hasRoom(box) || overFull.includes(s.copyId));
  });
}

export function ReturningSpares({
  spares,
  boxes,
  picked,
  overFull = [],
  onPick,
  busy = false,
}: {
  spares: readonly ReturningCard[];
  boxes: readonly BulkUnitView[];
  picked: Readonly<Record<string, string>>;
  /** 0037: the cards she sends into a full box knowingly. */
  overFull?: readonly string[];
  /** Her picks, and which of them she sends into a full box knowingly. */
  onPick(next: Record<string, string>, overFull: string[]): void;
  busy?: boolean;
}) {
  if (spares.length === 0) return null;
  /** How many of these cards go into a box: how far over its limit it will be counts them all. */
  const goingTo = (unitId: string) => spares.filter((s) => picked[s.copyId] === unitId).length;
  return (
    <div className="lp-returns" role="group" aria-label="Spare cards going back to the bulk">
      {spares.map((s) => {
        const { home, needsPick } = homeOf(s, boxes);
        if (!needsPick) {
          return (
            <div key={s.copyId} className="lp-mrow">
              <b className="u">Back to bulk</b> {s.name} → {home!.name}
            </div>
          );
        }
        const box = boxes.find((u) => u.id === picked[s.copyId]);
        const full = !!box && !hasRoom(box);
        const knowing = overFull.includes(s.copyId);
        // A pick drops her earlier "Add anyway": a new full box is asked again; one with room needs none.
        const others = overFull.filter((id) => id !== s.copyId);
        return (
          <div key={s.copyId} className="lp-mrow" role="group" aria-label={`Where ${s.name} goes`}>
            <b className="u">Back to bulk</b> {s.name}:{" "}
            {home ? `${home.name} is full (${boxLoad(home)}).` : "its box is gone."} Pick a box:
            <div className="lp-bands">
              {boxes.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  className={"lp-band u" + (picked[s.copyId] === u.id ? " on" : "")}
                  aria-pressed={picked[s.copyId] === u.id}
                  disabled={busy}
                  onClick={() => onPick({ ...picked, [s.copyId]: u.id }, others)}
                >
                  {u.name} · {boxLoad(u)}
                </button>
              ))}
              {full && !knowing ? (
                <button
                  type="button"
                  className="lp-band u"
                  disabled={busy}
                  onClick={() => onPick({ ...picked }, [...others, s.copyId])}
                >
                  {addAnywayLabel(box, goingTo(box.id))}
                </button>
              ) : null}
            </div>
            {full && !knowing ? (
              <div className="lp-error" role="alert">
                {addAnywayWarning(box, goingTo(box.id))}
              </div>
            ) : full ? (
              <div className="lp-note">
                → {box.name} · {overBy(box, goingTo(box.id))} over its limit
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
