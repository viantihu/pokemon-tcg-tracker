/**
 * Backfill route (scr backfill wizard; dev-spec §5 M5; system-design §7A). The screen is fully
 * client-driven via server actions (context / lookup / resolve / commit), so the page is a thin
 * host — no request-time data fetch here.
 */

import { BackfillScreen } from "./BackfillScreen";

export const metadata = { title: "Backfill · Binder Ops" };

export default function BackfillPage() {
  return <BackfillScreen />;
}
