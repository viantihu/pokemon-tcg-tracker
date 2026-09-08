import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { publicEnv } from "@/lib/env";
import type { Database } from "@/lib/repo/database.types";

/**
 * Refresh the Supabase session on every request and gate access to the app (dev-spec §3 decision 4).
 * Called from the root `proxy.ts` (Next 16 renamed `middleware` → `proxy`; Node.js runtime).
 *
 * Follows the @supabase/ssr proxy pattern exactly: build a mutable response, mirror every cookie the
 * client rotates onto both the request (for downstream reads) and the response (for the browser),
 * then `getUser()` to force a token refresh. Returning the SAME `response` object is required — a
 * fresh `NextResponse` would drop the refreshed auth cookies and silently log the user out.
 *
 * Only the anon key is used, so this stays an authenticated, RLS-scoped principal. It is an
 * optimistic gate: the real authorization is RLS + the server-side auth guard in `(ui)/layout.tsx`.
 */

const PUBLIC_PREFIXES = ["/login", "/auth"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  // Do NOT run code between createServerClient and getUser(): it refreshes the token here.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  if (!user && !isPublicPath(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }

  if (user && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/plan";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}
