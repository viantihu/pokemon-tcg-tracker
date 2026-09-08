"use client";

/**
 * Magic-link sign-in form. A thin client island over the `signIn` server action; the allow-list
 * and the Supabase call live server-side (see ./actions.ts). Uses React 19 `useActionState` so the
 * button shows pending state and inline errors without a client-side fetch.
 */

import { useActionState } from "react";
import { signIn, type SignInState } from "./actions";

const initialState: SignInState = { status: "idle" };

export function LoginForm() {
  const [state, action, pending] = useActionState(signIn, initialState);

  if (state.status === "sent") {
    return (
      <div className="plate" style={{ padding: 16 }}>
        <b className="u" style={{ display: "block", letterSpacing: "0.1em", marginBottom: 8 }}>
          Check your email
        </b>
        <p style={{ fontSize: 12, lineHeight: 1.7 }}>
          A sign-in link is on its way to <strong>{state.email}</strong>. Open it on this device to
          finish signing in. The link expires shortly.
        </p>
      </div>
    );
  }

  return (
    <form action={action} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <label htmlFor="email" className="u" style={{ fontSize: 10, letterSpacing: "0.14em" }}>
        Owner email
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
      <button type="submit" className="btn btn-primary u" disabled={pending}>
        {pending ? "Sending…" : "Send magic link"}
      </button>
    </form>
  );
}
