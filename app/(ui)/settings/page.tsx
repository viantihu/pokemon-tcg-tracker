/**
 * Settings route (dev-spec §5 M8; system-design §4). Thin host: the screen is client-driven via
 * server actions (load / save binder / reorder bands / remap type→band with recompute).
 */

import { SettingsScreen } from "./SettingsScreen";

export const metadata = { title: "Settings · Binder Ops" };

export default function SettingsPage() {
  return <SettingsScreen />;
}
