/**
 * UIL-038's autosave scheduler — the two properties debouncing alone doesn't give: LAST-WINS (a burst
 * of edits collapses to one save of the latest value) and IN-ORDER, SERIALIZED delivery (no save ever
 * starts before the one before it has resolved, so completion order can't scramble call order).
 *
 * Pure module, no DOM: fake timers stand in for the debounce delay, manually-resolved promises stand
 * in for a real network round trip whose timing we don't control.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutosaveScheduler, flushBeforeNavigate } from "@/app/(ui)/coll/autosave";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createAutosaveScheduler", () => {
  it("collapses a burst of schedule() calls to one save of the latest value", async () => {
    const save = vi.fn(async () => {});
    const s = createAutosaveScheduler(save, 500);
    s.schedule(1);
    s.schedule(2);
    s.schedule(3);
    await vi.advanceTimersByTimeAsync(500);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(3);
  });

  it("never starts a second save before the first has resolved — in-order, serialized delivery", async () => {
    const order: string[] = [];
    const first = deferred<void>();
    const save = vi.fn((v: string) => {
      order.push(`start:${v}`);
      return v === "A" ? first.promise : Promise.resolve();
    });
    const s = createAutosaveScheduler(save, 100);

    s.schedule("A");
    await vi.advanceTimersByTimeAsync(100);
    expect(order).toEqual(["start:A"]);

    // B's debounce elapses while A is still unresolved. Its save must not start yet, even though the
    // timer fired — that is exactly the race a plain (non-serialized) debounce would lose.
    s.schedule("B");
    await vi.advanceTimersByTimeAsync(100);
    expect(order).toEqual(["start:A"]);
    expect(save).toHaveBeenCalledTimes(1);

    first.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["start:A", "start:B"]);
  });

  it("flush() saves a still-pending value immediately, without waiting out the debounce delay", async () => {
    const save = vi.fn(async () => {});
    const s = createAutosaveScheduler(save, 10_000); // long enough that waiting it out would time out
    s.schedule("X");
    await s.flush();
    expect(save).toHaveBeenCalledWith("X");
  });

  it("flush() with nothing newly scheduled does not call save again", async () => {
    const save = vi.fn(async () => {});
    const s = createAutosaveScheduler(save, 50);
    s.schedule("Y");
    await vi.advanceTimersByTimeAsync(50);
    expect(save).toHaveBeenCalledTimes(1);

    await s.flush();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("flush() still waits for an in-flight save to settle before resolving", async () => {
    const inFlight = deferred<void>();
    const save = vi.fn(async () => inFlight.promise);
    const s = createAutosaveScheduler(save, 10);
    s.schedule("Z");
    await vi.advanceTimersByTimeAsync(10);
    expect(save).toHaveBeenCalledTimes(1);

    let flushed = false;
    const flushPromise = s.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false); // the in-flight save hasn't resolved yet

    inFlight.resolve();
    await flushPromise;
    expect(flushed).toBe(true);
  });
});

describe("flushBeforeNavigate", () => {
  it("never navigates before the flush's save has resolved — the bug a bare <Link> reintroduced", async () => {
    const order: string[] = [];
    const inFlight = deferred<void>();
    const save = vi.fn(() => {
      order.push("save:start");
      return inFlight.promise.then(() => {
        order.push("save:done");
      });
    });
    const s = createAutosaveScheduler(save, 600);
    s.schedule("edited name");

    const navigate = vi.fn(() => order.push("navigate"));
    const done = flushBeforeNavigate(s, navigate);

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["save:start"]);
    expect(navigate).not.toHaveBeenCalled();

    inFlight.resolve();
    await done;
    expect(order).toEqual(["save:start", "save:done", "navigate"]);
  });

  it("still navigates when there was nothing pending to flush", async () => {
    const save = vi.fn(async () => {});
    const s = createAutosaveScheduler(save, 600);
    const navigate = vi.fn();

    await flushBeforeNavigate(s, navigate);
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});
