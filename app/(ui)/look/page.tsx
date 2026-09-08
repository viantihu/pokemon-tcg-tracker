/**
 * Lookup route (scr-look; dev-spec §5 M8). Thin host: the screen is client-driven via server
 * actions (search + answer), so no request-time data fetch here.
 */

import { LookupScreen } from "./LookupScreen";

export const metadata = { title: "Lookup · Binder Ops" };

export default function LookPage() {
  return <LookupScreen />;
}
