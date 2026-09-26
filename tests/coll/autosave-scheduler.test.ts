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

/** Let every queued microtask run (fake timers do not advance promise callbacks by themselves). */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
    // Drain microtasks rather than count them: the chain's depth is an implementation detail (UIL-106 added
    // a catch to it). What this pins is the ORDER — B only ever starts after A resolves.
    await settle();
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

describe("UIL-106 · a save that cannot reach the server does not break the queue", () => {
  it("one failure, then the next edit SAVES (it used to be skipped silently, forever)", async () => {
    const saved: string[] = [];
    let fail = true;
    const save = vi.fn(async (v: string) => {
      if (fail) {
        fail = false;
        throw new TypeError("Failed to fetch");
      }
      saved.push(v);
    });
    const onError = vi.fn();
    const s = createAutosaveScheduler(save, 100, onError);

    s.schedule("A");
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(onError).toHaveBeenCalledTimes(1);

    s.schedule("B");
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(saved).toEqual(["B"]);
  });

  it("flush() never rejects: false after a failure, and it sends the kept value again", async () => {
    const saved: string[] = [];
    let fail = true;
    const s = createAutosaveScheduler(async (v: string) => {
      if (fail) {
        fail = false;
        throw new Error("network");
      }
      saved.push(v);
    }, 10_000);

    s.schedule("A");
    await expect(s.flush()).resolves.toBe(false);
    // Nothing new was typed: the flush re-sends A, which lands this time.
    await expect(s.flush()).resolves.toBe(true);
    expect(saved).toEqual(["A"]);
    // And with nothing left to send, it stays true.
    await expect(s.flush()).resolves.toBe(true);
    expect(saved).toEqual(["A"]);
  });

  it("a newer edit replaces the kept value — whole-state saves, so the newer one carries it", async () => {
    const saved: string[] = [];
    let fail = true;
    const s = createAutosaveScheduler(async (v: string) => {
      if (fail) {
        fail = false;
        throw new Error("network");
      }
      saved.push(v);
    }, 10_000);
    s.schedule("A");
    await s.flush();
    s.schedule("B");
    await expect(s.flush()).resolves.toBe(true);
    expect(saved).toEqual(["B"]);
  });

  it("a newer edit made WHILE the failing save was in flight wins — the failed value never overwrites it", async () => {
    const saved: string[] = [];
    const a = deferred<void>();
    const s = createAutosaveScheduler((v: string) => {
      if (v === "A") return a.promise;
      saved.push(v);
      return Promise.resolve();
    }, 10_000);
    s.schedule("A");
    const first = s.flush(); // A is in flight
    s.schedule("B"); // she keeps typing
    a.reject(new Error("network"));
    await expect(first).resolves.toBe(false);
    await expect(s.flush()).resolves.toBe(true);
    // B carries everything A had; A must not come back and replace it.
    expect(saved).toEqual(["B"]);
  });

  it("a save that throws synchronously recovers the same way", async () => {
    let calls = 0;
    const s = createAutosaveScheduler((v: string) => {
      calls += 1;
      if (calls === 1) throw new Error(`sync ${v}`);
      return Promise.resolve();
    }, 10_000);
    s.schedule("A");
    await expect(s.flush()).resolves.toBe(false);
    await expect(s.flush()).resolves.toBe(true);
    expect(calls).toBe(2);
  });

  it("flushBeforeNavigate leaves only when everything saved", async () => {
    const navigate = vi.fn();
    let fail = true;
    const s = createAutosaveScheduler(async () => {
      if (fail) {
        fail = false;
        throw new Error("network");
      }
    }, 10_000);
    s.schedule("A");
    await expect(flushBeforeNavigate(s, navigate)).resolves.toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    await expect(flushBeforeNavigate(s, navigate)).resolves.toBe(true);
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});
