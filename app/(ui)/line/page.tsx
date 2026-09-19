/**
 * Line detail route (scr-line; dev-spec §5 M7). The screen is client-driven via server actions
 * (load / move / resolve), so the page is a thin host — no request-time data fetch here (mirrors
 * the plan route, keeps the build free of DB access).
 */

import { Suspense } from "react";
import { LineScreen } from "./LineScreen";

export const metadata = { title: "Lines · Binder Ops" };

export default function LinePage() {
  // LineScreen reads `?view=` (UIL-074's strip order) via useSearchParams, which Next requires a
  // Suspense boundary around. No fallback UI: LineScreen renders its own "Loading lines…" stub while
  // `loadLine()` resolves, so a second one here would just flash and disappear (same as coll/page).
  return (
    <Suspense>
      <LineScreen />
    </Suspense>
  );
}
