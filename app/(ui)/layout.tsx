/**
 * The `(ui)` route-group shell (dev-spec §2). Wraps every product screen (plan, look, line, coll,
 * binders, settings, backfill, sync) in the shared app frame + top nav. Server component; the nav
 * itself is a small client island (`TopBar`) so it can read the active pathname.
 *
 * Only the plan screen is built in M6; the other route groups are minimal stubs so future phases
 * slot in without reworking this shell.
 */

import type { ReactNode } from "react";
import { TopBar } from "./_components/TopBar";

export default function UiLayout({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <TopBar />
      {children}
    </div>
  );
}
