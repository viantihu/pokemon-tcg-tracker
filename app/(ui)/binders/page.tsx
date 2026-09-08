/**
 * Binders & Capacity route (dev-spec §5 M8; system-design §7E). Thin host: the screen is
 * client-driven via a server action reading the `binder_section` view.
 */

import { CapacityScreen } from "./CapacityScreen";

export const metadata = { title: "Binders · Binder Ops" };

export default function BindersPage() {
  return <CapacityScreen />;
}
