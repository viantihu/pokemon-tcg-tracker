/**
 * Magic-link callback (dev-spec §3 decision 4). Supabase redirects the clicked link here. With
 * `@supabase/ssr`'s default PKCE flow the link carries a `?code`, which we exchange for a session;
 * a `token_hash`+`type` link (custom email template) is verified as a fallback. Either way the
 * session cookies are written by the SSR server client.
 *
 * Allow-list is re-checked here: even if a session is somehow minted for a different email (e.g. by
 * calling Supabase directly with the public anon key), it is signed out and bounced. RLS is the
 * ultimate backstop — every domain row is keyed to `auth.uid()` — but we refuse the session outright.
 */

import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { isAllowedEmail } from "@/lib/auth/allowlist";

/** Only allow same-origin relative redirect targets (no open redirects). */
function safeNext(raw: string | null): string {
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return "/plan";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const next = safeNext(url.searchParams.get("next"));

  // Redirect base: prefer the forwarded host (Vercel/load balancers) over the internal origin.
  const forwardedHost = request.headers.get("x-forwarded-host");
  const isLocal = process.env.NODE_ENV === "development";
  const base = !isLocal && forwardedHost ? `https://${forwardedHost}` : url.origin;

  const supabase = await createClient();

  let verified = false;
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    verified = !error;
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    verified = !error;
  }

  if (!verified) {
    return NextResponse.redirect(`${base}/login?error=auth`);
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!isAllowedEmail(user?.email)) {
    await supabase.auth.signOut();
    return NextResponse.redirect(`${base}/login?error=forbidden`);
  }

  return NextResponse.redirect(`${base}${next}`);
}
