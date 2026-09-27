"use server";

/**
 * Auth server actions (dev-spec §3 decision 4; §7 gate 1; UIL-127c). Magic-link sign-in, plus sign-out. Who may get
 * a link is the environment's call (lib/auth/signup-mode.ts): INVITE mode, only listed addresses; OPEN mode, any
 * address, and the first link to a new one creates its account. Server Actions run only on the server, so the
 * checks and the Supabase call never touch the client.
 *
 * THE ORDER IS PINNED (the Tech Lead's D2; the deploy smoke's two probes): a malformed address is refused first,
 * before any other check or any Supabase call, and a stranger in invite mode next, both in exactly these words.
 * Only then the bot check (open mode, where a Turnstile key is set), then the link.
 */

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { isAllowedEmail } from "@/lib/auth/allowlist";
import { signupMode } from "@/lib/auth/signup-mode";
import { publicEnv } from "@/lib/env";
import { CAPTCHA_NEEDED, RATE_LIMITED } from "./messages";

export type SignInState =
  { status: "idle" } | { status: "error"; message: string } | { status: "sent"; email: string };

const emailSchema = z.object({ email: z.email() });

/** Resolve the public origin of this request (honours Vercel's forwarding headers). */
async function requestOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/**
 * The client that REQUESTS the link, in the IMPLICIT flow (UIL-097).
 *
 * `@supabase/ssr` forces PKCE, which ties the link to the browser that asked for it: the proof is a cookie
 * in that browser, so the link failed when the Gmail app opened it in Chrome. In the implicit flow the
 * request carries no code challenge, and Supabase's verify link redirects with the session in the URL
 * fragment, which any browser can finish (app/auth/confirm). It stores nothing — no session is kept on
 * the server — so it is safe to create per request.
 */
function linkClient() {
  return createSupabaseClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey, {
    auth: {
      flowType: "implicit",
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

/**
 * Send a Supabase magic link to an address that may sign in here. `useActionState` form action: takes the previous
 * state + the submitted form and returns the next state. The same "check your email" answer comes back for a new
 * address and a known one, so the form never says who has an account.
 */
export async function signIn(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const parsed = emailSchema.safeParse({ email: String(formData.get("email") ?? "").trim() });
  if (!parsed.success) {
    return { status: "error", message: "Enter a valid email address." };
  }
  const email = parsed.data.email;

  // Primary gate: never send a link to an address that may not sign in here (invite mode: not on the list).
  if (!isAllowedEmail(email)) {
    return { status: "error", message: "That email is not authorised for this binder." };
  }

  // The bot check (the Tech Lead's D1): in open mode, where the Turnstile widget is shown, its token must come with
  // the form, and Supabase Auth's CAPTCHA verifies it. Refused here in her words rather than as Supabase's error.
  const captchaToken = String(formData.get("cf-turnstile-response") ?? "").trim() || undefined;
  if (signupMode() === "open" && publicEnv.turnstileSiteKey && !captchaToken) {
    return { status: "error", message: CAPTCHA_NEEDED };
  }

  const origin = await requestOrigin();
  const { error } = await linkClient().auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${origin}/auth/confirm`,
      shouldCreateUser: true,
      captchaToken,
    },
  });

  if (error) {
    if (error.status === 429 || error.code === "over_email_send_rate_limit") {
      return { status: "error", message: RATE_LIMITED };
    }
    if (error.code === "captcha_failed" || /captcha/i.test(error.message ?? "")) {
      return { status: "error", message: CAPTCHA_NEEDED };
    }
    return { status: "error", message: error.message };
  }
  return { status: "sent", email };
}

/** Sign out and return to the login screen. Usable directly as a `<form action={signOut}>`. */
export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
