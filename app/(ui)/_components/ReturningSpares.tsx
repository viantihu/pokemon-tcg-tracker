"use client";

/**
 * UIL-130: a spare card coming OUT of its pocket (a card takes the stage, or she changes what fills it) goes back to
 * its home box. Karvi, 2026-09-29: a box with a card limit that is full takes no more ("Stop it, ask for another"),
 * and the Senior BA's condition: a return to bulk her other choice causes asks for a box when home is full, never
 * silently. So each returning card is named with where it goes; with its home box full (or gone), she picks a box
 * with room before she can confirm.
 */

import type { BulkUnitView } from "@/lib/repo/bulk-unit";
import type { ReturningCard } from "@/lib/line/popup";
import { boxLoad, hasRoom } from "@/lib/plan/bulk-units";

/** The box a returning card goes to: hers to pick when its home is full or gone, else its home. */
function homeOf(spare: ReturningCard, boxes: readonly BulkUnitView[]) {
  const home = spare.homeBoxId ? boxes.find((u) => u.id === spare.homeBoxId) : undefined;
  return { home, needsPick: !home || !hasRoom(home) };
}

/** Whether every returning card has somewhere to go (its home with room, or a picked box with room). */
export function sparesReady(
  spares: readonly ReturningCard[],
  boxes: readonly BulkUnitView[],
  picked: Readonly<Record<string, string>>,
): boolean {
  return spares.every((s) => {
    if (!homeOf(s, boxes).needsPick) return true;
    const box = boxes.find((u) => u.id === picked[s.copyId]);
    return !!box && hasRoom(box);
  });
}

export function ReturningSpares({
  spares,
  boxes,
  picked,
  onPick,
  busy = false,
}: {
  spares: readonly ReturningCard[];
  boxes: readonly BulkUnitView[];
  picked: Readonly<Record<string, string>>;
  onPick(next: Record<string, string>): void;
  busy?: boolean;
}) {
  if (spares.length === 0) return null;
  const withRoom = boxes.filter((u) => hasRoom(u));
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
        return (
          <div key={s.copyId} className="lp-mrow" role="group" aria-label={`Where ${s.name} goes`}>
            <b className="u">Back to bulk</b> {s.name}:{" "}
            {home ? `${home.name} is full (${boxLoad(home)}).` : "its box is gone."} Pick a box:
            {withRoom.length === 0 ? (
              <div className="lp-error" role="alert">
                Every bulk box is full. Raise a box&apos;s limit in Settings, or add a box.
              </div>
            ) : (
              <div className="lp-bands">
                {withRoom.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    className={"lp-band u" + (picked[s.copyId] === u.id ? " on" : "")}
                    aria-pressed={picked[s.copyId] === u.id}
                    disabled={busy}
                    onClick={() => onPick({ ...picked, [s.copyId]: u.id })}
                  >
                    {u.name} · {boxLoad(u)}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
