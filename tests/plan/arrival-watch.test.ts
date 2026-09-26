/**
 * UIL-114 part C — when the Haul Plan asks for cards that arrived while it was open (app/(ui)/plan/arrivals.ts).
 * The Senior BA's ruling: on focus and every 30 s, shaped so Realtime can call the same check later.
 * Pinned with fake timers and stand-in event targets, so no DOM is needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createArrivalWatch } from "@/app/(ui)/plan/arrivals";

function targets() {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
  });
  return { win, doc };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("UIL-114 · asking for arrivals", () => {
  it("asks every 30 s while the page is visible, and not before", async () => {
    const check = vi.fn(async () => {});
    const { win, doc } = targets();
    const watch = createArrivalWatch(check, { win, doc });
    watch.start();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(check).not.toHaveBeenCalled(); // it has only just routed: nothing is new yet
    await vi.advanceTimersByTimeAsync(1_000);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(check).toHaveBeenCalledTimes(2);
    watch.stop();
  });

  it("never asks while the page is hidden", async () => {
    const check = vi.fn(async () => {});
    const { win, doc } = targets();
    doc.visibilityState = "hidden";
    const watch = createArrivalWatch(check, { win, doc });
    watch.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(check).not.toHaveBeenCalled();
    watch.stop();
  });

  it("asks when she comes back to the page, but not twice in a few seconds", async () => {
    const check = vi.fn(async () => {});
    const { win, doc } = targets();
    const watch = createArrivalWatch(check, { win, doc });
    watch.start();
    await vi.advanceTimersByTimeAsync(10_000);
    win.dispatchEvent(new Event("focus"));
    expect(check).toHaveBeenCalledTimes(1);
    doc.dispatchEvent(new Event("visibilitychange")); // the same return, reported twice
    await vi.advanceTimersByTimeAsync(2_000);
    win.dispatchEvent(new Event("focus"));
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(check).toHaveBeenCalledTimes(2);
    watch.stop();
  });

  it("one check at a time: a trigger while one runs is dropped", async () => {
    let finish: () => void = () => {};
    const check = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const { win, doc } = targets();
    const watch = createArrivalWatch(check, { win, doc });
    watch.start();
    void watch.checkNow();
    void watch.checkNow(); // a Realtime event, say, while the first is still out
    await vi.advanceTimersByTimeAsync(30_000);
    expect(check).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(check).toHaveBeenCalledTimes(2);
    watch.stop();
  });

  it("stops asking when the page closes", async () => {
    const check = vi.fn(async () => {});
    const { win, doc } = targets();
    const watch = createArrivalWatch(check, { win, doc });
    watch.start();
    watch.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    win.dispatchEvent(new Event("focus"));
    expect(check).not.toHaveBeenCalled();
  });
});
