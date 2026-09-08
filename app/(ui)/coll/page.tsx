/**
 * Collections + Wishlist route (scr-coll; dev-spec §5 M8). Thin host: the hub is client-driven via
 * server actions (load / save / log / wishlist export). The Wishlist surface lives here behind a
 * segmented control since the app shell (TopBar) is frozen and adds no wishlist tab.
 */

import { CollHub } from "./CollHub";

export const metadata = { title: "Collections · Binder Ops" };

export default function CollPage() {
  return <CollHub />;
}
