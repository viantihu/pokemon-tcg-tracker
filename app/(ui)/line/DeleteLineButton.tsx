"use client";

/**
 * "Delete line" in a line's header (UIL-118). Karvi: "I need the ability to delete lines… I want to get rid of
 * them, and users should be able to as well."
 *
 * A TWO-TAP CONFIRM, like RemoveCopyButton, and for the same reason: there is no undo. The first tap asks the
 * server what would go, from fresh state, and the second tap is about exactly that: "Its 3 empty slots go, and 2
 * cards come off your wishlist that it was waiting for. Nothing in your binders moves." When the line cannot go
 * yet (it holds cards, or a block), the reason is shown in her words instead, and nothing is offered to confirm.
 *
 * A line that visibly holds cards says so without asking: the button is disabled with the reason beside it.
 */

import { useState } from "react";
import type { LineDeletion } from "@/lib/line/delete";

type Check = { ok: true; deletion: LineDeletion } | { ok: false; error: string };

/** What the second tap confirms, in her words. */
export function deletionSentence(speciesLabel: string, d: LineDeletion): string {
  const slots = d.emptySlots === 1 ? "Its empty slot goes" : `Its ${d.emptySlots} empty slots go`;
  const wishes =
    d.openWishes === 0
      ? ""
      : d.openWishes === 1
        ? ", and 1 card comes off your wishlist that it was waiting for"
        : `, and ${d.openWishes} cards come off your wishlist that it was waiting for`;
  return `Delete the ${speciesLabel}? ${slots}${wishes}. Nothing in your binders moves.`;
}

export function DeleteLineButton({
  speciesLabel,
  heldCards,
  check,
  onDelete,
  busy = false,
}: {
  speciesLabel: string;
  /** Cards the page shows in this line; when any, the line cannot be deleted yet and says so. */
  heldCards: number;
  /** Ask the server what deleting it would remove, or why it cannot go. Must not throw. */
  check: () => Promise<Check>;
  onDelete: () => void | Promise<void>;
  busy?: boolean;
}) {
  const [state, setState] = useState<
    | { kind: "rest" }
    | { kind: "asking" }
    | { kind: "armed"; deletion: LineDeletion }
    | { kind: "no"; why: string }
  >({ kind: "rest" });

  if (heldCards > 0) {
    return (
      <span className="dlrow">
        <button type="button" className="btn sm" disabled>
          Delete line
        </button>
        <span className="dlwhy">
          Move its {heldCards} card{heldCards === 1 ? "" : "s"} out first
        </span>
      </span>
    );
  }

  if (state.kind === "rest" || state.kind === "asking") {
    return (
      <button
        type="button"
        className="btn sm"
        disabled={busy || state.kind === "asking"}
        aria-label={`Delete the ${speciesLabel}`}
        onClick={async () => {
          setState({ kind: "asking" });
          const res = await check();
          setState(
            res.ok ? { kind: "armed", deletion: res.deletion } : { kind: "no", why: res.error },
          );
        }}
      >
        {state.kind === "asking" ? "Checking…" : "Delete line"}
      </button>
    );
  }

  if (state.kind === "no") {
    return (
      <span className="dlrow" role="status">
        <span className="dlwhy">{state.why}</span>
        <button type="button" className="btn sm" onClick={() => setState({ kind: "rest" })}>
          OK
        </button>
      </span>
    );
  }

  return (
    <span className="dlrow">
      <span className="dlwhy">{deletionSentence(speciesLabel, state.deletion)}</span>
      <button
        type="button"
        className="btn sm btn-primary"
        disabled={busy}
        onClick={async () => {
          // Disarmed even if the write fails, so the header never sits armed for ever (UIL-106); saying what
          // went wrong is the caller's job, through `reach`.
          try {
            await onDelete();
          } catch {
            // Nothing to show here: this button has no message of its own.
          } finally {
            setState({ kind: "rest" });
          }
        }}
      >
        {busy ? "Deleting…" : "Yes, delete line"}
      </button>
      <button
        type="button"
        className="btn sm"
        disabled={busy}
        onClick={() => setState({ kind: "rest" })}
      >
        Keep it
      </button>
    </span>
  );
}
