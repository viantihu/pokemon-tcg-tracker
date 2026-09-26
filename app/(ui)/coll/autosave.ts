/**
 * Debounced, serialized autosave scheduler (UIL-038).
 *
 * Debouncing alone gives you "don't save on every keystroke." It does NOT give you two things a
 * passive save loop needs to be correct:
 *
 *   - IN-ORDER DELIVERY. A fast name-edit-then-target-add must not let the target-add's request
 *     resolve before the name-edit's — network timing has no reason to respect call order, and if it
 *     doesn't, the later request's response would silently be overwritten by the earlier one landing
 *     after it.
 *   - LAST-WINS. Only the most recent value at the moment a save actually fires needs to go out — an
 *     intermediate keystroke never needs its own round trip.
 *
 * Serializing gets both for free: chaining each save onto the promise of the one before it means no
 * two saves are ever in flight at once, so completion order is call order by construction, and the
 * debounce timer collapses a burst of `schedule()` calls to whatever `latest` holds when it fires.
 *
 * No React import on purpose — a `useRef`/`useEffect` wrapper owns the lifecycle; this module is pure
 * scheduling logic, testable with fake timers and manually-resolved promises, no DOM required.
 *
 * A SAVE THAT THROWS DOES NOT BREAK THE QUEUE (UIL-106). A server action throws when it cannot reach the
 * server at all — the app was redeployed under an open page, or the connection dropped — and the chain used
 * to be `pending.then(() => save(v))` with no rejection handler: one throw left `pending` rejected, so every
 * later save's `.then` was skipped SILENTLY and every `flush()` rejected, stranding Close and "Search & add"
 * on "Saving…". Now a throw is caught, reported through `onError`, and the value it was carrying is KEPT as
 * the one to send next (unless a newer edit already replaced it — saves carry the whole state, so the newer
 * one includes it). The next `schedule()` or `flush()` sends it again; `flush()` NEVER rejects, and resolves
 * to whether everything up to that point was saved, so an exit can decide what to tell her.
 */

export interface AutosaveScheduler<T> {
  /** Record a new value and (re)start the debounce window. */
  schedule(value: T): void;
  /**
   * Save immediately: skip the remaining debounce wait, but still queue behind any save already in
   * flight. Call this before anything that ends the editing session (closing, navigating away) so a
   * pending edit is never dropped for having arrived less than `delayMs` before the exit.
   *
   * Never rejects. Resolves `true` when everything scheduled so far has been saved, `false` when the last
   * save threw — its value is kept, and goes out with the next `schedule()` or `flush()` (UIL-106).
   */
  flush(): Promise<boolean>;
}

/**
 * Flush before navigating, never navigate first — a plain `<Link>` out of an editing session skips
 * this ordering entirely, which is exactly how a pending debounce lost an edit here once (UIL-038
 * follow-up, caught by QA on #155). `navigate` runs only after `flush()`'s promise settles, so this is
 * safe to reuse for every exit path a scheduler-backed editor grows, not just the one that got missed.
 */
export async function flushBeforeNavigate<T>(
  autosave: AutosaveScheduler<T>,
  navigate: () => void,
): Promise<boolean> {
  // Only a flush that SAVED navigates (UIL-106): leaving over an unsaved edit would reopen the editor from
  // server state without it. The caller says why she is still here.
  const saved = await autosave.flush();
  if (saved) navigate();
  return saved;
}

export function createAutosaveScheduler<T>(
  save: (value: T) => Promise<void>,
  delayMs = 500,
  /** Told when a save THROWS (UIL-106): the screen says so. The value is kept for the next save. */
  onError?: (error: unknown) => void,
): AutosaveScheduler<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Promise<boolean> = Promise.resolve(true);
  let latest: T | undefined;
  let hasLatest = false;

  function enqueue(): void {
    if (!hasLatest) return;
    const value = latest as T;
    hasLatest = false;
    pending = pending.then(async () => {
      try {
        await save(value);
        return true;
      } catch (error) {
        // Keep it to send again — unless a newer edit has arrived, which carries it (whole-state saves).
        if (!hasLatest) {
          latest = value;
          hasLatest = true;
        }
        onError?.(error);
        return false;
      }
    });
  }

  return {
    schedule(value: T): void {
      latest = value;
      hasLatest = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        enqueue();
      }, delayMs);
    },
    flush(): Promise<boolean> {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      enqueue();
      return pending;
    },
  };
}
