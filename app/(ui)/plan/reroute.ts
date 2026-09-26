/**
 * Re-routing a Haul Plan that is already open (UIL-114). PURE, so the screen's two moving parts are pinned
 * without a DOM: what the plan becomes, and when the server is asked.
 *
 * WHY RE-ROUTE AT ALL. The cascade places each card against everything else in the haul: a card can be a
 * line's pull, the second copy that sends another to the bulk box, a duplicate the plan counted. So when a
 * card leaves the plan ("Not mine", "Leave for later"), or new ones arrive (UIL-114's next PR), the other
 * cards' homes can change. The server routes the cards still waiting again; this keeps what she has
 * already shelved exactly as it was, and names any waiting card whose home moved.
 *
 * WHY BATCH. One route of her full haul takes 2.3–2.9 s (tests/perf/haul-plan-timing.test.ts: 720 waiting
 * copies over 693 keys, a ~36k-card catalog). Over the Senior BA's ~2 s line, so presses are batched: the
 * card leaves the plan at once, and ONE re-route runs a moment after the last press; if one is already
 * running, exactly one more is queued, never a pile.
 */

import { groupPlan } from "@/lib/plan/group";
import type { PlanItem } from "@/lib/plan";
import type { RunPlanResult } from "./plan-types";

export function flattenPlan(plan: RunPlanResult): PlanItem[] {
  return plan.groups.flatMap((g) => g.subgroups.flatMap((s) => s.rows));
}

/** The band order to group by: the server's full rainbow order, else the order the plan already shows. */
function bandOrder(...plans: RunPlanResult[]): string[] {
  for (const p of plans) if (p.orderedBandKeys?.length) return p.orderedBandKeys;
  return [...new Set(plans.flatMap((p) => p.groups.map((g) => g.bandKey)))];
}

/** A plan built from these items, grouped and counted the way `runHaulPlan` builds one. */
function planOf(
  items: PlanItem[],
  order: string[],
  blockNeeds: RunPlanResult["blockNeeds"],
): RunPlanResult {
  const groups = groupPlan(items, order);
  const byAction: Record<string, number> = {};
  for (const it of items) byAction[it.action] = (byAction[it.action] ?? 0) + 1;
  return {
    groups,
    blockNeeds,
    bands: groups.map((g) => ({ key: g.bandKey, count: g.count })),
    summary: {
      total: items.length,
      decisions: items.filter((it) => it.needsDecision).length,
      byAction,
    },
    orderedBandKeys: order,
  };
}

/** The plan without these cards: what she sees the moment she presses "Not mine" or "Leave for later". */
export function dropFromPlan(plan: RunPlanResult, ids: ReadonlySet<string>): RunPlanResult {
  return planOf(
    flattenPlan(plan).filter((it) => !ids.has(it.incomingId)),
    bandOrder(plan),
    plan.blockNeeds,
  );
}

/** A waiting card whose home a re-route changed, named so it never moves silently. */
export interface MovedCard {
  incomingId: string;
  name: string;
  destination: string;
}

/**
 * The plan after a re-route: every card she has SHELVED kept exactly as it was (it is written; the server
 * routed only the waiting ones), every waiting card as the server now routes it, and the waiting cards whose
 * home changed.
 */
export function mergeReroute(
  prev: RunPlanResult,
  next: RunPlanResult,
  done: ReadonlySet<string>,
): { plan: RunPlanResult; moved: MovedCard[] } {
  const before = new Map(flattenPlan(prev).map((it) => [it.incomingId, it]));
  const kept = flattenPlan(prev).filter((it) => done.has(it.incomingId));
  const routed = flattenPlan(next).filter((it) => !done.has(it.incomingId));
  const moved: MovedCard[] = [];
  for (const it of routed) {
    const was = before.get(it.incomingId);
    if (was && (was.destination !== it.destination || was.action !== it.action)) {
      moved.push({ incomingId: it.incomingId, name: it.name, destination: it.destination });
    }
  }
  return {
    plan: planOf([...kept, ...routed], bandOrder(next, prev), next.blockNeeds),
    moved,
  };
}

/**
 * When to ask the server: `delayMs` after the LAST `schedule()`, one run at a time, and at most one more
 * queued behind a run in flight (however many presses arrive meanwhile, since the queued run reads the latest
 * state). `run` must not throw; the screen's re-route catches its own failures.
 */
export function createRerouteBatcher(run: () => Promise<void>, delayMs = 1500) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let queued = false;

  async function fire(): Promise<void> {
    timer = null;
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    try {
      await run();
    } finally {
      inFlight = false;
      if (queued) {
        queued = false;
        void fire();
      }
    }
  }

  return {
    schedule(): void {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void fire(), delayMs);
    },
    cancel(): void {
      if (timer) clearTimeout(timer);
      timer = null;
      queued = false;
    },
  };
}
