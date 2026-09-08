/**
 * Root Proxy (dev-spec §3 decision 4). Next.js 16 deprecated `middleware` and renamed it to `proxy`
 * (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md); Proxy defaults
 * to the Node.js runtime, which @supabase/ssr needs, and the `runtime` config option is not allowed
 * here.
 *
 * Refreshes the Supabase session on every matched request and redirects unauthenticated visitors to
 * /login. Delegates the cookie/session mechanics to `lib/supabase/proxy.ts`. This is an optimistic
 * gate only; RLS + the `(ui)` layout guard are the authoritative checks.
 */

import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Run on everything except API routes (they manage their own auth / are public liveness), Next
  // internals, and static asset files. Auth pages (/login, /auth/*) are matched but treated as
  // public inside updateSession so the sign-in and callback flows are reachable while logged out.
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|manifest.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
