/**
 * Line detail route (scr-line; dev-spec §5 M7). The screen is client-driven via server actions
 * (load / move / resolve), so the page is a thin host — no request-time data fetch here (mirrors
 * the plan route, keeps the build free of DB access).
 */

import { LineScreen } from "./LineScreen";

export const metadata = { title: "Lines · Binder Ops" };

export default function LinePage() {
  return <LineScreen />;
}
