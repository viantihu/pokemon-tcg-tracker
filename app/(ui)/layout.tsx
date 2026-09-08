/**
 * The `(ui)` route-group shell (dev-spec §2). Wraps every product screen (plan, look, line, coll,
 * binders, settings, backfill, sync) in the shared app frame + top nav. Server component; the nav
 * itself is a small client island (`TopBar`) so it can read the active pathname.
 *
 * AUTH GUARD (dev-spec §3 decision 4). Every screen in this group is owner-only. The layout resolves
 * the authenticated user server-side and redirects to /login when there is none — a defence-in-depth
 * backstop to the `proxy.ts` session check, and it also supplies the owner context to client screens
 * via `SessionProvider`. RLS on `auth.uid()` remains the real authorization boundary.
 *
 * Only the plan screen is built in M6; the other route groups are minimal stubs so future phases
 * slot in without reworking this shell.
 */

import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { TopBar } from "./_components/TopBar";
import { SessionProvider } from "./_components/SessionProvider";
import { SignOutButton } from "./_components/SignOutButton";

export default async function UiLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <SessionProvider value={{ userId: user.id, email: user.email ?? null }}>
      <div className="app">
        <TopBar />
        {children}
      </div>
      <SignOutButton email={user.email ?? null} />
    </SessionProvider>
  );
}
