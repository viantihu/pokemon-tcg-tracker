/**
 * Collections + Wishlist route (scr-coll; dev-spec §5 M8). Thin host: the hub is client-driven via
 * server actions (load / save / log / wishlist export). The Wishlist surface lives here behind a
 * segmented control since the app shell (TopBar) is frozen and adds no wishlist tab.
 */

import { Suspense } from "react";
import { CollHub } from "./CollHub";

export const metadata = { title: "Collections · Binder Ops" };

export default function CollPage() {
  // CollHub reads `?edit=` (UIL-039's "back to collection" link) via useSearchParams, which Next
  // requires a Suspense boundary around. No fallback UI: CollHub already renders its own "Loading…"
  // stub while `loadCollHub()` resolves, so a second one here would just flash and disappear.
  return (
    <Suspense>
      <CollHub />
    </Suspense>
  );
}
