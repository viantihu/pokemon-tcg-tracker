/**
 * UIL-114 — re-routing an open Haul Plan, the pure half (app/(ui)/plan/reroute.ts): what the plan becomes when
 * a card leaves it, what a re-route keeps and names, and when the server is asked (batched, because one
 * route of her full haul takes 2.3–2.9 s: tests/perf/haul-plan-timing.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRerouteBatcher,
  dropFromPlan,
  flattenPlan,
  mergeReroute,
} from "@/app/(ui)/plan/reroute";
import { routedPlan } from "../support/plan-route";

const draft = (...names: string[]) =>
  names.map((n) => ({
    id: `id-${n}`,
    tcgdexId: `sv09-${n}`,
    variant: "normal" as const,
    existingCopyId: `id-${n}`,
  }));

describe("UIL-114 · a card leaving the plan", () => {
  it("drops it and recounts, and keeps the rest in the same order", () => {
    const plan = routedPlan(draft("Abra", "Kadabra", "Alakazam"));
    const out = dropFromPlan(plan, new Set(["id-Kadabra"]));
    expect(flattenPlan(out).map((i) => i.name)).toEqual(["Abra", "Alakazam"]);
    expect(out.summary.total).toBe(2);
    expect(out.bands).toEqual([{ key: "orange", count: 2 }]);
  });
});

describe("UIL-114 · merging a re-route", () => {
  const prev = routedPlan(draft("Abra", "Kadabra", "Alakazam"));

  it("keeps every SHELVED card exactly as it was, and takes the waiting ones as newly routed", () => {
    // The server routed only the waiting cards, and sent Kadabra somewhere else.
    const next = routedPlan(draft("Kadabra", "Alakazam"), undefined, (id) =>
      id === "id-Kadabra" ? "KB-002 · Back · Orange" : "KB-001 · Front · Orange",
    );
    const { plan, moved } = mergeReroute(prev, next, new Set(["id-Abra"]));
    const byName = new Map(flattenPlan(plan).map((i) => [i.name, i.destination]));
    expect([...byName.keys()].sort()).toEqual(["Abra", "Alakazam", "Kadabra"]);
    expect(byName.get("Kadabra")).toBe("KB-002 · Back · Orange");
    // Named, so no waiting card moves silently.
    expect(moved).toEqual([
      { incomingId: "id-Kadabra", name: "Kadabra", destination: "KB-002 · Back · Orange" },
    ]);
  });

  it("never replaces a shelved card with the server's answer for it", () => {
    const next = routedPlan(draft("Abra"), undefined, () => "KB-009 · Back · Orange");
    const { plan, moved } = mergeReroute(prev, next, new Set(["id-Abra"]));
    expect(flattenPlan(plan).find((i) => i.name === "Abra")?.destination).toBe(
      "KB-001 · Front · Orange",
    );
    expect(moved).toEqual([]);
  });

  it("names nothing when no waiting card's home changed", () => {
    const { moved } = mergeReroute(
      prev,
      routedPlan(draft("Kadabra", "Alakazam")),
      new Set(["id-Abra"]),
    );
    expect(moved).toEqual([]);
  });

  it("names a card the plan did not hold before as ADDED, not moved (an arrival, UIL-114 part C)", () => {
    const next = routedPlan(draft("Kadabra", "Alakazam", "Machop"), undefined, (id) =>
      id === "id-Machop" ? "KB-002 · Front · Orange" : "KB-001 · Front · Orange",
    );
    const { plan, moved, added } = mergeReroute(prev, next, new Set(["id-Abra"]));
    expect(added).toEqual([
      { incomingId: "id-Machop", name: "Machop", destination: "KB-002 · Front · Orange" },
    ]);
    expect(moved).toEqual([]);
    expect(flattenPlan(plan).map((i) => i.name)).toContain("Machop");
  });

  it("groups by the server's band order, falling back to the plan's own for one parked before UIL-114", () => {
    const old = { ...prev, orderedBandKeys: undefined };
    const next = { ...routedPlan(draft("Kadabra")), orderedBandKeys: undefined };
    expect(() => mergeReroute(old, next, new Set())).not.toThrow();
    expect(mergeReroute(old, next, new Set()).plan.orderedBandKeys).toEqual(["orange"]);
  });
});

describe("UIL-114 · when the server is asked", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("once, a moment after the LAST of several quick presses", async () => {
    const run = vi.fn(async () => {});
    const b = createRerouteBatcher(run, 1500);
    b.schedule();
    await vi.advanceTimersByTimeAsync(1000);
    b.schedule();
    await vi.advanceTimersByTimeAsync(1000);
    b.schedule();
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("one at a time, with exactly one more queued however many presses arrive while one runs", async () => {
    let finish: () => void = () => {};
    const run = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const b = createRerouteBatcher(run, 10);
    b.schedule();
    await vi.advanceTimersByTimeAsync(10);
    expect(run).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 3; i++) {
      b.schedule();
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(run).toHaveBeenCalledTimes(1); // still in flight: the rest waits
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2); // exactly one queued run, not three
    finish();
    await vi.advanceTimersByTimeAsync(50);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("cancel drops a pending run", async () => {
    const run = vi.fn(async () => {});
    const b = createRerouteBatcher(run, 100);
    b.schedule();
    b.cancel();
    await vi.advanceTimersByTimeAsync(200);
    expect(run).not.toHaveBeenCalled();
  });
});
