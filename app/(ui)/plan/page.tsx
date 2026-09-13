/**
 * Haul plan route (scr-plan; dev-spec §5 M6). The screen is client-driven via server actions
 * (lookup / run / commit); the one thing loaded here is the pending-placement queue (UIL-003), so
 * arriving from Sync's "Place new cards" shows the waiting cards in the first paint instead of an
 * empty form that fills in a moment later. Same host pattern as the sync route.
 */

import { loadPendingPlacementDraft } from "./actions";
import { PlanScreen } from "./PlanScreen";

export const metadata = { title: "Haul Plan · Binder Ops" };
export const dynamic = "force-dynamic";

export default async function PlanPage() {
  const initialPending = await loadPendingPlacementDraft();
  return <PlanScreen initialPending={initialPending} />;
}
