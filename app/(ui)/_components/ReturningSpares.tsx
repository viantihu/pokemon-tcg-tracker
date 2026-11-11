"use client";

/**
 * UIL-130: a spare card coming OUT of its pocket (a card takes the stage, or she changes what fills it) goes back to
 * its home box. Karvi, 2026-09-29: a box with a card limit that is full takes no more ("Stop it, ask for another"),
 * and the Senior BA's condition: a return to bulk her other choice causes asks for a box when home is full, never
 * silently. So each returning card is named with where it goes; with its home box full (or gone), she picks a box
 * before she can confirm.
 *
 * A full box takes no more cards, however she got here: it is shown, greyed with why, and cannot be picked. With every
 * box full there is nowhere to send the card, so confirming waits and she is told how to make room.
 */

import type { BulkUnitView } from "@/lib/repo/bulk-unit";
import type { ReturningCard } from "@/lib/line/popup";
import { boxLoad, fullBoxReason, hasRoom } from "@/lib/plan/bulk-units";

/** The box a returning card goes to: hers to pick when its home is full or gone, else its home. */
function homeOf(spare: ReturningCard, boxes: readonly BulkUnitView[]) {
  const home = spare.homeBoxId ? boxes.find((u) => u.id === spare.homeBoxId) : undefined;
  return { home, needsPick: !home || !hasRoom(home) };
}

/** Where each returning card goes: its home when that has room, else the box she picked (absent: nowhere yet). */
function destinations(
  spares: readonly ReturningCard[],
  boxes: readonly BulkUnitView[],
  picked: Readonly<Record<string, string>>,
): Map<string, string | undefined> {
  return new Map(
    spares.map((s) => {
      const { home, needsPick } = homeOf(s, boxes);
      return [s.copyId, needsPick ? picked[s.copyId] : home!.id];
    }),
  );
}

/** How many of these cards go into each box: the box's room has to hold them all, not each on its own. */
function goingTo(dest: ReadonlyMap<string, string | undefined>): Map<string, number> {
  const n = new Map<string, number>();
  for (const id of dest.values()) if (id) n.set(id, (n.get(id) ?? 0) + 1);
  return n;
}

/** Whether every returning card has somewhere to go that has room for all the cards headed there. */
export function sparesReady(
  spares: readonly ReturningCard[],
  boxes: readonly BulkUnitView[],
  picked: Readonly<Record<string, string>>,
): boolean {
  const dest = destinations(spares, boxes, picked);
  const load = goingTo(dest);
  return spares.every((s) => {
    const box = boxes.find((u) => u.id === dest.get(s.copyId));
    return !!box && hasRoom(box, load.get(box.id) ?? 1);
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
  const load = goingTo(destinations(spares, boxes, picked));
  return (
    <div className="lp-returns" role="group" aria-label="Spare cards going back to the bulk">
      {spares.map((s) => {
        const { home, needsPick } = homeOf(s, boxes);
        if (!needsPick) {
          // Room for this card alone, but not for every card headed to the same box.
          const crowded = !hasRoom(home!, load.get(home!.id) ?? 1);
          return (
            <div key={s.copyId} className="lp-mrow">
              <b className="u">Back to bulk</b> {s.name} → {home!.name}
              {crowded ? (
                <div className="lp-error" role="alert">
                  {home!.name} has no room for all {load.get(home!.id)} cards going back to it (
                  {boxLoad(home!)}). Raise its limit or add a box in Settings first.
                </div>
              ) : null}
            </div>
          );
        }
        // Room for this card on top of the others already headed to a box (its own pick is not counted twice).
        const roomFor = (u: BulkUnitView) =>
          hasRoom(u, (load.get(u.id) ?? 0) + (picked[s.copyId] === u.id ? 0 : 1));
        const none = !boxes.some(roomFor);
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
                  disabled={busy || !roomFor(u)}
                  title={roomFor(u) ? undefined : fullBoxReason(u)}
                  onClick={() => onPick({ ...picked, [s.copyId]: u.id })}
                >
                  {u.name} · {boxLoad(u)}
                </button>
              ))}
            </div>
            {none ? (
              <div className="lp-error" role="alert">
                Every bulk box is full. Raise a box&apos;s limit or add a box in Settings first.
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
