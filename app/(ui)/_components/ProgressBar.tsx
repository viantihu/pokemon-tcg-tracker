/**
 * Activity bar for operations long enough that silence reads as a hang (UIL-008).
 *
 * "Anytime there's a longer process (syncing inventory, creating haul plan), I want to see a progress
 * bar." Today both show only a disabled button with a swapped label, which answers "did my click
 * register" but not "is this working or stuck".
 *
 * DELIBERATELY INDETERMINATE. Neither operation can report real progress: each is a single server action
 * that returns once, so there is nothing to poll or stream mid-flight. A determinate bar would have to
 * animate on a timer, and a bar that moves without tracking real work is worse than no bar — it teaches
 * her to distrust it, and the first time it sits at 90% while the operation is actually finished it has
 * cost more than it gave. So this reports only what is honestly known: something is running, and which
 * stage it is in. The stage labels come from real state transitions (the Sync screen's `Phase`), not
 * from a clock.
 *
 * `prefers-reduced-motion` is respected: the animation is suppressed in CSS and the bar renders as a
 * static striped fill, which still says "working" without moving.
 */

export function ProgressBar({ label }: { label: string }) {
  return (
    <div
      className="pbar"
      role="progressbar"
      aria-busy="true"
      aria-label={label}
      // No aria-valuenow/min/max: omitting them is how ARIA states "indeterminate". Supplying a
      // made-up value would lie to a screen reader as much as a timer-driven bar lies to the eye.
    >
      <i className="pbfill" aria-hidden />
      <span className="pblabel u">{label}</span>
    </div>
  );
}
