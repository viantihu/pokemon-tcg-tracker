"use client";

/**
 * "Remove" on a copy row — the one affordance, on every surface that shows a copy (UIL-089).
 *
 * Karvi: "no reason is necessary." So there is no reason field, no dropdown of why, and no list of gone
 * cards to maintain. Traded, lost, miscounted: the app's job is to stop claiming she has it.
 *
 * ONE COMPONENT RATHER THAN FOUR BUTTONS. Lookup, the Line slot, the Haul Plan queue and Collections all
 * show a copy, and all four need this. Written once so the wording, the confirm step and the busy state
 * cannot drift apart between screens — the "one vocabulary" rule the refusal strings already follow.
 *
 * A TWO-TAP CONFIRM, and it is not a reason prompt. The write deletes a row and there is no undo for it
 * (Sync Undo reverses an import, not a hand removal), so a mis-tap on a phone at a card show would
 * silently cost her a card. The second tap says what will happen in her own terms; it asks nothing.
 *
 * Styled with the existing `btn-primary` for the confirming tap rather than a new destructive variant:
 * globals.css has no danger modifier, and inventing one here would put a style with no home in a
 * component file. If removal ever earns its own colour, it belongs in the stylesheet with the rest.
 */

import { useState } from "react";

export function RemoveCopyButton({
  onRemove,
  busy = false,
  label = "Remove",
  what = "this copy",
}: {
  onRemove: () => void | Promise<void>;
  busy?: boolean;
  /** The resting label. "Remove" everywhere except where a row needs to say what it removes. */
  label?: string;
  /** Named in the confirm, so the second tap is about a specific card and not about a button. */
  what?: string;
}) {
  const [armed, setArmed] = useState(false);

  if (!armed) {
    return (
      <button
        type="button"
        className="btn sm"
        disabled={busy}
        onClick={() => setArmed(true)}
        aria-label={`Remove ${what}`}
      >
        {label}
      </button>
    );
  }
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <span style={{ color: "var(--ink-2)" }}>Remove {what}?</span>
      <button
        type="button"
        className="btn sm btn-primary"
        disabled={busy}
        onClick={async () => {
          // Stays armed while the write is in flight: the row usually disappears on success, and if it
          // fails she is looking at the same decision she just made rather than a reset button. Disarmed
          // even if `onRemove` throws, so the row never sits armed for ever (UIL-106). Saying what went
          // wrong is the caller's job, which is why every caller goes through `reach` and never throws.
          try {
            await onRemove();
          } catch {
            // Nothing to show here: this button has no message of its own.
          } finally {
            setArmed(false);
          }
        }}
      >
        {busy ? "Removing…" : "Yes, remove"}
      </button>
      <button type="button" className="btn sm" disabled={busy} onClick={() => setArmed(false)}>
        Keep it
      </button>
    </span>
  );
}
