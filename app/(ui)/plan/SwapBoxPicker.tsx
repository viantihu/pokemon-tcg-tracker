"use client";

/**
 * 0037 (the Tech Lead's "no dead ends"; Karvi: "Users should always be able to override all rules"): a holo swapped in
 * for her normal in a front half sends the normal to bulk, and with every box full the plan names no box for it, so
 * the swap was refused with nowhere to go. In the spotlight she picks the box for the card it swaps out, as the Move
 * sheet's WHICH BOX does: a full box warns in her words, and counts once she taps "Add anyway · N over" (`overFull`,
 * recorded on the swap's decision). Presentational; the screen holds her pick and sends it with Done.
 */

import type { MoveDestination } from "@/lib/line/types";
import {
  addAnywayLabel,
  addAnywayWarning,
  boxLoad,
  hasRoom,
  overBy,
  type BulkUnitView,
} from "@/lib/plan/bulk-units";

type BulkDestination = Extract<MoveDestination, { kind: "bulk" }>;

/** Whether her pick is somewhere the card can go: a box with room, or a full one she said "Add anyway" to. */
export function swapBoxReady(
  value: BulkDestination | undefined,
  boxes: readonly BulkUnitView[],
): boolean {
  const box = boxes.find((u) => u.id === value?.unitId);
  return !!box && (hasRoom(box) || value?.overFull === true);
}

export function SwapBoxPicker({
  boxes,
  value,
  onPick,
  busy = false,
}: {
  boxes: readonly BulkUnitView[];
  value: BulkDestination;
  onPick(dest: BulkDestination): void;
  busy?: boolean;
}) {
  const box = boxes.find((u) => u.id === value.unitId);
  const full = !!box && !hasRoom(box);
  const knowing = value.overFull === true;
  return (
    <div className="orow swapbox">
      <div className="ol">WHICH BOX FOR THE CARD IT SWAPS OUT</div>
      <div
        className="ochips boxchips"
        role="group"
        aria-label="Which box for the card it swaps out"
      >
        {boxes.map((u) => (
          <button
            key={u.id}
            type="button"
            className={"ochip" + (value.unitId === u.id ? " on" : "")}
            aria-pressed={value.unitId === u.id}
            disabled={busy}
            onClick={() => onPick({ kind: "bulk", unitId: u.id })}
          >
            {u.name} · {boxLoad(u)}
          </button>
        ))}
        {box && full && !knowing ? (
          <button
            type="button"
            className="ochip"
            disabled={busy}
            onClick={() => onPick({ ...value, overFull: true })}
          >
            {addAnywayLabel(box)}
          </button>
        ) : null}
      </div>
      {box && full && !knowing ? (
        <span className="oskip" role="alert">
          {addAnywayWarning(box)}
        </span>
      ) : box && full ? (
        <span className="oskip">
          → {box.name} · {overBy(box)} over its limit
        </span>
      ) : null}
    </div>
  );
}
