/**
 * Haul plan route (scr-plan; dev-spec §5 M6). The screen is client-driven via server actions
 * (lookup / run / commit); loaded here are the pending-placement queue (UIL-003), so arriving from
 * Sync's "Place new cards" shows the waiting cards in the first paint instead of an empty form, and
 * the state stamp the screen uses to decide whether a cached plan is still valid (UIL-006).
 * Same host pattern as the sync route.
 */

import { loadPendingPlacementDraft, planStateStamp } from "./actions";
import { PlanScreen } from "./PlanScreen";

export const metadata = { title: "Haul Plan · Binder Ops" };
export const dynamic = "force-dynamic";

export default async function PlanPage() {
  const initialPending = await loadPendingPlacementDraft();
  const stamp = await planStateStamp(initialPending.map((d) => d.id));
  return <PlanScreen initialPending={initialPending} stateStamp={stamp} />;
}
