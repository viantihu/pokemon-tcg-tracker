"use client";

/**
 * Magic-link sign-in form. A thin client island over the `signIn` server action; the allow-list
 * and the Supabase call live server-side (see ./actions.ts). Uses React 19 `useActionState` so the
 * button shows pending state and inline errors without a client-side fetch.
 */

import { useActionState, useEffect } from "react";
import Script from "next/script";
import { reach } from "../(ui)/_components/reach";
import { signIn, type SignInState } from "./actions";
import { SIGN_IN_UNREACHED } from "./messages";

const initialState: SignInState = { status: "idle" };

/**
 * `signIn` through `reach` (UIL-106): a call that cannot reach the server shows her a message on the form,
 * where a refusal already shows, instead of the app's error page. The form data goes through untouched; nothing
 * here reads or holds anything but the result.
 */
async function signInOrSay(prev: SignInState, formData: FormData): Promise<SignInState> {
  const res = await reach(() => signIn(prev, formData), SIGN_IN_UNREACHED);
  return "unreached" in res ? { status: "error", message: res.error } : res;
}

/** Cloudflare Turnstile's browser API, once its script has loaded (only where a site key is set). */
declare global {
  interface Window {
    turnstile?: { reset: (widget?: string) => void };
  }
}

/**
 * `open`: this environment lets any address sign up (UIL-127c), so the words say "sign in or create an account".
 * `siteKey`: Cloudflare Turnstile's public key, set only where open sign-up is protected (the Tech Lead's D1). The
 * widget adds its token to the form as `cf-turnstile-response`, which the action hands to Supabase.
 */
export function LoginForm({ open = false, siteKey = "" }: { open?: boolean; siteKey?: string }) {
  const [state, action, pending] = useActionState(signInOrSay, initialState);

  // A token is single-use: after a refusal, the check resets so she can send again at once.
  useEffect(() => {
    if (siteKey && state.status === "error") window.turnstile?.reset();
  }, [siteKey, state]);

  if (state.status === "sent") {
    return (
      <div className="plate" style={{ padding: 16 }}>
        <b className="u" style={{ display: "block", letterSpacing: "0.1em", marginBottom: 8 }}>
          Check your email
        </b>
        <p style={{ fontSize: 12, lineHeight: 1.7 }}>
          A sign-in link is on its way to <strong>{state.email}</strong>. Open it on the device you
          want to sign in on, in any browser. The link works once and expires shortly.
        </p>
      </div>
    );
  }

  return (
    <form action={action} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <label htmlFor="email" className="u" style={{ fontSize: 10, letterSpacing: "0.14em" }}>
        {open ? "Email" : "Owner email"}
      </label>
      <input
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        required
        placeholder="you@example.com"
        className="field"
      />
      {state.status === "error" ? (
        <p role="alert" style={{ fontSize: 11, color: "var(--ink-3)", letterSpacing: "0.04em" }}>
          {state.message}
        </p>
      ) : null}
      {siteKey ? (
        <>
          <Script
            src="https://challenges.cloudflare.com/turnstile/v0/api.js"
            strategy="afterInteractive"
          />
          <div className="cf-turnstile" data-sitekey={siteKey} data-theme="light" />
        </>
      ) : null}
      <button type="submit" className="btn btn-primary u" disabled={pending}>
        {pending ? "Sending…" : "Send magic link"}
      </button>
    </form>
  );
}
