"use client";

/**
 * Owner identity + sign-out affordance for the app shell. Pinned bottom-left so it stays out of the
 * way of the retro top nav (which is a separate, frozen component). Submits the `signOut` server
 * action, which clears the Supabase session and returns to /login.
 *
 * Through `reach` (UIL-106): a Sign out that cannot reach the server says so beside the button instead of
 * throwing to the app's error page. Its SUCCESS is a `redirect("/login")`, which reaches the browser as a
 * rejected promise that `reach` hands back to Next unchanged, so signing out still navigates.
 */

import { useState } from "react";
import { signOut } from "@/app/login/actions";
import { SIGN_OUT_UNREACHED } from "@/app/login/messages";
import { reach } from "./reach";

export function SignOutButton({ email }: { email: string | null }) {
  const [error, setError] = useState<string | null>(null);

  async function signOutOrSay() {
    setError(null);
    const res = await reach(() => signOut(), SIGN_OUT_UNREACHED);
    if (res && "unreached" in res) setError(res.error);
  }

  return (
    <form
      action={signOutOrSay}
      style={{
        position: "fixed",
        left: 14,
        bottom: 14,
        zIndex: 20,
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 8,
        maxWidth: "calc(100vw - 28px)",
      }}
    >
      {error ? (
        <span
          role="alert"
          className="panel"
          // Its own line above the button, so it never pushes Sign out off a phone screen.
          style={{
            flexBasis: "100%",
            maxWidth: 260,
            padding: "6px 8px",
            fontSize: 10,
            background: "#FFD9DF",
          }}
        >
          {error}
        </span>
      ) : null}
      {email ? (
        <span className="tag" title={email}>
          {email}
        </span>
      ) : null}
      <button type="submit" className="btn u" style={{ fontSize: 10 }}>
        Sign out
      </button>
    </form>
  );
}
