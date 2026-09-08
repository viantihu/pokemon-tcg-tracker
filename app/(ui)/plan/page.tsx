/**
 * Haul plan route (scr-plan; dev-spec §5 M6). The screen is fully client-driven via server actions
 * (lookup / run / commit), so the page is a thin host — no request-time data fetch here.
 */

import { PlanScreen } from "./PlanScreen";

export const metadata = { title: "Haul Plan · Binder Ops" };

export default function PlanPage() {
  return <PlanScreen />;
}
