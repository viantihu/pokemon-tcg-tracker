/**
 * Noticing cards that arrive while the Haul Plan is open (UIL-114, part C). An import she finishes in
 * another tab, or on her phone, used to reach this page only when she reloaded it; now the page asks.
 *
 * WHEN IT ASKS. When she comes back to the page (the window regains focus, or the tab becomes visible),
 * and every 30 s while the page is visible. Never while it is hidden: nobody is looking, and the
 * return itself triggers a check. One check at a time: a trigger while one is running is dropped, since
 * the running one answers the same question. A trigger within a few seconds of the last check is dropped
 * too, so flicking between tabs does not hammer the server.
 *
 * REALTIME LATER. The Senior BA's ruling: poll now, shaped so Supabase Realtime can take over without a
 * rewrite. A Realtime subscription on copy inserts would call `checkNow()`; what the screen does with
 * the cards that come back does not change. No migration either way.
 *
 * PURE apart from the timer and the two event targets it is handed, so it is pinned without a DOM.
 */

export interface ArrivalWatchOptions {
  intervalMs?: number;
  minGapMs?: number;
  /** Where "focus" fires. The page's `window` unless a test hands in its own. */
  win?: Pick<Window, "addEventListener" | "removeEventListener">;
  /** Where "visibilitychange" fires, and whether the page is visible. The page's `document` by default. */
  doc?: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">;
}

/**
 * Ask `check` when she returns to the page and every `intervalMs` while it is visible. `check` must not
 * throw; the screen's check reaches the server through `reach` and stays quiet when it cannot.
 */
export function createArrivalWatch(
  check: () => Promise<void>,
  { intervalMs = 30_000, minGapMs = 5_000, win, doc }: ArrivalWatchOptions = {},
) {
  const w = win ?? window;
  const d = doc ?? document;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  // The page has just routed (or resumed) when this starts, so nothing is new yet.
  let last = Date.now();

  async function checkNow(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    last = Date.now();
    try {
      await check();
    } finally {
      inFlight = false;
    }
  }

  function onTrigger(): void {
    if (d.visibilityState !== "visible") return;
    if (Date.now() - last < minGapMs) return;
    void checkNow();
  }

  return {
    start(): void {
      if (timer) return;
      timer = setInterval(onTrigger, intervalMs);
      w.addEventListener("focus", onTrigger);
      d.addEventListener("visibilitychange", onTrigger);
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
      w.removeEventListener("focus", onTrigger);
      d.removeEventListener("visibilitychange", onTrigger);
    },
    /** Ask now, whatever the timer says: for a Realtime event later. Still one at a time. */
    checkNow,
  };
}
