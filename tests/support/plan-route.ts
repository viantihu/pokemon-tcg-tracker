/**
 * A stand-in for `runHaulPlan` in DOM tests (UIL-114): the Haul Plan routes what is waiting as soon as it
 * opens, so a test that mounts the screen needs the route to come back as a plan. Every card goes to the
 * front half of KB-001, which is enough for a screen test; the cascade itself is tested in tests/engine.
 */
import { groupPlan } from "@/lib/plan/group";
import type { PlanItem } from "@/lib/plan";
import type { DraftPayloadItem, RunPlanResult } from "@/app/(ui)/plan/plan-types";

/** The name a test card id carries after its set: `sv09-Toedscool` → `Toedscool`. */
const nameFromId = (tcgdexId: string) => tcgdexId.split("-").slice(1).join("-") || tcgdexId;

export function routedPlan(
  payload: DraftPayloadItem[],
  nameOf: (tcgdexId: string) => string = nameFromId,
  destinationOf: (incomingId: string) => string = () => "KB-001 · Front · Orange",
): RunPlanResult {
  const items: PlanItem[] = payload.map((d) => ({
    incomingId: d.id,
    tcgdexId: d.tcgdexId,
    name: nameOf(d.tcgdexId),
    setId: "sv09",
    localId: "017",
    setCardCountOfficial: 159,
    imageUrl: null,
    variant: d.variant,
    stage: "Basic",
    isBasic: true,
    bandKey: "orange",
    action: "FRONT",
    destination: destinationOf(d.id),
    reason: "Front half.",
    needsDecision: false,
  }));
  const groups = groupPlan(items, ["orange"]);
  return {
    groups,
    bands: groups.map((g) => ({ key: g.bandKey, count: g.count })),
    summary: { total: items.length, decisions: 0, byAction: { FRONT: items.length } },
    orderedBandKeys: ["orange"],
  };
}
